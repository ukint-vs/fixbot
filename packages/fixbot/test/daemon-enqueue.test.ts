import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "bun:test";
import { getArtifactPaths } from "../src/artifacts";
import { createDaemonStatus } from "../src/config";
import { createDaemonJobEnvelope, enqueueDaemonJobFromFile } from "../src/daemon/enqueue";
import { enqueueDaemonJob, ensureDaemonJobStoreDirectories } from "../src/daemon/job-store";
import {
	ensureDaemonStateDirectories,
	readDaemonStatusFile,
	writeDaemonLockFile,
	writeDaemonPidFile,
	writeDaemonStatusFile,
} from "../src/daemon/status-store";
import {
	DAEMON_JOB_ENVELOPE_VERSION_V1,
	type DaemonJobRunner,
	DuplicateDaemonJobError,
	JOB_RESULT_VERSION_V1,
	JOB_SPEC_VERSION_V1,
	type JobResultV1,
	listActiveDaemonJobs,
	listQueuedDaemonJobs,
	loadDaemonConfig,
	type NormalizedDaemonConfigV1,
	type NormalizedJobSpecV1,
	normalizeJobSpec,
	renderDaemonStatus,
	runDaemon,
} from "../src/index";

const require = createRequire(import.meta.url);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntryPath = resolve(packageDirectory, "src/cli.ts");
const tsxCliPath = require.resolve("tsx/cli");
const validFixtureJobPath = resolve(packageDirectory, "test/fixtures/jobs/manual-enqueue.valid.json");
const temporaryDirectories: string[] = [];
const foregroundDaemonStops: Array<() => Promise<void>> = [];

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

interface FakeResultOptions {
	status?: JobResultV1["status"];
	summary?: string;
	failureReason?: string;
}

function createDeferred<T>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve: resolvePromise,
		reject: rejectPromise,
	};
}

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
	const directory = mkdtempSync(join(tmpdir(), "fixbot-enqueue-"));
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

function createJobFile(configPath: string, name: string, content: string): string {
	const directory = dirname(configPath);
	const jobsDir = join(directory, "jobs");
	const jobPath = join(jobsDir, name);
	mkdirSync(jobsDir, { recursive: true });
	writeFileSync(jobPath, content, "utf-8");
	return jobPath;
}

function runCli(args: string[]): string {
	return execFileSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
		cwd: packageDirectory,
		encoding: "utf-8",
	});
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

function createFakeJobResult(
	job: NormalizedJobSpecV1,
	resultsDir: string,
	options: FakeResultOptions = {},
): JobResultV1 {
	const startedAt = new Date().toISOString();
	const finishedAt = new Date(Date.now() + 5).toISOString();
	const paths = getArtifactPaths(resultsDir, job.jobId);
	mkdirSync(paths.workspaceDir, { recursive: true });

	const result: JobResultV1 = {
		version: JOB_RESULT_VERSION_V1,
		jobId: job.jobId,
		taskClass: job.taskClass,
		status: options.status ?? "success",
		summary: options.summary ?? "fake runner completed",
		failureReason: options.failureReason,
		repo: job.repo,
		fixCi: job.fixCi,
		execution: {
			mode: job.execution.mode,
			timeoutMs: job.execution.timeoutMs,
			memoryLimitMb: job.execution.memoryLimitMb,
			sandbox: job.execution.sandbox,
			model: job.execution.model,
			workspaceDir: paths.workspaceDir,
			startedAt,
			finishedAt,
			durationMs: 5,
		},
		artifacts: {
			resultFile: paths.resultFile,
			rootDir: paths.artifactDir,
			jobSpecFile: paths.jobSpecFile,
			patchFile: paths.patchFile,
			traceFile: paths.traceFile,
			assistantFinalFile: paths.assistantFinalFile,
		},
		diagnostics: {
			patchSha256: "fake-patch-sha256",
			changedFileCount: 0,
			markers: {
				result: true,
				summary: true,
				failureReason: options.failureReason !== undefined,
			},
		},
	};

	writeFileSync(paths.resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
	return result;
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

function makeJobSpec(jobId: string): NormalizedJobSpecV1 {
	return normalizeJobSpec(
		{
			version: JOB_SPEC_VERSION_V1,
			jobId,
			taskClass: "fix_ci",
			repo: { url: "https://github.com/example/repo.git", baseBranch: "main" },
			fixCi: { githubActionsRunId: 12345 },
			execution: { timeoutMs: 120_000, memoryLimitMb: 2048 },
		},
		`job:${jobId}`,
	);
}

describe("daemon enqueue", () => {
	it("enqueues via the CLI, gets claimed by the daemon, and records the recent result", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const runnerStarted = createDeferred<{ job: NormalizedJobSpecV1; resultsDir: string }>();
		const allowRunnerToFinish = createDeferred<void>();
		const daemon = await startForegroundDaemon(configPath, async (job, options) => {
			runnerStarted.resolve({ job, resultsDir: options.resultsDir });
			await allowRunnerToFinish.promise;
			return createFakeJobResult(job, options.resultsDir, {
				summary: "fake runner completed",
			});
		});

		const output = runCli(["daemon", "enqueue", "--config", configPath, "--job", validFixtureJobPath]);
		const artifactPaths = getArtifactPaths(daemon.config.paths.resultsDir, "manual-enqueue-job");

		expect(output).toContain("Enqueued daemon job:");
		expect(output).toContain("Job ID: manual-enqueue-job");
		expect(output).toContain(`Artifact root: ${artifactPaths.artifactDir}`);
		expect(output).toContain(`Result file: ${artifactPaths.resultFile}`);

		const invocation = await runnerStarted.promise;
		expect(invocation.job.jobId).toBe("manual-enqueue-job");
		expect(invocation.resultsDir).toBe(daemon.config.paths.resultsDir);

		const runningStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			(status) => status?.state === "running" && status.activeJob?.jobId === "manual-enqueue-job",
			5_000,
		);
		expect(runningStatus?.queue).toEqual({
			depth: 0,
			preview: [],
			previewTruncated: false,
		});
		expect(runningStatus?.activeJob).toMatchObject({
			jobId: "manual-enqueue-job",
			state: "running",
			artifactDir: artifactPaths.artifactDir,
		});
		expect(listQueuedDaemonJobs(daemon.config)).toEqual([]);
		expect(listActiveDaemonJobs(daemon.config)).toHaveLength(1);
		expect(listActiveDaemonJobs(daemon.config)[0]?.envelope.jobId).toBe("manual-enqueue-job");

		allowRunnerToFinish.resolve();

		const completedStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			(status) =>
				status?.state === "idle" &&
				status.activeJob === null &&
				status.recentResults[0]?.jobId === "manual-enqueue-job",
			5_000,
		);
		expect(completedStatus?.queue).toEqual({
			depth: 0,
			preview: [],
			previewTruncated: false,
		});
		expect(completedStatus?.recentResults[0]).toMatchObject({
			jobId: "manual-enqueue-job",
			status: "success",
			summary: "fake runner completed",
			resultFile: artifactPaths.resultFile,
			artifactDir: artifactPaths.artifactDir,
		});
		expect(existsSync(artifactPaths.resultFile)).toBe(true);
		expect(listActiveDaemonJobs(daemon.config)).toEqual([]);
	});

	it("rejects invalid raw job files before any queue file is written", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const jobPath = createJobFile(
			configPath,
			"invalid-job.json",
			`${JSON.stringify(
				{
					version: "fixbot.job/v1",
					jobId: "invalid-job",
					taskClass: "fix_ci",
					repo: {
						url: "https://github.com/example/repo.git",
						baseBranch: "main",
					},
					fixCi: {
						githubActionsRunId: 12345,
					},
					execution: {
						timeoutMs: 59_999,
						memoryLimitMb: 2048,
					},
				},
				null,
				2,
			)}\n`,
		);

		await expect(enqueueDaemonJobFromFile(configPath, jobPath)).rejects.toThrow(
			`${jobPath}.execution.timeoutMs must be between 60000 and 3600000`,
		);

		const config = loadDaemonConfig(configPath);
		expect(listQueuedDaemonJobs(config)).toEqual([]);
	});

	it("rejects enqueue after the daemon has been cleanly stopped", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const daemon = await startForegroundDaemon(configPath, async (job, options) =>
			createFakeJobResult(job, options.resultsDir),
		);
		await daemon.stop();

		await expect(enqueueDaemonJobFromFile(configPath, validFixtureJobPath)).rejects.toThrow(
			'Cannot enqueue job "manual-enqueue-job" because fixbot daemon is not live: daemon stopped by operator (state=degraded)',
		);

		const config = loadDaemonConfig(configPath);
		expect(listQueuedDaemonJobs(config)).toEqual([]);
	});

	it("rejects enqueue when the daemon pid is stale", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 250,
			idleSleepMs: 50,
		});
		const config = loadDaemonConfig(configPath);
		ensureDaemonStateDirectories(config);
		writeDaemonPidFile(config, 999_999);
		writeDaemonLockFile(config, {
			pid: 999_999,
			startedAt: "2026-03-16T08:00:00.000Z",
			updatedAt: "2026-03-16T08:00:05.000Z",
			configFilePath: configPath,
		});
		writeDaemonStatusFile(config, {
			status: createDaemonStatus(config, {
				state: "idle",
				pid: 999_999,
				startedAt: "2026-03-16T08:00:00.000Z",
				heartbeatAt: "2026-03-16T08:00:05.000Z",
				lastTransitionAt: "2026-03-16T08:00:05.000Z",
			}),
		});

		await expect(enqueueDaemonJobFromFile(configPath, validFixtureJobPath)).rejects.toThrow(
			'Cannot enqueue job "manual-enqueue-job" because fixbot daemon is not live: recorded daemon pid 999999 is stale and no longer running',
		);
		expect(listQueuedDaemonJobs(config)).toEqual([]);
	});

	it("rejects duplicate manual submissions once the daemon has claimed the active job", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const runnerStarted = createDeferred<void>();
		const allowRunnerToFinish = createDeferred<void>();
		const daemon = await startForegroundDaemon(configPath, async (job, options) => {
			runnerStarted.resolve();
			await allowRunnerToFinish.promise;
			return createFakeJobResult(job, options.resultsDir);
		});

		const first = await enqueueDaemonJobFromFile(configPath, validFixtureJobPath);
		await runnerStarted.promise;
		const runningStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			(status) => status?.state === "running" && status.activeJob?.jobId === first.envelope.jobId,
			5_000,
		);
		expect(runningStatus?.queue).toEqual({
			depth: 0,
			preview: [],
			previewTruncated: false,
		});

		await expect(enqueueDaemonJobFromFile(configPath, validFixtureJobPath)).rejects.toThrow(DuplicateDaemonJobError);
		expect(listQueuedDaemonJobs(daemon.config)).toEqual([]);
		expect(listActiveDaemonJobs(daemon.config)).toHaveLength(1);
		expect(listActiveDaemonJobs(daemon.config)[0]?.envelope.jobId).toBe(first.envelope.jobId);

		allowRunnerToFinish.resolve();
		await waitFor(
			() => readDaemonStatusFile(daemon.config),
			(status) =>
				status?.state === "idle" &&
				status.activeJob === null &&
				status.recentResults[0]?.jobId === first.envelope.jobId,
			5_000,
		);
	});

	it("shows queued backlog in FIFO order while a job is running", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const runnerStarted = createDeferred<{ job: NormalizedJobSpecV1; resultsDir: string }>();
		const allowRunnerToFinish = createDeferred<void>();

		const daemon = await startForegroundDaemon(configPath, async (job, options) => {
			runnerStarted.resolve({ job, resultsDir: options.resultsDir });
			await allowRunnerToFinish.promise;
			return createFakeJobResult(job, options.resultsDir);
		});

		try {
			// Enqueue job A — the daemon will claim it first.
			const enqueuedAtA = new Date().toISOString();
			const envelopeA = createDaemonJobEnvelope(daemon.config, makeJobSpec("fifo-job-a"), {
				enqueuedAt: enqueuedAtA,
			});
			enqueueDaemonJob(daemon.config, envelopeA);

			// Wait until the daemon claims job A and transitions to running.
			await runnerStarted.promise;
			await waitFor(
				() => readDaemonStatusFile(daemon.config),
				(status) => status?.state === "running" && status.activeJob?.jobId === "fifo-job-a",
				5_000,
			);

			// Enqueue jobs B and C while A is still running — these must remain in queue.
			const enqueuedAtB = new Date(Date.now() + 1).toISOString();
			const enqueuedAtC = new Date(Date.now() + 2).toISOString();
			const envelopeB = createDaemonJobEnvelope(daemon.config, makeJobSpec("fifo-job-b"), {
				enqueuedAt: enqueuedAtB,
			});
			const envelopeC = createDaemonJobEnvelope(daemon.config, makeJobSpec("fifo-job-c"), {
				enqueuedAt: enqueuedAtC,
			});
			enqueueDaemonJob(daemon.config, envelopeB);
			enqueueDaemonJob(daemon.config, envelopeC);

			// Wait until the daemon idle-loop sees the depth change and refreshes status.
			const backlogStatus = await waitFor(
				() => readDaemonStatusFile(daemon.config),
				(status) =>
					status?.state === "running" && status.activeJob?.jobId === "fifo-job-a" && status.queue.depth === 2,
				5_000,
			);

			// Active job must be A.
			expect(backlogStatus?.activeJob).toMatchObject({
				jobId: "fifo-job-a",
				state: "running",
			});

			// Queue depth must reflect B and C.
			expect(backlogStatus?.queue.depth).toBe(2);

			// Preview must list B before C (FIFO by enqueuedAt).
			expect(backlogStatus?.queue.preview).toHaveLength(2);
			expect(backlogStatus?.queue.preview[0]?.jobId).toBe("fifo-job-b");
			expect(backlogStatus?.queue.preview[1]?.jobId).toBe("fifo-job-c");
			expect(backlogStatus?.queue.previewTruncated).toBe(false);

			// CLI render must also show the correct operator-visible output.
			expect(backlogStatus).toBeDefined();
			const rendered = renderDaemonStatus(backlogStatus!, []);
			expect(rendered).toContain("Queue depth: 2");
			expect(rendered).toContain("Queue preview: 2 shown");
			expect(rendered).toContain("Queued job 1: fifo-job-b");
			expect(rendered).toContain("Queued job 2: fifo-job-c");
			expect(rendered).toContain("Active job: fifo-job-a (running)");

			// Spool directories must agree.
			expect(listQueuedDaemonJobs(daemon.config).map((r) => r.envelope.jobId)).toEqual(["fifo-job-b", "fifo-job-c"]);
			expect(listActiveDaemonJobs(daemon.config)).toHaveLength(1);
			expect(listActiveDaemonJobs(daemon.config)[0]?.envelope.jobId).toBe("fifo-job-a");
		} finally {
			// Always unblock the runner so afterEach can stop the daemon cleanly.
			allowRunnerToFinish.resolve();
		}
	});

	it("drains jobs in FIFO order and preserves recent results across a stop/start cycle", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});

		// Per-job deferred pairs so we can serialize execution precisely.
		const runnerStartedForJob: Record<string, Deferred<void>> = {
			"fifo-drain-a": createDeferred<void>(),
			"fifo-drain-b": createDeferred<void>(),
			"fifo-drain-c": createDeferred<void>(),
		};
		const allowJobToFinish: Record<string, Deferred<void>> = {
			"fifo-drain-a": createDeferred<void>(),
			"fifo-drain-b": createDeferred<void>(),
			"fifo-drain-c": createDeferred<void>(),
		};
		const claimOrder: string[] = [];

		const daemon = await startForegroundDaemon(configPath, async (job, options) => {
			claimOrder.push(job.jobId);
			runnerStartedForJob[job.jobId]?.resolve();
			await allowJobToFinish[job.jobId]?.promise;
			return createFakeJobResult(job, options.resultsDir, {
				summary: `${job.jobId} done`,
			});
		});

		// Enqueue A, then B and C with strictly increasing timestamps.
		const enqueuedAtA = new Date().toISOString();
		const enqueuedAtB = new Date(Date.now() + 1).toISOString();
		const enqueuedAtC = new Date(Date.now() + 2).toISOString();
		enqueueDaemonJob(
			daemon.config,
			createDaemonJobEnvelope(daemon.config, makeJobSpec("fifo-drain-a"), { enqueuedAt: enqueuedAtA }),
		);
		enqueueDaemonJob(
			daemon.config,
			createDaemonJobEnvelope(daemon.config, makeJobSpec("fifo-drain-b"), { enqueuedAt: enqueuedAtB }),
		);
		enqueueDaemonJob(
			daemon.config,
			createDaemonJobEnvelope(daemon.config, makeJobSpec("fifo-drain-c"), { enqueuedAt: enqueuedAtC }),
		);

		// Wait for A to be claimed, then release it.
		await runnerStartedForJob["fifo-drain-a"]!.promise;
		allowJobToFinish["fifo-drain-a"]!.resolve();

		// Wait for B to be claimed (confirms A→B FIFO order), then release it.
		await runnerStartedForJob["fifo-drain-b"]!.promise;
		allowJobToFinish["fifo-drain-b"]!.resolve();

		// Wait for C to be claimed (confirms B→C FIFO order), then release it.
		await runnerStartedForJob["fifo-drain-c"]!.promise;
		allowJobToFinish["fifo-drain-c"]!.resolve();

		// Wait for the queue to fully drain and recent results to arrive.
		const drainedStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			(status) => status?.state === "idle" && status.activeJob === null && status.recentResults.length === 3,
			5_000,
		);

		// Claim order must be strict FIFO.
		expect(claimOrder).toEqual(["fifo-drain-a", "fifo-drain-b", "fifo-drain-c"]);

		// Queue must be empty.
		expect(drainedStatus?.queue).toEqual({ depth: 0, preview: [], previewTruncated: false });
		expect(listQueuedDaemonJobs(daemon.config)).toEqual([]);

		// Recent results are newest-first (C, B, A).
		expect(drainedStatus?.recentResults.map((r) => r.jobId)).toEqual([
			"fifo-drain-c",
			"fifo-drain-b",
			"fifo-drain-a",
		]);
		expect(drainedStatus?.recentResults.map((r) => r.status)).toEqual(["success", "success", "success"]);
		expect(drainedStatus?.recentResults.map((r) => r.summary)).toEqual([
			"fifo-drain-c done",
			"fifo-drain-b done",
			"fifo-drain-a done",
		]);

		// CLI render confirms operator visibility.
		expect(drainedStatus).toBeDefined();
		const rendered = renderDaemonStatus(drainedStatus!, []);
		expect(rendered).toContain("Recent results: 3");
		expect(rendered).toContain("Recent result 1: fifo-drain-c success");
		expect(rendered).toContain("Recent result 2: fifo-drain-b success");
		expect(rendered).toContain("Recent result 3: fifo-drain-a success");

		// Stop the daemon and start a fresh instance — recent results must survive.
		await daemon.stop();

		const daemon2 = await startForegroundDaemon(configPath, async (job, options) =>
			createFakeJobResult(job, options.resultsDir),
		);
		const restartStatus = readDaemonStatusFile(daemon2.config);
		expect(restartStatus?.recentResults.map((r) => r.jobId)).toEqual([
			"fifo-drain-c",
			"fifo-drain-b",
			"fifo-drain-a",
		]);
	});

	it("surfaces orphaned active spool files as degraded state after a restart", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});

		// Set up durable state directories and write a synthetic orphan active spool file
		// representing a job that was claimed but whose daemon process never cleaned up.
		const config = loadDaemonConfig(configPath);
		ensureDaemonStateDirectories(config);
		const storePaths = ensureDaemonJobStoreDirectories(config);

		const orphanJobId = "orphan-active-job";
		const orphanArtifacts = getArtifactPaths(config.paths.resultsDir, orphanJobId);
		const orphanEnvelope = {
			version: DAEMON_JOB_ENVELOPE_VERSION_V1,
			jobId: orphanJobId,
			job: normalizeJobSpec(
				{
					version: JOB_SPEC_VERSION_V1,
					jobId: orphanJobId,
					taskClass: "fix_ci",
					repo: { url: "https://github.com/example/repo.git", baseBranch: "main" },
					fixCi: { githubActionsRunId: 12345 },
					execution: { timeoutMs: 120_000, memoryLimitMb: 2048 },
				},
				`job:${orphanJobId}`,
			),
			submission: { kind: "cli" as const },
			enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
			artifacts: {
				artifactDir: orphanArtifacts.artifactDir,
				resultFile: orphanArtifacts.resultFile,
			},
		};

		// Write the active file directly (bypassing the normal claim path to simulate a crash).
		const activeFileName = `${orphanJobId.replace(/[^a-z0-9._-]+/g, "-")}-${orphanJobId}.json`;
		writeFileSync(
			join(storePaths.activeDir, activeFileName),
			`${JSON.stringify(orphanEnvelope, null, 2)}\n`,
			"utf-8",
		);

		// Start the daemon — it should detect the orphan and surface it.
		const daemon = await startForegroundDaemon(configPath, async (job, options) =>
			createFakeJobResult(job, options.resultsDir),
		);

		// Wait for the daemon to finish startup and surface the orphan state.
		const orphanStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			(status) =>
				status !== undefined &&
				status.pid === process.pid &&
				(status.state === "degraded" ||
					(status.lastError !== null && status.lastError?.code === "ORPHANED_ACTIVE_JOB")),
			5_000,
		);

		expect(orphanStatus).not.toBeNull();
		expect(orphanStatus?.lastError?.code).toBe("ORPHANED_ACTIVE_JOB");
		expect(orphanStatus?.lastError?.message).toContain(orphanJobId);
	});
});
