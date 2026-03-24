import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArtifactPaths } from "../src/artifacts";
import { normalizeJobSpec } from "../src/contracts";
import { enqueueDaemonJob } from "../src/daemon/job-store";
import { readDaemonStatusFile } from "../src/daemon/status-store";
import {
	DAEMON_JOB_ENVELOPE_VERSION_V1,
	type DaemonJobRunner,
	type GitHubPollerFn,
	type GitHubReporterFn,
	JOB_SPEC_VERSION_V1,
	type JobResultV1,
	loadDaemonConfig,
	type NormalizedDaemonConfigV1,
	type RunDaemonOptions,
	runDaemon,
} from "../src/index";

const temporaryDirectories: string[] = [];
const foregroundDaemonStops: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const stop of foregroundDaemonStops.splice(0)) {
		try {
			await stop();
		} catch {
			// Best-effort cleanup.
		}
	}
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempConfigWithGitHub(options: {
	runtime: { heartbeatIntervalMs: number; idleSleepMs: number };
	github: {
		repos: Array<{ url: string; baseBranch: string; triggerLabel: string }>;
		pollIntervalMs: number;
		appAuth?: { appId: number; privateKeyPath: string; installationId: number };
	};
}): string {
	const directory = mkdtempSync(join(tmpdir(), "fixbot-gh-int-"));
	temporaryDirectories.push(directory);
	const configPath = join(directory, "daemon.config.json");
	const githubConfig: Record<string, unknown> = {
		repos: options.github.repos,
		pollIntervalMs: options.github.pollIntervalMs,
	};
	if (options.github.appAuth) {
		githubConfig.appAuth = options.github.appAuth;
	}
	writeFileSync(
		configPath,
		`${JSON.stringify(
			{
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./state",
					resultsDir: "./results",
				},
				runtime: options.runtime,
				github: githubConfig,
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	return configPath;
}

async function waitFor<T>(
	callback: () => T | Promise<T>,
	predicate: (value: T) => boolean,
	timeoutMs: number,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastValue = await callback();
	while (Date.now() < deadline) {
		if (predicate(lastValue)) {
			return lastValue;
		}
		await new Promise(resolve => setTimeout(resolve, 25));
		lastValue = await callback();
	}
	return lastValue;
}

async function startForegroundDaemonWithGitHub(
	configPath: string,
	jobRunner: DaemonJobRunner,
	githubPoller: GitHubPollerFn,
	extraOptions?: Partial<RunDaemonOptions>,
): Promise<{ config: NormalizedDaemonConfigV1; stop: () => Promise<void> }> {
	const config = loadDaemonConfig(configPath);
	const controller = new AbortController();
	const daemonRun = runDaemon(config, {
		signal: controller.signal,
		installSignalHandlers: false,
		jobRunner,
		githubPoller,
		...extraOptions,
	});
	const stop = async () => {
		controller.abort();
		await daemonRun;
	};
	foregroundDaemonStops.push(stop);

	const readyStatus = await waitFor(
		() => readDaemonStatusFile(config),
		status => status?.state === "idle" && status.pid === process.pid,
		5_000,
	);
	expect(readyStatus?.state).toBe("idle");

	return { config, stop };
}

describe("daemon GitHub poller integration", () => {
	it("GitHub-triggered job runs through daemon and appears in recentResults", async () => {
		const configPath = createTempConfigWithGitHub({
			runtime: { heartbeatIntervalMs: 200, idleSleepMs: 20 },
			github: {
				repos: [{ url: "https://github.com/test/repo", baseBranch: "main", triggerLabel: "fixbot" }],
				pollIntervalMs: 50,
			},
		});

		const jobId = "gh-integration-test-001";
		let pollCount = 0;

		// Poller that enqueues one job on first call, then returns empty on subsequent calls.
		const githubPoller: GitHubPollerFn = async cfg => {
			pollCount++;
			if (pollCount === 1) {
				const jobSpec = normalizeJobSpec(
					{
						version: JOB_SPEC_VERSION_V1,
						jobId,
						taskClass: "fix_ci",
						repo: { url: "https://github.com/test/repo", baseBranch: "main" },
						fixCi: { githubActionsRunId: 99001 },
						execution: { mode: "process", timeoutMs: 300_000, memoryLimitMb: 4096 },
					},
					"github-integration-test",
				);
				const artifactPaths = getArtifactPaths(cfg.paths.resultsDir, jobId);
				enqueueDaemonJob(cfg, {
					version: DAEMON_JOB_ENVELOPE_VERSION_V1,
					jobId,
					job: jobSpec,
					submission: {
						kind: "github-label",
						githubRepo: "test/repo",
						githubIssueNumber: 42,
						githubLabelName: "fixbot",
						githubActionsRunId: 99001,
					},
					enqueuedAt: new Date().toISOString(),
					artifacts: {
						artifactDir: artifactPaths.artifactDir,
						resultFile: artifactPaths.resultFile,
					},
				});
				return { enqueued: [jobId], skipped: 0, errors: 0 };
			}
			return { enqueued: [], skipped: 0, errors: 0 };
		};

		// Job runner that returns a canned success result without needing a real repo or model.
		const jobRunner: DaemonJobRunner = async (job, options) => {
			const artifactPaths = getArtifactPaths(options.resultsDir, job.jobId);
			const result: JobResultV1 = {
				version: "fixbot.result/v1" as const,
				jobId: job.jobId,
				taskClass: job.taskClass,
				status: "success",
				summary: "GitHub integration test passed",
				repo: job.repo,
				fixCi: job.fixCi,
				execution: {
					mode: job.execution.mode,
					timeoutMs: job.execution.timeoutMs,
					memoryLimitMb: job.execution.memoryLimitMb,
					sandbox: job.execution.sandbox,
					workspaceDir: artifactPaths.workspaceDir,
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					durationMs: 10,
				},
				artifacts: {
					resultFile: artifactPaths.resultFile,
					rootDir: artifactPaths.artifactDir,
					jobSpecFile: artifactPaths.jobSpecFile,
					patchFile: artifactPaths.patchFile,
					traceFile: artifactPaths.traceFile,
					assistantFinalFile: artifactPaths.assistantFinalFile,
				},
				diagnostics: {
					patchSha256: "0000000000000000000000000000000000000000000000000000000000000000",
					changedFileCount: 0,
					markers: { result: true, summary: true, failureReason: false },
				},
			};
			return result;
		};

		const daemon = await startForegroundDaemonWithGitHub(configPath, jobRunner, githubPoller);

		const completedStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			status => status?.state === "idle" && status.activeJob === null && status.recentResults[0]?.jobId === jobId,
			15_000,
		);

		expect(completedStatus).not.toBeNull();
		expect(completedStatus?.recentResults[0]?.jobId).toBe(jobId);
		expect(completedStatus?.recentResults[0]?.status).toBe("success");
		expect(completedStatus?.recentResults[0]?.submission?.kind).toBe("github-label");
		expect(completedStatus?.recentResults[0]?.submission?.githubRepo).toBe("test/repo");
		expect(completedStatus?.recentResults[0]?.submission?.githubIssueNumber).toBe(42);
		expect(completedStatus?.recentResults[0]?.submission?.githubActionsRunId).toBe(99001);
		expect(pollCount).toBeGreaterThanOrEqual(1);
	});

	it("poller error does not crash daemon and surfaces in lastError", async () => {
		const configPath = createTempConfigWithGitHub({
			runtime: { heartbeatIntervalMs: 200, idleSleepMs: 20 },
			github: {
				repos: [{ url: "https://github.com/test/repo", baseBranch: "main", triggerLabel: "fixbot" }],
				pollIntervalMs: 50,
			},
		});

		let pollCount = 0;
		const githubPoller: GitHubPollerFn = async () => {
			pollCount++;
			throw new Error("simulated-github-api-failure");
		};

		// Job runner should never be called when only poller errors occur.
		const jobRunner: DaemonJobRunner = async () => {
			throw new Error("jobRunner should not be called");
		};

		const daemon = await startForegroundDaemonWithGitHub(configPath, jobRunner, githubPoller);

		// Wait for a few poll cycles so the error is recorded.
		const statusWithError = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			status => status?.lastError?.code === "GITHUB_POLL_ERROR" && pollCount >= 2,
			10_000,
		);

		expect(statusWithError).not.toBeNull();
		expect(statusWithError?.state).toBe("idle");
		expect(statusWithError?.lastError?.code).toBe("GITHUB_POLL_ERROR");
		expect(statusWithError?.lastError?.message).toContain("simulated-github-api-failure");
		expect(pollCount).toBeGreaterThanOrEqual(2);
	});

	it("fix_lint job runs through daemon and appears in recentResults with correct taskClass", async () => {
		const configPath = createTempConfigWithGitHub({
			runtime: { heartbeatIntervalMs: 200, idleSleepMs: 20 },
			github: {
				repos: [{ url: "https://github.com/test/repo", baseBranch: "main", triggerLabel: "fixbot" }],
				pollIntervalMs: 50,
			},
		});

		const jobId = "gh-lint-integration-001";
		let pollCount = 0;

		const githubPoller: GitHubPollerFn = async cfg => {
			pollCount++;
			if (pollCount === 1) {
				const jobSpec = normalizeJobSpec(
					{
						version: JOB_SPEC_VERSION_V1,
						jobId,
						taskClass: "fix_lint",
						repo: { url: "https://github.com/test/repo", baseBranch: "main" },
						execution: { mode: "process", timeoutMs: 300_000, memoryLimitMb: 4096 },
					},
					"github-lint-integration-test",
				);
				const artifactPaths = getArtifactPaths(cfg.paths.resultsDir, jobId);
				enqueueDaemonJob(cfg, {
					version: DAEMON_JOB_ENVELOPE_VERSION_V1,
					jobId,
					job: jobSpec,
					submission: {
						kind: "github-label",
						githubRepo: "test/repo",
						githubIssueNumber: 55,
						githubLabelName: "fixbot:lint",
					},
					enqueuedAt: new Date().toISOString(),
					artifacts: {
						artifactDir: artifactPaths.artifactDir,
						resultFile: artifactPaths.resultFile,
					},
				});
				return { enqueued: [jobId], skipped: 0, errors: 0 };
			}
			return { enqueued: [], skipped: 0, errors: 0 };
		};

		const jobRunner: DaemonJobRunner = async (job, options) => {
			const artifactPaths = getArtifactPaths(options.resultsDir, job.jobId);
			const result: JobResultV1 = {
				version: "fixbot.result/v1" as const,
				jobId: job.jobId,
				taskClass: job.taskClass,
				status: "success",
				summary: "Lint issues fixed",
				repo: job.repo,
				fixLint: job.fixLint,
				execution: {
					mode: job.execution.mode,
					timeoutMs: job.execution.timeoutMs,
					memoryLimitMb: job.execution.memoryLimitMb,
					sandbox: job.execution.sandbox,
					workspaceDir: artifactPaths.workspaceDir,
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					durationMs: 10,
				},
				artifacts: {
					resultFile: artifactPaths.resultFile,
					rootDir: artifactPaths.artifactDir,
					jobSpecFile: artifactPaths.jobSpecFile,
					patchFile: artifactPaths.patchFile,
					traceFile: artifactPaths.traceFile,
					assistantFinalFile: artifactPaths.assistantFinalFile,
				},
				diagnostics: {
					patchSha256: "0000000000000000000000000000000000000000000000000000000000000000",
					changedFileCount: 0,
					markers: { result: true, summary: true, failureReason: false },
				},
			};
			return result;
		};

		const daemon = await startForegroundDaemonWithGitHub(configPath, jobRunner, githubPoller);

		const completedStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			status => status?.state === "idle" && status.activeJob === null && status.recentResults[0]?.jobId === jobId,
			15_000,
		);

		expect(completedStatus).not.toBeNull();
		expect(completedStatus?.recentResults[0]?.jobId).toBe(jobId);
		expect(completedStatus?.recentResults[0]?.status).toBe("success");
		expect(completedStatus?.recentResults[0]?.submission?.kind).toBe("github-label");
		expect(completedStatus?.recentResults[0]?.submission?.githubRepo).toBe("test/repo");
		expect(completedStatus?.recentResults[0]?.submission?.githubIssueNumber).toBe(55);
		expect(completedStatus?.recentResults[0]?.submission?.githubActionsRunId).toBeUndefined();
		expect(pollCount).toBeGreaterThanOrEqual(1);
	});

	it("solve_issue job runs through daemon and appears in recentResults with correct taskClass", async () => {
		const configPath = createTempConfigWithGitHub({
			runtime: { heartbeatIntervalMs: 200, idleSleepMs: 20 },
			github: {
				repos: [{ url: "https://github.com/test/repo", baseBranch: "main", triggerLabel: "fixbot" }],
				pollIntervalMs: 50,
			},
		});

		const jobId = "gh-solve-integration-001";
		let pollCount = 0;

		const githubPoller: GitHubPollerFn = async cfg => {
			pollCount++;
			if (pollCount === 1) {
				const jobSpec = normalizeJobSpec(
					{
						version: JOB_SPEC_VERSION_V1,
						jobId,
						taskClass: "solve_issue",
						repo: { url: "https://github.com/test/repo", baseBranch: "main" },
						solveIssue: { issueNumber: 77 },
						execution: { mode: "process", timeoutMs: 300_000, memoryLimitMb: 4096 },
					},
					"github-solve-integration-test",
				);
				const artifactPaths = getArtifactPaths(cfg.paths.resultsDir, jobId);
				enqueueDaemonJob(cfg, {
					version: DAEMON_JOB_ENVELOPE_VERSION_V1,
					jobId,
					job: jobSpec,
					submission: {
						kind: "github-label",
						githubRepo: "test/repo",
						githubIssueNumber: 77,
						githubLabelName: "fixbot",
					},
					enqueuedAt: new Date().toISOString(),
					artifacts: {
						artifactDir: artifactPaths.artifactDir,
						resultFile: artifactPaths.resultFile,
					},
				});
				return { enqueued: [jobId], skipped: 0, errors: 0 };
			}
			return { enqueued: [], skipped: 0, errors: 0 };
		};

		const jobRunner: DaemonJobRunner = async (job, options) => {
			const artifactPaths = getArtifactPaths(options.resultsDir, job.jobId);
			const result: JobResultV1 = {
				version: "fixbot.result/v1" as const,
				jobId: job.jobId,
				taskClass: job.taskClass,
				status: "success",
				summary: "Solve issue integration test passed",
				repo: job.repo,
				solveIssue: job.solveIssue,
				execution: {
					mode: job.execution.mode,
					timeoutMs: job.execution.timeoutMs,
					memoryLimitMb: job.execution.memoryLimitMb,
					sandbox: job.execution.sandbox,
					workspaceDir: artifactPaths.workspaceDir,
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					durationMs: 10,
				},
				artifacts: {
					resultFile: artifactPaths.resultFile,
					rootDir: artifactPaths.artifactDir,
					jobSpecFile: artifactPaths.jobSpecFile,
					patchFile: artifactPaths.patchFile,
					traceFile: artifactPaths.traceFile,
					assistantFinalFile: artifactPaths.assistantFinalFile,
				},
				diagnostics: {
					patchSha256: "0000000000000000000000000000000000000000000000000000000000000000",
					changedFileCount: 0,
					markers: { result: true, summary: true, failureReason: false },
				},
			};
			return result;
		};

		const daemon = await startForegroundDaemonWithGitHub(configPath, jobRunner, githubPoller);

		const completedStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			status => status?.state === "idle" && status.activeJob === null && status.recentResults[0]?.jobId === jobId,
			15_000,
		);

		expect(completedStatus).not.toBeNull();
		expect(completedStatus?.recentResults[0]?.jobId).toBe(jobId);
		expect(completedStatus?.recentResults[0]?.status).toBe("success");
		expect(completedStatus?.recentResults[0]?.submission?.kind).toBe("github-label");
		expect(completedStatus?.recentResults[0]?.submission?.githubIssueNumber).toBe(77);
		expect(pollCount).toBeGreaterThanOrEqual(1);
	});

	it("fix_cve job runs through daemon and appears in recentResults with correct taskClass", async () => {
		const configPath = createTempConfigWithGitHub({
			runtime: { heartbeatIntervalMs: 200, idleSleepMs: 20 },
			github: {
				repos: [{ url: "https://github.com/test/repo", baseBranch: "main", triggerLabel: "fixbot" }],
				pollIntervalMs: 50,
			},
		});

		const jobId = "gh-cve-integration-001";
		let pollCount = 0;

		const githubPoller: GitHubPollerFn = async cfg => {
			pollCount++;
			if (pollCount === 1) {
				const jobSpec = normalizeJobSpec(
					{
						version: JOB_SPEC_VERSION_V1,
						jobId,
						taskClass: "fix_cve",
						repo: { url: "https://github.com/test/repo", baseBranch: "main" },
						fixCve: { cveId: "CVE-2024-0001" },
						execution: { mode: "process", timeoutMs: 300_000, memoryLimitMb: 4096 },
					},
					"github-cve-integration-test",
				);
				const artifactPaths = getArtifactPaths(cfg.paths.resultsDir, jobId);
				enqueueDaemonJob(cfg, {
					version: DAEMON_JOB_ENVELOPE_VERSION_V1,
					jobId,
					job: jobSpec,
					submission: {
						kind: "github-label",
						githubRepo: "test/repo",
						githubIssueNumber: 88,
						githubLabelName: "fixbot",
					},
					enqueuedAt: new Date().toISOString(),
					artifacts: {
						artifactDir: artifactPaths.artifactDir,
						resultFile: artifactPaths.resultFile,
					},
				});
				return { enqueued: [jobId], skipped: 0, errors: 0 };
			}
			return { enqueued: [], skipped: 0, errors: 0 };
		};

		const jobRunner: DaemonJobRunner = async (job, options) => {
			const artifactPaths = getArtifactPaths(options.resultsDir, job.jobId);
			const result: JobResultV1 = {
				version: "fixbot.result/v1" as const,
				jobId: job.jobId,
				taskClass: job.taskClass,
				status: "success",
				summary: "CVE integration test passed",
				repo: job.repo,
				fixCve: job.fixCve,
				execution: {
					mode: job.execution.mode,
					timeoutMs: job.execution.timeoutMs,
					memoryLimitMb: job.execution.memoryLimitMb,
					sandbox: job.execution.sandbox,
					workspaceDir: artifactPaths.workspaceDir,
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					durationMs: 10,
				},
				artifacts: {
					resultFile: artifactPaths.resultFile,
					rootDir: artifactPaths.artifactDir,
					jobSpecFile: artifactPaths.jobSpecFile,
					patchFile: artifactPaths.patchFile,
					traceFile: artifactPaths.traceFile,
					assistantFinalFile: artifactPaths.assistantFinalFile,
				},
				diagnostics: {
					patchSha256: "0000000000000000000000000000000000000000000000000000000000000000",
					changedFileCount: 0,
					markers: { result: true, summary: true, failureReason: false },
				},
			};
			return result;
		};

		const daemon = await startForegroundDaemonWithGitHub(configPath, jobRunner, githubPoller);

		const completedStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			status => status?.state === "idle" && status.activeJob === null && status.recentResults[0]?.jobId === jobId,
			15_000,
		);

		expect(completedStatus).not.toBeNull();
		expect(completedStatus?.recentResults[0]?.jobId).toBe(jobId);
		expect(completedStatus?.recentResults[0]?.status).toBe("success");
		expect(completedStatus?.recentResults[0]?.submission?.kind).toBe("github-label");
		expect(completedStatus?.recentResults[0]?.submission?.githubIssueNumber).toBe(88);
		expect(pollCount).toBeGreaterThanOrEqual(1);
	});

	it("daemon with tokenProvider resolves installation token for poller and reporter", async () => {
		const configPath = createTempConfigWithGitHub({
			runtime: { heartbeatIntervalMs: 200, idleSleepMs: 20 },
			github: {
				repos: [{ url: "https://github.com/test/repo", baseBranch: "main", triggerLabel: "fixbot" }],
				pollIntervalMs: 50,
				appAuth: { appId: 12345, privateKeyPath: "/fake/key.pem", installationId: 67890 },
			},
		});

		const jobId = "gh-app-auth-integration-001";
		let pollCount = 0;
		let reporterReceivedToken: string | undefined;

		const githubPoller: GitHubPollerFn = async cfg => {
			pollCount++;
			if (pollCount === 1) {
				const jobSpec = normalizeJobSpec(
					{
						version: JOB_SPEC_VERSION_V1,
						jobId,
						taskClass: "fix_ci",
						repo: { url: "https://github.com/test/repo", baseBranch: "main" },
						fixCi: { githubActionsRunId: 99099 },
						execution: { mode: "process", timeoutMs: 300_000, memoryLimitMb: 4096 },
					},
					"github-app-auth-integration-test",
				);
				const artifactPaths = getArtifactPaths(cfg.paths.resultsDir, jobId);
				enqueueDaemonJob(cfg, {
					version: DAEMON_JOB_ENVELOPE_VERSION_V1,
					jobId,
					job: jobSpec,
					submission: {
						kind: "github-label",
						githubRepo: "test/repo",
						githubIssueNumber: 100,
						githubLabelName: "fixbot",
						githubActionsRunId: 99099,
					},
					enqueuedAt: new Date().toISOString(),
					artifacts: {
						artifactDir: artifactPaths.artifactDir,
						resultFile: artifactPaths.resultFile,
					},
				});
				return { enqueued: [jobId], skipped: 0, errors: 0 };
			}
			return { enqueued: [], skipped: 0, errors: 0 };
		};

		const jobRunner: DaemonJobRunner = async (job, options) => {
			const artifactPaths = getArtifactPaths(options.resultsDir, job.jobId);
			const result: JobResultV1 = {
				version: "fixbot.result/v1" as const,
				jobId: job.jobId,
				taskClass: job.taskClass,
				status: "success",
				summary: "App auth integration test passed",
				repo: job.repo,
				fixCi: job.fixCi,
				execution: {
					mode: job.execution.mode,
					timeoutMs: job.execution.timeoutMs,
					memoryLimitMb: job.execution.memoryLimitMb,
					sandbox: job.execution.sandbox,
					workspaceDir: artifactPaths.workspaceDir,
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					durationMs: 10,
				},
				artifacts: {
					resultFile: artifactPaths.resultFile,
					rootDir: artifactPaths.artifactDir,
					jobSpecFile: artifactPaths.jobSpecFile,
					patchFile: artifactPaths.patchFile,
					traceFile: artifactPaths.traceFile,
					assistantFinalFile: artifactPaths.assistantFinalFile,
				},
				diagnostics: {
					patchSha256: "0000000000000000000000000000000000000000000000000000000000000000",
					changedFileCount: 0,
					markers: { result: true, summary: true, failureReason: false },
				},
			};
			return result;
		};

		// Reporter that captures the token from config at call time.
		const githubReporter: GitHubReporterFn = async (_envelope, _result, cfg) => {
			reporterReceivedToken = cfg.github?.token;
		};

		const daemon = await startForegroundDaemonWithGitHub(configPath, jobRunner, githubPoller, {
			tokenProvider: async () => "test-installation-token",
			githubReporter,
		});

		const completedStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			status => status?.state === "idle" && status.activeJob === null && status.recentResults[0]?.jobId === jobId,
			15_000,
		);

		expect(completedStatus).not.toBeNull();
		expect(completedStatus?.recentResults[0]?.jobId).toBe(jobId);
		expect(completedStatus?.recentResults[0]?.status).toBe("success");
		expect(reporterReceivedToken).toBe("test-installation-token");
		expect(pollCount).toBeGreaterThanOrEqual(1);
	});
});
