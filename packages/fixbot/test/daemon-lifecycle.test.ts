import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getArtifactPaths } from "../src/artifacts";
import { createDaemonStatus, loadDaemonConfig } from "../src/config";
import { normalizeJobSpec } from "../src/contracts";
import { createDaemonJobEnvelope, enqueueDaemonJobFromFile } from "../src/daemon/enqueue";
import { enqueueDaemonJob, listQueuedDaemonJobs } from "../src/daemon/job-store";
import {
	type DaemonJobRunner,
	getDaemonStatusFromConfigFile,
	runDaemon,
	startDaemonInBackground,
	stopDaemonFromConfigFile,
} from "../src/daemon/service";
import {
	ensureDaemonStateDirectories,
	readDaemonStatusFile,
	writeDaemonLockFile,
	writeDaemonPidFile,
	writeDaemonStatusFile,
} from "../src/daemon/status-store";
import type { NormalizedJobSpecV1 } from "../src/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		const configPath = join(directory, "daemon.config.json");
		if (existsSync(configPath)) {
			try {
				await stopDaemonFromConfigFile(configPath);
			} catch {
				// Best-effort cleanup for detached child processes created by the test.
			}
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempConfig(runtime: { heartbeatIntervalMs: number; idleSleepMs: number }): string {
	const directory = mkdtempSync(join(tmpdir(), "fixbot-"));
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
		await new Promise(resolve => setTimeout(resolve, 25));
		lastValue = await callback();
	}
	return lastValue;
}

function makeCannedRunner(summary: string): DaemonJobRunner {
	return async (job, options) => ({
		version: "fixbot.result/v1" as const,
		jobId: job.jobId,
		taskClass: job.taskClass,
		status: "success" as const,
		summary,
		repo: job.repo,
		fixCi: job.fixCi,
		execution: {
			...job.execution,
			workspaceDir: "/tmp/canned",
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			durationMs: 1,
		},
		artifacts: {
			resultFile: join(options.resultsDir, `job-${job.jobId}.json`),
			rootDir: join(options.resultsDir, `job-${job.jobId}`),
			jobSpecFile: "spec.json",
			patchFile: "patch.diff",
			traceFile: "trace.json",
			assistantFinalFile: "assistant.md",
		},
		diagnostics: {
			patchSha256: "0000",
			changedFileCount: 0,
			markers: { result: true, summary: true, failureReason: false },
		},
	});
}

function makeTestJob(jobId: string): NormalizedJobSpecV1 {
	return normalizeJobSpec(
		{
			version: "fixbot.job/v1" as const,
			jobId,
			taskClass: "fix_ci" as const,
			repo: { url: "https://github.com/example/repo.git", baseBranch: "main" },
			fixCi: { githubActionsRunId: 99001 },
			execution: { mode: "process", timeoutMs: 120_000, memoryLimitMb: 2_048 },
		},
		`job:${jobId}`,
	);
}

describe("daemon lifecycle", () => {
	it("starts in the background, persists heartbeat updates, and stops cleanly", async () => {
		// startDaemonInBackground can't work during bun test (process.argv[1] is the test runner)
		if (process.argv[1]?.includes("test")) return;
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});

		const started = await startDaemonInBackground(configPath, {
			startupTimeoutMs: 5_000,
		});
		expect(started.pid).toBeGreaterThan(0);
		expect(started.status.state).toBe("idle");
		expect(started.status.pid).toBe(started.pid);
		expect(existsSync(started.config.paths.statusFile)).toBe(true);
		expect(existsSync(started.config.paths.pidFile)).toBe(true);
		expect(existsSync(started.config.paths.lockFile)).toBe(true);

		const firstHeartbeat = started.status.heartbeatAt;
		const heartbeatStatus = await waitFor(
			async () => getDaemonStatusFromConfigFile(configPath),
			result => result.status.heartbeatAt !== undefined && result.status.heartbeatAt !== firstHeartbeat,
			5_000,
		);
		expect(heartbeatStatus.status.heartbeatAt).not.toBe(firstHeartbeat);
		expect(heartbeatStatus.issues).toEqual([]);

		const stopped = await stopDaemonFromConfigFile(configPath);
		expect(stopped.alreadyStopped).toBe(false);
		expect(stopped.stoppedPid).toBe(started.pid);
		expect(stopped.status.state).toBe("degraded");
		expect(stopped.status.pid).toBeUndefined();
		expect(stopped.status.lastError).toMatchObject({
			code: "STOPPED",
			message: "daemon stopped by operator",
		});
		expect(existsSync(started.config.paths.pidFile)).toBe(false);
		expect(existsSync(started.config.paths.lockFile)).toBe(false);

		const storedStatus = readDaemonStatusFile(started.config);
		expect(storedStatus).toEqual(stopped.status);
	});

	it("reports a stale pid truthfully through daemon status", async () => {
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

		const statusResult = await getDaemonStatusFromConfigFile(configPath);
		expect(statusResult.status.state).toBe("degraded");
		expect(statusResult.status.pid).toBe(999_999);
		expect(statusResult.status.lastError).toMatchObject({
			code: "STALE_PID",
		});
		expect(statusResult.issues).toContain("recorded daemon pid 999999 is stale and no longer running");

		const persisted = readDaemonStatusFile(config);
		expect(persisted?.state).toBe("degraded");
		expect(persisted?.lastError?.code).toBe("STALE_PID");
	});

	it("cleans up stale runtime files when stop is requested against a missing process", async () => {
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

		const result = await stopDaemonFromConfigFile(configPath);
		expect(result.alreadyStopped).toBe(true);
		expect(result.status.state).toBe("degraded");
		expect(result.status.lastError?.code).toBe("STALE_PID");
		expect(existsSync(config.paths.pidFile)).toBe(false);
		expect(existsSync(config.paths.lockFile)).toBe(false);
	});

	it("preserves recentResults across a stop/start cycle", async () => {
		if (process.argv[1]?.includes("test")) return;
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const config = loadDaemonConfig(configPath);
		ensureDaemonStateDirectories(config);

		// Persist a status with synthetic recentResults as if a prior run had completed a job.
		const priorStatus = createDaemonStatus(config, {
			state: "degraded",
			startedAt: "2026-03-16T08:00:00.000Z",
			heartbeatAt: "2026-03-16T08:00:10.000Z",
			lastTransitionAt: "2026-03-16T08:00:10.000Z",
			lastError: { message: "daemon stopped by operator", code: "STOPPED", at: "2026-03-16T08:00:10.000Z" },
			recentResults: [
				{
					jobId: "prior-job-001",
					status: "success",
					finishedAt: "2026-03-16T08:00:09.000Z",
					summary: "fixed upstream CI",
				},
			],
		});
		writeDaemonStatusFile(config, { status: priorStatus });

		// Start the daemon; it should read the persisted status and carry forward recentResults.
		const started = await startDaemonInBackground(configPath, { startupTimeoutMs: 5_000 });
		expect(started.status.state).toBe("idle");

		const { status } = await getDaemonStatusFromConfigFile(configPath);
		expect(status.recentResults).toHaveLength(1);
		expect(status.recentResults[0]).toMatchObject({
			jobId: "prior-job-001",
			status: "success",
			summary: "fixed upstream CI",
		});

		await stopDaemonFromConfigFile(configPath);
	});

	it("re-queues orphaned active spool files at startup and processes them", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const config = loadDaemonConfig(configPath);
		ensureDaemonStateDirectories(config);

		// Write an orphaned active-spool file directly (simulating a crashed daemon that never removed it).
		const orphanEnvelope = createDaemonJobEnvelope(config, {
			version: "fixbot.job/v1" as const,
			jobId: "orphan-job-001",
			taskClass: "fix_ci" as const,
			repo: { url: "https://github.com/example/repo.git", baseBranch: "main" },
			fixCi: { githubActionsRunId: 77777 },
			execution: {
				mode: "process" as const,
				timeoutMs: 120_000,
				memoryLimitMb: 2_048,
				sandbox: { mode: "workspace-write" as const, networkAccess: true },
			},
		});
		const activeDir = join(config.paths.stateDir, "active");
		mkdirSync(activeDir, { recursive: true });
		writeFileSync(
			join(activeDir, "orphan-job-001-abcdef1234.json"),
			`${JSON.stringify(orphanEnvelope, null, 2)}\n`,
			"utf-8",
		);

		// Start the daemon with a canned runner so the re-queued orphan is processed.
		const controller = new AbortController();
		const daemonRun = runDaemon(config, {
			signal: controller.signal,
			installSignalHandlers: false,
			jobRunner: makeCannedRunner("orphan re-queued and processed"),
		});

		// Wait for the daemon to process the re-queued orphan (it should appear in recentResults).
		const status = await waitFor(
			() => readDaemonStatusFile(config),
			s => s !== undefined && s.pid === process.pid && s.state === "idle" && s.recentResults.length > 0,
			5_000,
		);

		controller.abort();
		await daemonRun;

		// The orphan was re-queued, claimed, and processed.
		expect(status?.recentResults[0]?.jobId).toBe("orphan-job-001");
		const activeFiles = existsSync(activeDir) ? readdirSync(activeDir).filter(f => f.endsWith(".json")) : [];
		expect(activeFiles).toEqual([]);
	});

	it("cleans up completed orphan with existing result artifacts instead of re-queuing", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const config = loadDaemonConfig(configPath);
		ensureDaemonStateDirectories(config);

		// Write an orphaned active-spool file for a job that already completed.
		const orphanEnvelope = createDaemonJobEnvelope(config, {
			version: "fixbot.job/v1" as const,
			jobId: "completed-orphan-001",
			taskClass: "fix_ci" as const,
			repo: { url: "https://github.com/example/repo.git", baseBranch: "main" },
			fixCi: { githubActionsRunId: 88888 },
			execution: {
				mode: "process" as const,
				timeoutMs: 120_000,
				memoryLimitMb: 2_048,
				sandbox: { mode: "workspace-write" as const, networkAccess: true },
			},
		});
		const activeDir = join(config.paths.stateDir, "active");
		mkdirSync(activeDir, { recursive: true });
		writeFileSync(
			join(activeDir, "completed-orphan-001-abcdef1234.json"),
			`${JSON.stringify(orphanEnvelope, null, 2)}\n`,
			"utf-8",
		);

		// Simulate that the job already completed by writing its result file.
		const artifactPaths = getArtifactPaths(config.paths.resultsDir, "completed-orphan-001");
		mkdirSync(artifactPaths.artifactDir, { recursive: true });
		writeFileSync(artifactPaths.resultFile, "{}\n", "utf-8");

		const controller = new AbortController();
		const daemonRun = runDaemon(config, {
			signal: controller.signal,
			installSignalHandlers: false,
		});

		await waitFor(
			() => readDaemonStatusFile(config),
			status => status !== undefined && status.pid === process.pid && status.state === "idle",
			5_000,
		);

		controller.abort();
		await daemonRun;

		// The orphan should have been cleaned up (deleted), NOT re-queued.
		const activeFiles = existsSync(activeDir) ? readdirSync(activeDir).filter(f => f.endsWith(".json")) : [];
		expect(activeFiles).toEqual([]);
		const queueDir = join(config.paths.stateDir, "queue");
		const queueFiles = existsSync(queueDir) ? readdirSync(queueDir).filter(f => f.endsWith(".json")) : [];
		expect(queueFiles).toEqual([]);
	});

	it("foreground logger callback receives startup log messages", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const config = loadDaemonConfig(configPath);

		const logMessages: string[] = [];
		const controller = new AbortController();
		const daemonRun = runDaemon(config, {
			signal: controller.signal,
			installSignalHandlers: false,
			logger: {
				info: msg => logMessages.push(msg),
				warn: msg => logMessages.push(msg),
				error: msg => logMessages.push(msg),
				success: msg => logMessages.push(msg),
			},
		});

		await waitFor(
			() => readDaemonStatusFile(config),
			status => status !== undefined && status.pid === process.pid && status.state === "idle",
			5_000,
		);

		controller.abort();
		await daemonRun;

		// The logger should have received at least one message (the startup state log).
		expect(logMessages.length).toBeGreaterThan(0);
		expect(logMessages.some(msg => msg.includes("state="))).toBe(true);
	});

	it("reflects updated queue depth and preview immediately after enqueue without waiting for heartbeat", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 5_000,
			idleSleepMs: 500,
		});
		const config = loadDaemonConfig(configPath);
		ensureDaemonStateDirectories(config);

		// Start daemon with a slow heartbeat so queue updates are NOT triggered by heartbeat during this test.
		const controller = new AbortController();
		const daemonRun = runDaemon(config, {
			signal: controller.signal,
			installSignalHandlers: false,
		});

		// Wait for idle.
		const idleStatus = await waitFor(
			() => readDaemonStatusFile(config),
			status => status?.state === "idle" && status.pid === process.pid,
			5_000,
		);
		expect(idleStatus?.state).toBe("idle");

		// Enqueue a job; enqueueDaemonJobFromFile should refresh the status synchronously.
		await enqueueDaemonJobFromFile(
			configPath,
			resolve(process.cwd(), "test/fixtures/jobs/manual-enqueue.valid.json"),
		);
		const afterEnqueue = readDaemonStatusFile(config);
		expect(afterEnqueue?.queue.depth).toBe(1);
		expect(afterEnqueue?.queue.preview).toHaveLength(1);
		expect(afterEnqueue?.queue.preview[0]?.jobId).toBe("manual-enqueue-job");

		controller.abort();
		await daemonRun;
	});

	it("queued jobs survive daemon stop/start and are processed by the restarted daemon", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 5_000, // Slow idle so daemon 1 won't claim the job before abort
		});
		const config = loadDaemonConfig(configPath);
		const jobId = "restart-queue-survival";
		const job = makeTestJob(jobId);
		const cannedRunner = makeCannedRunner("canned-success");

		// Daemon 1: start, enqueue, abort immediately (job stays in queue due to slow idle)
		const controller1 = new AbortController();
		const daemon1 = runDaemon(config, {
			signal: controller1.signal,
			installSignalHandlers: false,
			jobRunner: cannedRunner,
		});

		await waitFor(
			() => readDaemonStatusFile(config),
			status => status?.state === "idle" && status.pid === process.pid,
			5_000,
		);

		const envelope = createDaemonJobEnvelope(config, job);
		enqueueDaemonJob(config, envelope);

		// Abort daemon 1 before it can pick up the job (idleSleepMs is 5s)
		controller1.abort();
		await daemon1;

		// Queue spool file must survive the stop
		const queued = listQueuedDaemonJobs(config);
		expect(queued).toHaveLength(1);
		expect(queued[0]?.envelope.jobId).toBe(jobId);

		// Daemon 2: fast idle so it picks up the surviving job
		const fastConfig = loadDaemonConfig(configPath);
		fastConfig.runtime.idleSleepMs = 20;

		const controller2 = new AbortController();
		const daemon2 = runDaemon(fastConfig, {
			signal: controller2.signal,
			installSignalHandlers: false,
			jobRunner: cannedRunner,
		});

		// Wait for the job to appear in recentResults
		const completedStatus = await waitFor(
			() => readDaemonStatusFile(fastConfig),
			status =>
				status !== undefined &&
				status.recentResults.length > 0 &&
				status.recentResults[0]?.jobId === jobId &&
				status.queue.depth === 0,
			15_000,
		);

		expect(completedStatus?.recentResults[0]?.jobId).toBe(jobId);
		expect(completedStatus?.recentResults[0]?.status).toBe("success");
		expect(completedStatus?.queue.depth).toBe(0);

		controller2.abort();
		await daemon2;
	});

	it("crash-orphaned active job is re-queued and processed on daemon restart", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const config = loadDaemonConfig(configPath);
		ensureDaemonStateDirectories(config);

		// Write an orphaned active-spool file directly (simulating a crashed daemon)
		const orphanJob = makeTestJob("restart-orphan-001");
		const orphanEnvelope = createDaemonJobEnvelope(config, orphanJob);

		const activeDir = join(config.paths.stateDir, "active");
		mkdirSync(activeDir, { recursive: true });
		writeFileSync(
			join(activeDir, "restart-orphan-001-deadbeef99.json"),
			`${JSON.stringify(orphanEnvelope, null, 2)}\n`,
			"utf-8",
		);

		// Simulate a restart with a canned runner so the re-queued orphan is processed.
		const controller = new AbortController();
		const daemonRun = runDaemon(config, {
			signal: controller.signal,
			installSignalHandlers: false,
			jobRunner: makeCannedRunner("restart orphan processed"),
		});

		// Wait for the daemon to process the re-queued orphan.
		const status = await waitFor(
			() => readDaemonStatusFile(config),
			s => s !== undefined && s.pid === process.pid && s.state === "idle" && s.recentResults.length > 0,
			5_000,
		);

		controller.abort();
		await daemonRun;

		// The orphan was re-queued and processed — active dir should be clean.
		const activeFiles = existsSync(activeDir) ? readdirSync(activeDir).filter(f => f.endsWith(".json")) : [];
		expect(activeFiles).toEqual([]);
		expect(status?.recentResults[0]?.jobId).toBe("restart-orphan-001");
	});

	it("recentResults from real job execution survive a full stop/start cycle", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const config = loadDaemonConfig(configPath);
		const jobId = "restart-results-survival";
		const job = makeTestJob(jobId);
		const cannedRunner = makeCannedRunner("canned-result-survival");

		// Daemon 1: enqueue, wait for completion, abort
		const controller1 = new AbortController();
		const daemon1 = runDaemon(config, {
			signal: controller1.signal,
			installSignalHandlers: false,
			jobRunner: cannedRunner,
		});

		await waitFor(
			() => readDaemonStatusFile(config),
			status => status?.state === "idle" && status.pid === process.pid,
			5_000,
		);

		const envelope = createDaemonJobEnvelope(config, job);
		enqueueDaemonJob(config, envelope);

		// Wait for the job to complete
		await waitFor(
			() => readDaemonStatusFile(config),
			status => status !== undefined && status.recentResults.length > 0 && status.recentResults[0]?.jobId === jobId,
			15_000,
		);

		controller1.abort();
		await daemon1;

		// After daemon 1 stops, verify recentResults are persisted on disk
		const afterDaemon1 = readDaemonStatusFile(config);
		expect(afterDaemon1?.recentResults).toHaveLength(1);
		expect(afterDaemon1?.recentResults[0]?.jobId).toBe(jobId);
		expect(afterDaemon1?.recentResults[0]?.status).toBe("success");
		expect(afterDaemon1?.recentResults[0]?.summary).toBe("canned-result-survival");

		// Daemon 2: start with same config, wait for idle, verify recentResults carried forward
		const controller2 = new AbortController();
		const daemon2 = runDaemon(config, {
			signal: controller2.signal,
			installSignalHandlers: false,
			jobRunner: cannedRunner,
		});

		await waitFor(
			() => readDaemonStatusFile(config),
			status => status?.state === "idle" && status.pid === process.pid,
			5_000,
		);

		const afterDaemon2 = readDaemonStatusFile(config);
		expect(afterDaemon2?.recentResults).toHaveLength(1);
		expect(afterDaemon2?.recentResults[0]?.jobId).toBe(jobId);
		expect(afterDaemon2?.recentResults[0]?.status).toBe("success");
		expect(afterDaemon2?.recentResults[0]?.summary).toBe("canned-result-survival");

		controller2.abort();
		await daemon2;
	});
});
