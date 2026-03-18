import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getModels } from "@oh-my-pi/pi-ai";
import { afterEach, describe, expect, it } from "bun:test";
import { getArtifactPaths } from "../src/artifacts";
import { createDaemonJobEnvelope } from "../src/daemon/enqueue";
import { enqueueDaemonJob } from "../src/daemon/job-store";
import { readDaemonStatusFile } from "../src/daemon/status-store";
import type { PreparedJobContext, PreparedJobExecutor } from "../src/execution";
import {
	type DaemonJobRunner,
	JOB_SPEC_VERSION_V1,
	type JobResultV1,
	loadDaemonConfig,
	type NormalizedDaemonConfigV1,
	type NormalizedJobSpecV1,
	normalizeJobSpec,
	runDaemon,
} from "../src/index";
import { runJob } from "../src/runner";
import type { ExecutionOutputV1 } from "../src/types";

const temporaryDirectories: string[] = [];
const foregroundDaemonStops: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const stop of foregroundDaemonStops.splice(0)) {
		try {
			await stop();
		} catch {
			// Best-effort cleanup for foreground daemons running in-process.
		}
	}

	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempConfig(runtime: { heartbeatIntervalMs: number; idleSleepMs: number }): string {
	const directory = mkdtempSync(join(tmpdir(), "fixbot-sandbox-"));
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
				runtime,
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

async function startForegroundDaemon(
	configPath: string,
	jobRunner: DaemonJobRunner,
): Promise<{ config: NormalizedDaemonConfigV1; stop: () => Promise<void> }> {
	const config = loadDaemonConfig(configPath);
	const controller = new AbortController();
	const daemonRun = runDaemon(config, {
		signal: controller.signal,
		installSignalHandlers: false,
		jobRunner,
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

async function createFixtureRepository(rootDir: string): Promise<string> {
	const repoDir = join(rootDir, "repo");
	mkdirSync(repoDir, { recursive: true });
	writeFileSync(join(repoDir, "package.json"), '{ "name": "fixture", "version": "1.0.0" }\n', "utf-8");
	writeFileSync(join(repoDir, "index.ts"), "export const value = 1;\n", "utf-8");

	execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
	execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
	execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoDir });
	execFileSync("git", ["add", "."], { cwd: repoDir });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

	return repoDir;
}

class FakeExecutor implements PreparedJobExecutor {
	async execute(context: PreparedJobContext): Promise<ExecutionOutputV1> {
		writeFileSync(join(context.paths.workspaceDir, "index.ts"), "export const value = 2;\n", "utf-8");
		return {
			version: "fixbot.execution-output/v1",
			assistantFinalText:
				"FIXBOT_RESULT: success\nFIXBOT_SUMMARY: Updated the fixture.\nFIXBOT_FAILURE_REASON: none\n",
			parsedMarkers: {
				result: "success",
				summary: "Updated the fixture.",
				failureReason: "none",
				hasResult: true,
				hasSummary: true,
				hasFailureReason: true,
			},
			model: context.selectedModel,
		};
	}
}

class CrashingExecutor implements PreparedJobExecutor {
	async execute(_context: PreparedJobContext): Promise<ExecutionOutputV1> {
		throw new Error("executor-crash-test");
	}
}

function makeJobSpec(
	jobId: string,
	overrides?: Partial<{ mode: string; repoUrl: string; model: { provider: string; modelId: string } }>,
): NormalizedJobSpecV1 {
	return normalizeJobSpec(
		{
			version: JOB_SPEC_VERSION_V1,
			jobId,
			taskClass: "fix_ci",
			repo: { url: overrides?.repoUrl ?? "https://github.com/example/repo.git", baseBranch: "main" },
			fixCi: { githubActionsRunId: 12345 },
			execution: {
				mode: overrides?.mode ?? "process",
				timeoutMs: 300_000,
				memoryLimitMb: 4096,
				...(overrides?.model ? { model: overrides.model } : {}),
			},
		},
		`job:${jobId}`,
	);
}

describe("daemon sandbox lifecycle and artifact reporting", () => {
	it("daemon executes real runJob and writes complete artifacts", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const rootDir = dirname(configPath);
		const repoDir = await createFixtureRepository(rootDir);

		const knownAnthropicModel = getModels("anthropic")[0];
		if (!knownAnthropicModel) {
			throw new Error("Expected at least one anthropic model in the registry");
		}

		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

		try {
			process.env.ANTHROPIC_API_KEY = "test-key";

			const fakeExecutor = new FakeExecutor();
			const jobRunner: DaemonJobRunner = async (job, options) => {
				return runJob(job, {
					resultsDir: options.resultsDir,
					executor: fakeExecutor,
				});
			};

			const daemon = await startForegroundDaemon(configPath, jobRunner);
			const jobId = "sandbox-artifact-test";
			const job = makeJobSpec(jobId, {
				repoUrl: repoDir,
				model: { provider: "anthropic", modelId: knownAnthropicModel.id },
			});

			const envelope = createDaemonJobEnvelope(daemon.config, job);
			enqueueDaemonJob(daemon.config, envelope);

			const completedStatus = await waitFor(
				() => readDaemonStatusFile(daemon.config),
				(status) =>
					status?.state === "idle" && status.activeJob === null && status.recentResults[0]?.jobId === jobId,
				15_000,
			);

			expect(completedStatus).not.toBeNull();
			expect(completedStatus?.recentResults[0]?.status).toBe("success");

			const expectedPaths = getArtifactPaths(daemon.config.paths.resultsDir, jobId);

			expect(completedStatus?.recentResults[0]?.resultFile).toBe(expectedPaths.resultFile);
			expect(completedStatus?.recentResults[0]?.artifactDir).toBe(expectedPaths.artifactDir);

			expect(existsSync(expectedPaths.resultFile)).toBe(true);
			expect(existsSync(expectedPaths.jobSpecFile)).toBe(true);
			expect(existsSync(expectedPaths.patchFile)).toBe(true);
			expect(existsSync(expectedPaths.assistantFinalFile)).toBe(true);
			expect(existsSync(expectedPaths.executionPlanFile)).toBe(true);

			// Read back result JSON and verify artifact paths match
			const resultJson = JSON.parse(readFileSync(expectedPaths.resultFile, "utf-8")) as JobResultV1;
			expect(resultJson.artifacts.resultFile).toBe(expectedPaths.resultFile);
			expect(resultJson.artifacts.rootDir).toBe(expectedPaths.artifactDir);
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
		}
	});

	it("runner failure surfaces in recentResults without crashing the daemon", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const rootDir = dirname(configPath);
		const repoDir = await createFixtureRepository(rootDir);

		const knownAnthropicModel = getModels("anthropic")[0];
		if (!knownAnthropicModel) {
			throw new Error("Expected at least one anthropic model in the registry");
		}

		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

		try {
			process.env.ANTHROPIC_API_KEY = "test-key";

			const crashingExecutor = new CrashingExecutor();
			const jobRunner: DaemonJobRunner = async (job, options) => {
				return runJob(job, {
					resultsDir: options.resultsDir,
					executor: crashingExecutor,
				});
			};

			const daemon = await startForegroundDaemon(configPath, jobRunner);
			const jobId = "sandbox-crash-test";
			const job = makeJobSpec(jobId, {
				repoUrl: repoDir,
				model: { provider: "anthropic", modelId: knownAnthropicModel.id },
			});

			const envelope = createDaemonJobEnvelope(daemon.config, job);
			enqueueDaemonJob(daemon.config, envelope);

			const completedStatus = await waitFor(
				() => readDaemonStatusFile(daemon.config),
				(status) =>
					status?.state === "idle" && status.activeJob === null && status.recentResults[0]?.jobId === jobId,
				15_000,
			);

			expect(completedStatus).not.toBeNull();
			expect(completedStatus?.state).toBe("idle");
			expect(completedStatus?.recentResults[0]?.status).toBe("failed");
			expect(completedStatus?.recentResults[0]?.failureReason).toContain("executor-crash-test");
			// runJob() catches the executor error and returns a failed JobResultV1 rather than
			// throwing, so the daemon treats it as a successful runner return — lastError stays null.
			// The failure is visible only through recentResults[0].status and failureReason.

			// Artifact dir should still exist (resetArtifactDirectories creates it before execution)
			const expectedPaths = getArtifactPaths(daemon.config.paths.resultsDir, jobId);
			expect(existsSync(expectedPaths.artifactDir)).toBe(true);
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
		}
	});

	it("Docker preflight failure produces failed result", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const rootDir = dirname(configPath);
		const repoDir = await createFixtureRepository(rootDir);

		const knownAnthropicModel = getModels("anthropic")[0];
		if (!knownAnthropicModel) {
			throw new Error("Expected at least one anthropic model in the registry");
		}

		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
		const originalGhToken = process.env.GH_TOKEN;
		const originalGithubToken = process.env.GITHUB_TOKEN;

		try {
			process.env.ANTHROPIC_API_KEY = "test-key";
			process.env.GH_TOKEN = "fake-token";
			process.env.GITHUB_TOKEN = "fake-token";

			const jobRunner: DaemonJobRunner = async (job, options) => {
				return runJob(job, {
					resultsDir: options.resultsDir,
					executor: new FakeExecutor(),
					dockerImageVerifier: async () => {
						throw new Error("docker-image-missing");
					},
				});
			};

			const daemon = await startForegroundDaemon(configPath, jobRunner);
			const jobId = "sandbox-docker-preflight";
			const job = makeJobSpec(jobId, {
				mode: "docker",
				repoUrl: repoDir,
				model: { provider: "anthropic", modelId: knownAnthropicModel.id },
			});

			const envelope = createDaemonJobEnvelope(daemon.config, job);
			enqueueDaemonJob(daemon.config, envelope);

			const completedStatus = await waitFor(
				() => readDaemonStatusFile(daemon.config),
				(status) =>
					status?.state === "idle" && status.activeJob === null && status.recentResults[0]?.jobId === jobId,
				15_000,
			);

			expect(completedStatus).not.toBeNull();
			expect(completedStatus?.state).toBe("idle");
			expect(completedStatus?.recentResults[0]?.status).toBe("failed");
			expect(completedStatus?.recentResults[0]?.failureReason).toContain("docker-image-missing");
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
			if (originalGhToken === undefined) {
				delete process.env.GH_TOKEN;
			} else {
				process.env.GH_TOKEN = originalGhToken;
			}
			if (originalGithubToken === undefined) {
				delete process.env.GITHUB_TOKEN;
			} else {
				process.env.GITHUB_TOKEN = originalGithubToken;
			}
		}
	});
});
