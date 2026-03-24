import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArtifactPaths } from "../src/artifacts";
import {
	claimNextQueuedDaemonJob,
	DAEMON_JOB_ENVELOPE_VERSION_V1,
	type DaemonJobEnvelopeV1,
	DuplicateDaemonJobError,
	enqueueDaemonJob,
	ensureDaemonJobStoreDirectories,
	findDuplicateDaemonJobCollisions,
	getDaemonJobStorePaths,
	JOB_SPEC_VERSION_V1,
	listActiveDaemonJobs,
	listQueuedDaemonJobs,
	loadDaemonConfig,
	type NormalizedDaemonConfigV1,
	normalizeJobSpec,
	removeActiveDaemonJob,
	requeueOrphanedDaemonJob,
} from "../src/index";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempConfig(): NormalizedDaemonConfigV1 {
	const directory = mkdtempSync(join(tmpdir(), "fixbot-job-store-"));
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
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	return loadDaemonConfig(configPath);
}

function createEnvelope(config: NormalizedDaemonConfigV1, jobId: string, enqueuedAt: string): DaemonJobEnvelopeV1 {
	const artifactPaths = getArtifactPaths(config.paths.resultsDir, jobId);
	return {
		version: DAEMON_JOB_ENVELOPE_VERSION_V1,
		jobId,
		job: normalizeJobSpec(
			{
				version: JOB_SPEC_VERSION_V1,
				jobId,
				taskClass: "fix_ci",
				repo: {
					url: "https://github.com/example/repo.git",
					baseBranch: "main",
				},
				fixCi: {
					githubActionsRunId: 12345,
				},
				execution: {
					timeoutMs: 120_000,
					memoryLimitMb: 2048,
					sandbox: {
						mode: "workspace-write",
						networkAccess: true,
					},
				},
			},
			`job:${jobId}`,
		),
		submission: {
			kind: "cli",
			filePath: `/tmp/${jobId}.json`,
		},
		enqueuedAt,
		artifacts: {
			artifactDir: artifactPaths.artifactDir,
			resultFile: artifactPaths.resultFile,
		},
	};
}

describe("daemon job store", () => {
	it("derives deterministic queue layout from stateDir and writes queue files atomically", () => {
		const config = createTempConfig();
		const paths = ensureDaemonJobStoreDirectories(config);
		expect(paths).toEqual({
			stateDir: config.paths.stateDir,
			queueDir: join(config.paths.stateDir, "queue"),
			activeDir: join(config.paths.stateDir, "active"),
		});
		expect(getDaemonJobStorePaths(config)).toEqual(paths);

		const queued = enqueueDaemonJob(config, createEnvelope(config, "manual-job", "2026-03-16T08:00:00.000Z"));
		expect(queued.filePath.startsWith(paths.queueDir)).toBe(true);
		expect(queued.fileName).toMatch(/^20260316080000000--manual-job-[0-9a-f]{10}\.json$/);
		expect(readdirSync(paths.queueDir)).toEqual([queued.fileName]);
		expect(existsSync(join(paths.queueDir, `.tmp-${queued.fileName}`))).toBe(false);

		const stored = JSON.parse(readFileSync(queued.filePath, "utf-8")) as DaemonJobEnvelopeV1;
		expect(stored).toEqual(queued.envelope);
	});

	it("lists queued jobs in FIFO order using the envelope enqueue timestamp", () => {
		const config = createTempConfig();
		enqueueDaemonJob(config, createEnvelope(config, "job-late", "2026-03-16T08:00:02.000Z"));
		enqueueDaemonJob(config, createEnvelope(config, "job-early", "2026-03-16T08:00:01.000Z"));
		enqueueDaemonJob(config, createEnvelope(config, "job-middle", "2026-03-16T08:00:01.500Z"));

		const queued = listQueuedDaemonJobs(config);
		expect(queued.map(entry => entry.envelope.jobId)).toEqual(["job-early", "job-middle", "job-late"]);
	});

	it("claims the next queued job into active storage and removes it on terminal cleanup", () => {
		const config = createTempConfig();
		enqueueDaemonJob(config, createEnvelope(config, "job-a", "2026-03-16T08:00:00.000Z"));
		enqueueDaemonJob(config, createEnvelope(config, "job-b", "2026-03-16T08:00:01.000Z"));

		const claimed = claimNextQueuedDaemonJob(config);
		expect(claimed).not.toBeNull();
		expect(claimed?.envelope.jobId).toBe("job-a");
		expect(existsSync(claimed?.queueFilePath ?? "")).toBe(false);
		expect(existsSync(claimed?.filePath ?? "")).toBe(true);
		expect(listQueuedDaemonJobs(config).map(entry => entry.envelope.jobId)).toEqual(["job-b"]);
		expect(listActiveDaemonJobs(config).map(entry => entry.envelope.jobId)).toEqual(["job-a"]);
		expect(removeActiveDaemonJob(config, "job-a")).toBe(true);
		expect(removeActiveDaemonJob(config, "job-a")).toBe(false);
		expect(listActiveDaemonJobs(config)).toEqual([]);
	});

	it("rejects duplicate job ids across queued, active, and finished artifacts", () => {
		const queuedConfig = createTempConfig();
		enqueueDaemonJob(queuedConfig, createEnvelope(queuedConfig, "duplicate-job", "2026-03-16T08:00:00.000Z"));
		expect(() =>
			enqueueDaemonJob(queuedConfig, createEnvelope(queuedConfig, "duplicate-job", "2026-03-16T08:00:05.000Z")),
		).toThrow(DuplicateDaemonJobError);
		const queuedError = expectDuplicateError(() =>
			enqueueDaemonJob(queuedConfig, createEnvelope(queuedConfig, "duplicate-job", "2026-03-16T08:00:05.000Z")),
		);
		expect(queuedError.collisions.map(collision => collision.kind)).toContain("queue");

		const activeConfig = createTempConfig();
		enqueueDaemonJob(activeConfig, createEnvelope(activeConfig, "duplicate-job", "2026-03-16T08:00:00.000Z"));
		claimNextQueuedDaemonJob(activeConfig);
		const activeError = expectDuplicateError(() =>
			enqueueDaemonJob(activeConfig, createEnvelope(activeConfig, "duplicate-job", "2026-03-16T08:00:05.000Z")),
		);
		expect(activeError.collisions.map(collision => collision.kind)).toContain("active");
		expect(
			findDuplicateDaemonJobCollisions(activeConfig, "duplicate-job").map(collision => collision.kind),
		).toContain("active");

		const artifactConfig = createTempConfig();
		const artifactPaths = getArtifactPaths(artifactConfig.paths.resultsDir, "duplicate-job");
		mkdirSync(artifactPaths.artifactDir, { recursive: true });
		writeFileSync(artifactPaths.resultFile, "{}\n", "utf-8");
		const artifactError = expectDuplicateError(() =>
			enqueueDaemonJob(artifactConfig, createEnvelope(artifactConfig, "duplicate-job", "2026-03-16T08:00:05.000Z")),
		);
		expect(artifactError.collisions.map(collision => collision.kind)).toEqual(["result-file", "artifact-dir"]);
	});

	it("re-queues an orphaned active job back to the queue with original timestamp", () => {
		const config = createTempConfig();
		const originalEnqueuedAt = "2026-03-16T08:00:00.000Z";
		const envelope = createEnvelope(config, "orphan-requeue-test", originalEnqueuedAt);

		// Enqueue and claim the job to move it to active/.
		enqueueDaemonJob(config, envelope);
		const claimed = claimNextQueuedDaemonJob(config);
		expect(claimed).not.toBeNull();
		expect(listActiveDaemonJobs(config).length).toBe(1);
		expect(listQueuedDaemonJobs(config).length).toBe(0);

		// Re-queue the orphan.
		const orphan = listActiveDaemonJobs(config)[0];
		const action = requeueOrphanedDaemonJob(config, orphan);
		expect(action).toBe("requeued");

		// Active should be empty, queue should have the job back.
		expect(listActiveDaemonJobs(config).length).toBe(0);
		const queued = listQueuedDaemonJobs(config);
		expect(queued.length).toBe(1);
		expect(queued[0].envelope.jobId).toBe("orphan-requeue-test");
		expect(queued[0].envelope.enqueuedAt).toBe(originalEnqueuedAt);
	});

	it("cleans up an orphan whose result artifacts already exist instead of re-queuing", () => {
		const config = createTempConfig();
		const envelope = createEnvelope(config, "orphan-completed", "2026-03-16T08:00:00.000Z");

		// Enqueue and claim the job.
		enqueueDaemonJob(config, envelope);
		claimNextQueuedDaemonJob(config);
		expect(listActiveDaemonJobs(config).length).toBe(1);

		// Simulate that the job completed by writing a result file.
		const artifactPaths = getArtifactPaths(config.paths.resultsDir, "orphan-completed");
		mkdirSync(artifactPaths.artifactDir, { recursive: true });
		writeFileSync(artifactPaths.resultFile, "{}\n", "utf-8");

		// Re-queue should detect the result and clean up instead.
		const orphan = listActiveDaemonJobs(config)[0];
		const action = requeueOrphanedDaemonJob(config, orphan);
		expect(action).toBe("cleaned");

		// Active should be empty, queue should also be empty (not re-queued).
		expect(listActiveDaemonJobs(config).length).toBe(0);
		expect(listQueuedDaemonJobs(config).length).toBe(0);
	});
});

function expectDuplicateError(action: () => unknown): DuplicateDaemonJobError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(DuplicateDaemonJobError);
		return error as DuplicateDaemonJobError;
	}
	throw new Error("Expected DuplicateDaemonJobError to be thrown");
}
