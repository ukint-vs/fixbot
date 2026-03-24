import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getArtifactPaths } from "../src/artifacts";
import { createDaemonStatus, normalizeDaemonStatus } from "../src/config";
import { enqueueDaemonJobFromFile } from "../src/daemon/enqueue";
import { readDaemonStatusFile, writeDaemonStatusFile } from "../src/daemon/status-store";
import {
	createDaemonStatusSnapshot,
	type DaemonJobRunner,
	ensureDaemonStateDirectories,
	getDaemonHeartbeatAgeMs,
	getDaemonStatusFromConfigFile,
	JOB_RESULT_VERSION_V1,
	type JobResultV1,
	loadDaemonConfig,
	type NormalizedDaemonConfigV1,
	type NormalizedJobSpecV1,
	renderDaemonStatus,
	runDaemon,
} from "../src/index";

const temporaryDirectories: string[] = [];
const foregroundDaemonStops: Array<() => Promise<void>> = [];
const validFixtureJobPath = resolve(process.cwd(), "test/fixtures/jobs/manual-enqueue.valid.json");

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
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
	const directory = mkdtempSync(join(tmpdir(), "fixbot-status-"));
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

function createFakeJobResult(job: NormalizedJobSpecV1, resultsDir: string, summary: string): JobResultV1 {
	const startedAt = new Date().toISOString();
	const finishedAt = new Date(Date.now() + 5).toISOString();
	const paths = getArtifactPaths(resultsDir, job.jobId);
	mkdirSync(paths.artifactDir, { recursive: true });
	writeFileSync(paths.resultFile, "{}\n", "utf-8");
	return {
		version: JOB_RESULT_VERSION_V1,
		jobId: job.jobId,
		taskClass: job.taskClass,
		status: "success",
		summary,
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
				failureReason: false,
			},
		},
	};
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
		status => status?.state === "idle" && status.pid === process.pid,
		5_000,
	);
	expect(readyStatus?.state).toBe("idle");

	return { config, stop };
}

describe("daemon status contract", () => {
	it("persists the stable S01 status payload and renders the same core fields", () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 500,
			idleSleepMs: 100,
		});
		const config = loadDaemonConfig(configPath);
		ensureDaemonStateDirectories(config);

		const status = createDaemonStatus(config, {
			state: "running",
			pid: 4321,
			startedAt: "2026-03-16T08:00:00.000Z",
			heartbeatAt: "2026-03-16T08:00:05.000Z",
			lastTransitionAt: "2026-03-16T08:00:06.000Z",
			lastError: {
				message: "runner seam reported a warning",
				at: "2026-03-16T08:00:06.500Z",
				code: "RUNNER_WARN",
			},
			queue: {
				depth: 3,
				preview: [
					{
						jobId: "job-124",
						enqueuedAt: "2026-03-16T08:00:06.250Z",
						submission: {
							kind: "cli",
						},
						artifactDir: join(config.paths.resultsDir, "job-124"),
					},
					{
						jobId: "job-125",
						enqueuedAt: "2026-03-16T08:00:06.750Z",
						submission: {
							kind: "cli",
							filePath: "/tmp/job-125.json",
						},
						artifactDir: join(config.paths.resultsDir, "job-125"),
					},
				],
				previewTruncated: true,
			},
			activeJob: {
				jobId: "job-123",
				state: "running",
				enqueuedAt: "2026-03-16T08:00:01.000Z",
				startedAt: "2026-03-16T08:00:04.000Z",
				artifactDir: join(config.paths.resultsDir, "job-123"),
			},
			recentResults: [
				{
					jobId: "job-122",
					status: "success",
					finishedAt: "2026-03-16T07:59:59.000Z",
					enqueuedAt: "2026-03-16T07:59:50.000Z",
					startedAt: "2026-03-16T07:59:52.000Z",
					summary: "fixed flaky CI step",
					resultFile: join(config.paths.resultsDir, "job-122.json"),
				},
			],
		});

		writeDaemonStatusFile(config, {
			status,
			pretty: false,
		});

		const persisted = readDaemonStatusFile(config);
		expect(persisted).toEqual(status);

		const raw = JSON.parse(readFileSync(config.paths.statusFile, "utf-8")) as Record<string, unknown>;
		expect(Object.keys(raw)).toEqual([
			"version",
			"state",
			"pid",
			"startedAt",
			"heartbeatAt",
			"lastTransitionAt",
			"paths",
			"lastError",
			"queue",
			"activeJob",
			"recentResults",
		]);
		expect(raw.queue).toEqual({
			depth: 3,
			preview: [
				{
					jobId: "job-124",
					enqueuedAt: "2026-03-16T08:00:06.250Z",
					submission: {
						kind: "cli",
					},
					artifactDir: join(config.paths.resultsDir, "job-124"),
				},
				{
					jobId: "job-125",
					enqueuedAt: "2026-03-16T08:00:06.750Z",
					submission: {
						kind: "cli",
						filePath: "/tmp/job-125.json",
					},
					artifactDir: join(config.paths.resultsDir, "job-125"),
				},
			],
			previewTruncated: true,
		});
		expect(raw.activeJob).toMatchObject({
			jobId: "job-123",
			state: "running",
			enqueuedAt: "2026-03-16T08:00:01.000Z",
		});
		expect(raw.recentResults).toEqual([
			{
				jobId: "job-122",
				status: "success",
				finishedAt: "2026-03-16T07:59:59.000Z",
				enqueuedAt: "2026-03-16T07:59:50.000Z",
				startedAt: "2026-03-16T07:59:52.000Z",
				summary: "fixed flaky CI step",
				resultFile: join(config.paths.resultsDir, "job-122.json"),
			},
		]);

		const snapshot = createDaemonStatusSnapshot(status, Date.parse("2026-03-16T08:00:08.250Z"));
		expect(snapshot).toEqual({
			version: "fixbot.daemon-status/v1",
			state: "running",
			pid: 4321,
			startedAt: "2026-03-16T08:00:00.000Z",
			heartbeatAt: "2026-03-16T08:00:05.000Z",
			heartbeatAgeMs: 3_250,
			lastTransitionAt: "2026-03-16T08:00:06.000Z",
			paths: config.paths,
			lastError: {
				message: "runner seam reported a warning",
				at: "2026-03-16T08:00:06.500Z",
				code: "RUNNER_WARN",
			},
			queue: {
				depth: 3,
				preview: [
					{
						jobId: "job-124",
						enqueuedAt: "2026-03-16T08:00:06.250Z",
						submission: {
							kind: "cli",
						},
						artifactDir: join(config.paths.resultsDir, "job-124"),
					},
					{
						jobId: "job-125",
						enqueuedAt: "2026-03-16T08:00:06.750Z",
						submission: {
							kind: "cli",
							filePath: "/tmp/job-125.json",
						},
						artifactDir: join(config.paths.resultsDir, "job-125"),
					},
				],
				previewTruncated: true,
			},
			activeJob: {
				jobId: "job-123",
				state: "running",
				enqueuedAt: "2026-03-16T08:00:01.000Z",
				startedAt: "2026-03-16T08:00:04.000Z",
				artifactDir: join(config.paths.resultsDir, "job-123"),
			},
			recentResults: [
				{
					jobId: "job-122",
					status: "success",
					finishedAt: "2026-03-16T07:59:59.000Z",
					enqueuedAt: "2026-03-16T07:59:50.000Z",
					startedAt: "2026-03-16T07:59:52.000Z",
					summary: "fixed flaky CI step",
					resultFile: join(config.paths.resultsDir, "job-122.json"),
				},
			],
		});
		expect(getDaemonHeartbeatAgeMs(status, Date.parse("2026-03-16T08:00:08.250Z"))).toBe(3_250);

		const rendered = renderDaemonStatus(status, [], Date.parse("2026-03-16T08:00:08.250Z"));
		expect(rendered).toContain("State: running");
		expect(rendered).toContain("PID: 4321");
		expect(rendered).toContain("Heartbeat age ms: 3250");
		expect(rendered).toContain(`State dir: ${config.paths.stateDir}`);
		expect(rendered).toContain(`Results dir: ${config.paths.resultsDir}`);
		expect(rendered).toContain("Queue depth: 3");
		expect(rendered).toContain("Queue preview: 2 shown of 3");
		expect(rendered).toContain("Queued job 1: job-124 enqueued=2026-03-16T08:00:06.250Z");
		expect(rendered).toContain("Queued job 2: job-125 enqueued=2026-03-16T08:00:06.750Z");
		expect(rendered).toContain(
			"Active job: job-123 (running) enqueued=2026-03-16T08:00:01.000Z started=2026-03-16T08:00:04.000Z",
		);
		expect(rendered).toContain("Recent results: 1");
		expect(rendered).toContain(
			"Recent result 1: job-122 success finished=2026-03-16T07:59:59.000Z enqueued=2026-03-16T07:59:50.000Z started=2026-03-16T07:59:52.000Z summary=fixed flaky CI step",
		);
		expect(rendered).toContain("Last error: [RUNNER_WARN] runner seam reported a warning @ 2026-03-16T08:00:06.500Z");
	});

	it("normalizes older status payloads without queue previews into the forward-compatible shape", () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 500,
			idleSleepMs: 100,
		});
		const config = loadDaemonConfig(configPath);

		const normalized = normalizeDaemonStatus({
			version: "fixbot.daemon-status/v1",
			state: "idle",
			pid: 4321,
			startedAt: "2026-03-16T08:00:00.000Z",
			heartbeatAt: "2026-03-16T08:00:05.000Z",
			lastTransitionAt: "2026-03-16T08:00:06.000Z",
			paths: config.paths,
			queue: {
				depth: 2,
			},
			activeJob: null,
			recentResults: [],
		});

		expect(normalized.queue).toEqual({
			depth: 2,
			preview: [],
			previewTruncated: false,
		});
		expect(renderDaemonStatus(normalized)).toContain("Queue preview: none recorded");
	});

	it("publishes default queue and job slots from a live daemon without changing core fields", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});

		const daemon = await startForegroundDaemon(configPath, async (job, options) =>
			createFakeJobResult(job, options.resultsDir, "unused"),
		);
		const { status, issues } = await getDaemonStatusFromConfigFile(configPath);
		const snapshot = createDaemonStatusSnapshot(status);

		expect(issues).toEqual([]);
		expect(status.state).toBe("idle");
		expect(status.pid).toBe(process.pid);
		expect(status.paths.stateDir).toBe(daemon.config.paths.stateDir);
		expect(status.paths.resultsDir).toBe(daemon.config.paths.resultsDir);
		expect(status.queue).toEqual({
			depth: 0,
			preview: [],
			previewTruncated: false,
		});
		expect(status.activeJob).toBeNull();
		expect(status.recentResults).toEqual([]);
		expect(snapshot.heartbeatAgeMs).not.toBeNull();
		expect(snapshot.heartbeatAgeMs).toBeGreaterThanOrEqual(0);

		const rendered = renderDaemonStatus(status, issues);
		expect(rendered).toContain("State: idle");
		expect(rendered).toContain(`PID: ${process.pid}`);
		expect(rendered).toContain(`State dir: ${daemon.config.paths.stateDir}`);
		expect(rendered).toContain(`Results dir: ${daemon.config.paths.resultsDir}`);
		expect(rendered).toContain("Queue depth: 0");
		expect(rendered).toContain("Active job: none");
		expect(rendered).toContain("Recent results: 0");
	});

	it("shows running active work and preserves recent failure details after the runner rejects", async () => {
		const configPath = createTempConfig({
			heartbeatIntervalMs: 75,
			idleSleepMs: 20,
		});
		const runnerStarted = createDeferred<void>();
		const allowRunnerToFail = createDeferred<void>();
		const daemon = await startForegroundDaemon(configPath, async () => {
			runnerStarted.resolve();
			await allowRunnerToFail.promise;
			throw new Error("fake runner exploded");
		});

		await enqueueDaemonJobFromFile(configPath, validFixtureJobPath);
		await runnerStarted.promise;
		const runningStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			status => status?.state === "running" && status.activeJob?.jobId === "manual-enqueue-job",
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
		});

		allowRunnerToFail.resolve();
		const failedStatus = await waitFor(
			() => readDaemonStatusFile(daemon.config),
			status =>
				status?.state === "idle" &&
				status.activeJob === null &&
				status.recentResults[0]?.jobId === "manual-enqueue-job",
			5_000,
		);
		const artifactPaths = getArtifactPaths(daemon.config.paths.resultsDir, "manual-enqueue-job");
		expect(failedStatus?.queue).toEqual({
			depth: 0,
			preview: [],
			previewTruncated: false,
		});
		expect(failedStatus?.lastError).toMatchObject({
			code: "JOB_RUNNER_ERROR",
			message: "job manual-enqueue-job failed: fake runner exploded",
		});
		expect(failedStatus?.recentResults[0]).toMatchObject({
			jobId: "manual-enqueue-job",
			status: "failed",
			summary: "daemon runner failed before producing a result",
			failureReason: "fake runner exploded",
			resultFile: artifactPaths.resultFile,
			artifactDir: artifactPaths.artifactDir,
		});

		expect(failedStatus).toBeDefined();
		const rendered = renderDaemonStatus(failedStatus!, []);
		expect(rendered).toContain("State: idle");
		expect(rendered).toContain("Active job: none");
		expect(rendered).toContain("Recent results: 1");
		expect(rendered).toContain("Recent result 1: manual-enqueue-job failed");
		expect(rendered).toContain("failure=fake runner exploded");
		expect(rendered).toContain("Last error: [JOB_RUNNER_ERROR] job manual-enqueue-job failed: fake runner exploded");
		expect(existsSync(artifactPaths.resultFile)).toBe(false);
	});
});
