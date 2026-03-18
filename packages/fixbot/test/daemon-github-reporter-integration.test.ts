import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { getArtifactPaths } from "../src/artifacts";
import { normalizeJobSpec } from "../src/contracts";
import { enqueueDaemonJob } from "../src/daemon/job-store";
import { readDaemonStatusFile } from "../src/daemon/status-store";
import {
	DAEMON_JOB_ENVELOPE_VERSION_V1,
	type DaemonJobEnvelopeV1,
	type DaemonJobRunner,
	type GitHubPollerFn,
	type GitHubReporterFn,
	JOB_SPEC_VERSION_V1,
	type JobResultV1,
	loadDaemonConfig,
	type NormalizedDaemonConfigV1,
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
	github: { repos: Array<{ url: string; baseBranch: string; triggerLabel: string }>; pollIntervalMs: number };
}): string {
	const directory = mkdtempSync(join(tmpdir(), "fixbot-reporter-int-"));
	temporaryDirectories.push(directory);
	const configPath = join(directory, "daemon.config.json");
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
				github: options.github,
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
		await new Promise((resolve) => setTimeout(resolve, 25));
		lastValue = await callback();
	}
	return lastValue;
}

function buildCannedJobResult(
	jobSpec: ReturnType<typeof normalizeJobSpec>,
	resultsDir: string,
	overrides: { status: "success" | "failed"; changedFileCount: number; failureReason?: string },
): JobResultV1 {
	const artifactPaths = getArtifactPaths(resultsDir, jobSpec.jobId);
	return {
		version: "fixbot.result/v1" as const,
		jobId: jobSpec.jobId,
		taskClass: jobSpec.taskClass,
		status: overrides.status,
		summary:
			overrides.status === "success" ? "Reporter integration test success" : "Reporter integration test failure",
		failureReason: overrides.failureReason,
		repo: jobSpec.repo,
		fixCi: jobSpec.fixCi,
		execution: {
			mode: jobSpec.execution.mode,
			timeoutMs: jobSpec.execution.timeoutMs,
			memoryLimitMb: jobSpec.execution.memoryLimitMb,
			sandbox: jobSpec.execution.sandbox,
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
			changedFileCount: overrides.changedFileCount,
			markers: { result: true, summary: true, failureReason: overrides.status === "failed" },
		},
	};
}

interface ReporterCallRecord {
	envelope: DaemonJobEnvelopeV1;
	result: JobResultV1;
	config: NormalizedDaemonConfigV1;
}

function createPollerThatEnqueuesOnce(jobId: string): GitHubPollerFn {
	let pollCount = 0;
	return async (cfg) => {
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
				"reporter-integration-test",
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
}

async function startForegroundDaemonWithReporter(
	configPath: string,
	jobRunner: DaemonJobRunner,
	githubPoller: GitHubPollerFn,
	githubReporter: GitHubReporterFn,
): Promise<{ config: NormalizedDaemonConfigV1; stop: () => Promise<void> }> {
	const config = loadDaemonConfig(configPath);
	const controller = new AbortController();
	const daemonRun = runDaemon(config, {
		signal: controller.signal,
		installSignalHandlers: false,
		jobRunner,
		githubPoller,
		githubReporter,
	});
	const stop = async () => {
		controller.abort();
		await daemonRun;
	};
	foregroundDaemonStops.push(stop);

	const readyStatus = await waitFor(
		() => readDaemonStatusFile(config),
		(status) => status?.state === "idle" && status.pid === process.pid,
		5_000,
	);
	expect(readyStatus?.state).toBe("idle");

	return { config, stop };
}

describe("daemon GitHub reporter integration", () => {
	it("reporter is called with correct args after successful job", async () => {
		const configPath = createTempConfigWithGitHub({
			runtime: { heartbeatIntervalMs: 200, idleSleepMs: 20 },
			github: {
				repos: [{ url: "https://github.com/test/repo", baseBranch: "main", triggerLabel: "fixbot" }],
				pollIntervalMs: 50,
			},
		});

		const jobId = "reporter-success-001";
		const reporterCalls: ReporterCallRecord[] = [];

		const mockReporter: GitHubReporterFn = async (envelope, result, config) => {
			reporterCalls.push({ envelope, result, config });
		};

		const jobRunner: DaemonJobRunner = async (job, options) => {
			return buildCannedJobResult(job, options.resultsDir, { status: "success", changedFileCount: 2 });
		};

		const githubPoller = createPollerThatEnqueuesOnce(jobId);

		const daemon = await startForegroundDaemonWithReporter(configPath, jobRunner, githubPoller, mockReporter);

		await waitFor(
			() => readDaemonStatusFile(daemon.config),
			(status) => status?.state === "idle" && status.recentResults[0]?.jobId === jobId,
			15_000,
		);

		expect(reporterCalls).toHaveLength(1);
		expect(reporterCalls[0].envelope.jobId).toBe(jobId);
		expect(reporterCalls[0].envelope.submission.kind).toBe("github-label");
		expect(reporterCalls[0].envelope.submission.githubRepo).toBe("test/repo");
		expect(reporterCalls[0].result.status).toBe("success");
		expect(reporterCalls[0].result.diagnostics.changedFileCount).toBe(2);
		expect(reporterCalls[0].config.github).toBeDefined();

		await daemon.stop();
	});

	it("reporter is called for failed job result", async () => {
		const configPath = createTempConfigWithGitHub({
			runtime: { heartbeatIntervalMs: 200, idleSleepMs: 20 },
			github: {
				repos: [{ url: "https://github.com/test/repo", baseBranch: "main", triggerLabel: "fixbot" }],
				pollIntervalMs: 50,
			},
		});

		const jobId = "reporter-failure-001";
		const reporterCalls: ReporterCallRecord[] = [];

		const mockReporter: GitHubReporterFn = async (envelope, result, config) => {
			reporterCalls.push({ envelope, result, config });
		};

		const jobRunner: DaemonJobRunner = async (job, options) => {
			return buildCannedJobResult(job, options.resultsDir, {
				status: "failed",
				changedFileCount: 0,
				failureReason: "simulated executor failure",
			});
		};

		const githubPoller = createPollerThatEnqueuesOnce(jobId);

		const daemon = await startForegroundDaemonWithReporter(configPath, jobRunner, githubPoller, mockReporter);

		await waitFor(
			() => readDaemonStatusFile(daemon.config),
			(status) => status?.state === "idle" && status.recentResults[0]?.jobId === jobId,
			15_000,
		);

		expect(reporterCalls).toHaveLength(1);
		expect(reporterCalls[0].envelope.jobId).toBe(jobId);
		expect(reporterCalls[0].result.status).toBe("failed");
		expect(reporterCalls[0].result.failureReason).toBe("simulated executor failure");

		await daemon.stop();
	});

	it("reporter error does not crash daemon", async () => {
		const configPath = createTempConfigWithGitHub({
			runtime: { heartbeatIntervalMs: 200, idleSleepMs: 20 },
			github: {
				repos: [{ url: "https://github.com/test/repo", baseBranch: "main", triggerLabel: "fixbot" }],
				pollIntervalMs: 50,
			},
		});

		const jobId = "reporter-crash-001";

		const throwingReporter: GitHubReporterFn = async () => {
			throw new Error("simulated reporter crash");
		};

		const jobRunner: DaemonJobRunner = async (job, options) => {
			return buildCannedJobResult(job, options.resultsDir, { status: "success", changedFileCount: 1 });
		};

		const githubPoller = createPollerThatEnqueuesOnce(jobId);

		const daemon = await startForegroundDaemonWithReporter(configPath, jobRunner, githubPoller, throwingReporter);

		const completedStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			(status) => status?.state === "idle" && status.recentResults[0]?.jobId === jobId,
			15_000,
		);

		// Daemon survived the reporter crash and recorded the result correctly.
		expect(completedStatus).not.toBeNull();
		expect(completedStatus?.state).toBe("idle");
		expect(completedStatus?.recentResults[0]?.jobId).toBe(jobId);
		expect(completedStatus?.recentResults[0]?.status).toBe("success");

		await daemon.stop();
	});
});
