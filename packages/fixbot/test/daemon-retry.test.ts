import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { getArtifactPaths } from "../src/artifacts";
import { normalizeJobSpec } from "../src/contracts";
import {
	DAEMON_JOB_ENVELOPE_VERSION_V1,
	type DaemonJobEnvelopeV1,
	type FailureClassification,
	type JobResultV1,
	type NormalizedDaemonConfigV1,
	type NormalizedJobSpecV1,
} from "../src/types";
import { loadDaemonConfig } from "../src/config";
import {
	classifyJobFailure,
	computeBackoffMs,
	buildRetryEnvelope,
	isSuccessWithChanges,
	handleJobFailure,
	DEFAULT_MAX_RETRIES,
	DEFAULT_BACKOFF_SCHEDULE_MS,
} from "../src/daemon/retry";
import {
	claimNextQueuedDaemonJob,
	enqueueDaemonJob,
	ensureDaemonJobStoreDirectories,
	listQueuedDaemonJobs,
} from "../src/daemon/job-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempConfig(): NormalizedDaemonConfigV1 {
	const directory = mkdtempSync(join(tmpdir(), "fixbot-retry-"));
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

function makeEnvelope(config: NormalizedDaemonConfigV1, jobId: string, overrides?: Partial<DaemonJobEnvelopeV1>): DaemonJobEnvelopeV1 {
	const job = makeTestJob(jobId);
	const artifactPaths = getArtifactPaths(config.paths.resultsDir, jobId);
	return {
		version: DAEMON_JOB_ENVELOPE_VERSION_V1,
		jobId,
		job,
		submission: { kind: "cli" },
		enqueuedAt: new Date().toISOString(),
		artifacts: {
			artifactDir: artifactPaths.artifactDir,
			resultFile: artifactPaths.resultFile,
		},
		retryCount: 0,
		maxRetries: DEFAULT_MAX_RETRIES,
		...overrides,
	};
}

function makeResult(jobId: string, status: "success" | "failed" | "timeout", changedFileCount: number): JobResultV1 {
	return {
		version: "fixbot.result/v1" as const,
		jobId,
		taskClass: "fix_ci" as const,
		status,
		summary: `test summary for ${jobId}`,
		failureReason: status === "failed" ? "test failure reason" : undefined,
		repo: { url: "https://github.com/example/repo.git", baseBranch: "main" },
		fixCi: { githubActionsRunId: 99001 },
		execution: {
			mode: "process" as const,
			timeoutMs: 120_000,
			memoryLimitMb: 2_048,
			sandbox: { mode: "workspace-write" as const, networkAccess: true },
			workspaceDir: "/tmp/test-workspace",
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			durationMs: 1000,
		},
		artifacts: {
			resultFile: `/tmp/results/job-${jobId}.json`,
			rootDir: `/tmp/results/job-${jobId}`,
			jobSpecFile: "spec.json",
			patchFile: "patch.diff",
			traceFile: "trace.json",
			assistantFinalFile: "assistant.md",
		},
		diagnostics: {
			patchSha256: "0000",
			changedFileCount,
			markers: { result: true, summary: true, failureReason: status === "failed" },
		},
	};
}

// ---------------------------------------------------------------------------
// classifyJobFailure
// ---------------------------------------------------------------------------

describe("classifyJobFailure", () => {
	it("classifies reporter failure when result is success-with-changes and reporter threw", () => {
		const result = makeResult("job-1", "success", 3);
		const reporterError = new Error("push failed");
		expect(classifyJobFailure(result, reporterError)).toBe("reporter");
	});

	it("classifies agent failure when result exists but is not success-with-changes", () => {
		const result = makeResult("job-1", "failed", 0);
		expect(classifyJobFailure(result, undefined)).toBe("agent");
	});

	it("classifies agent failure when result is success but no changes", () => {
		const result = makeResult("job-1", "success", 0);
		const reporterError = new Error("push failed");
		expect(classifyJobFailure(result, reporterError)).toBe("agent");
	});

	it("classifies unknown when no result is provided", () => {
		const error = new Error("runner crashed");
		expect(classifyJobFailure(undefined, error)).toBe("unknown");
	});
});

// ---------------------------------------------------------------------------
// isSuccessWithChanges
// ---------------------------------------------------------------------------

describe("isSuccessWithChanges", () => {
	it("returns true for success with changed files", () => {
		expect(isSuccessWithChanges(makeResult("j", "success", 5))).toBe(true);
	});

	it("returns false for success with zero changed files", () => {
		expect(isSuccessWithChanges(makeResult("j", "success", 0))).toBe(false);
	});

	it("returns false for failed result", () => {
		expect(isSuccessWithChanges(makeResult("j", "failed", 3))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// computeBackoffMs
// ---------------------------------------------------------------------------

describe("computeBackoffMs", () => {
	it("returns first schedule entry for retry 0 with deterministic random", () => {
		const ms = computeBackoffMs(0, DEFAULT_BACKOFF_SCHEDULE_MS, () => 0.5);
		// jitter = 1 + (0.5*2 - 1)*0.2 = 1.0, so exact base
		expect(ms).toBe(2 * 60 * 1_000);
	});

	it("returns second schedule entry for retry 1", () => {
		const ms = computeBackoffMs(1, DEFAULT_BACKOFF_SCHEDULE_MS, () => 0.5);
		expect(ms).toBe(10 * 60 * 1_000);
	});

	it("returns third schedule entry for retry 2", () => {
		const ms = computeBackoffMs(2, DEFAULT_BACKOFF_SCHEDULE_MS, () => 0.5);
		expect(ms).toBe(30 * 60 * 1_000);
	});

	it("clamps to last schedule entry for retry beyond schedule length", () => {
		const ms = computeBackoffMs(10, DEFAULT_BACKOFF_SCHEDULE_MS, () => 0.5);
		expect(ms).toBe(30 * 60 * 1_000);
	});

	it("applies jitter within +-20%", () => {
		// randomFn = 0 → jitter = 1 + (0 - 1)*0.2 = 0.8
		const low = computeBackoffMs(0, DEFAULT_BACKOFF_SCHEDULE_MS, () => 0);
		expect(low).toBe(Math.round(2 * 60 * 1_000 * 0.8));

		// randomFn = 1 → jitter = 1 + (1)*0.2 = 1.2
		const high = computeBackoffMs(0, DEFAULT_BACKOFF_SCHEDULE_MS, () => 1);
		expect(high).toBe(Math.round(2 * 60 * 1_000 * 1.2));
	});
});

// ---------------------------------------------------------------------------
// buildRetryEnvelope
// ---------------------------------------------------------------------------

describe("buildRetryEnvelope", () => {
	it("builds a reporter-only retry that reuses the same job ID and artifacts", () => {
		const config = createTempConfig();
		const original = makeEnvelope(config, "test-job-001");
		const retry = buildRetryEnvelope(
			original,
			"reporter",
			"push failed",
			config,
			"2026-01-01T00:00:00.000Z",
			120_000,
		);

		expect(retry.jobId).toBe("test-job-001");
		expect(retry.retryCount).toBe(1);
		expect(retry.lastFailureReason).toBe("push failed");
		expect(retry.lastFailureClassification).toBe("reporter");
		expect(retry.originalJobId).toBe("test-job-001");
		expect(retry.artifacts).toEqual(original.artifacts);
		expect(retry.nextRetryAt).toBe("2026-01-01T00:02:00.000Z");
	});

	it("builds an agent retry with a new job ID and fresh artifact paths", () => {
		const config = createTempConfig();
		const original = makeEnvelope(config, "test-job-002");
		const retry = buildRetryEnvelope(
			original,
			"agent",
			"runner crashed",
			config,
			"2026-01-01T00:00:00.000Z",
			600_000,
		);

		expect(retry.jobId).toBe("test-job-002--retry-1");
		expect(retry.retryCount).toBe(1);
		expect(retry.lastFailureReason).toBe("runner crashed");
		expect(retry.lastFailureClassification).toBe("agent");
		expect(retry.originalJobId).toBe("test-job-002");
		// Artifact paths should be different from original
		expect(retry.artifacts.artifactDir).not.toBe(original.artifacts.artifactDir);
		expect(retry.artifacts.resultFile).not.toBe(original.artifacts.resultFile);
		expect(retry.nextRetryAt).toBe("2026-01-01T00:10:00.000Z");
	});

	it("preserves originalJobId across multiple retries", () => {
		const config = createTempConfig();
		const original = makeEnvelope(config, "test-job-003");
		const retry1 = buildRetryEnvelope(original, "agent", "fail 1", config, "2026-01-01T00:00:00.000Z", 120_000);
		const retry2 = buildRetryEnvelope(retry1, "agent", "fail 2", config, "2026-01-01T00:05:00.000Z", 120_000);

		expect(retry2.originalJobId).toBe("test-job-003");
		expect(retry2.retryCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// handleJobFailure
// ---------------------------------------------------------------------------

describe("handleJobFailure", () => {
	it("enqueues a retry when retries remain", () => {
		const config = createTempConfig();
		ensureDaemonJobStoreDirectories(config);
		const envelope = makeEnvelope(config, "retry-test-001");

		const result = handleJobFailure(
			envelope,
			makeResult("retry-test-001", "failed", 0),
			undefined,
			config,
		);

		expect(result.retried).toBe(true);
		expect(result.classification).toBe("agent");
		expect(result.retryCount).toBe(1);

		const queued = listQueuedDaemonJobs(config);
		expect(queued.length).toBe(1);
		expect(queued[0]!.envelope.originalJobId).toBe("retry-test-001");
	});

	it("does not retry when retries are exhausted", () => {
		const config = createTempConfig();
		ensureDaemonJobStoreDirectories(config);
		const envelope = makeEnvelope(config, "exhausted-001", {
			retryCount: 3,
			maxRetries: 3,
		});

		const result = handleJobFailure(
			envelope,
			makeResult("exhausted-001", "failed", 0),
			undefined,
			config,
		);

		expect(result.retried).toBe(false);
		expect(result.retryCount).toBe(3);
		expect(result.maxRetries).toBe(3);

		const queued = listQueuedDaemonJobs(config);
		expect(queued.length).toBe(0);
	});

	it("logs messages during retry", () => {
		const config = createTempConfig();
		ensureDaemonJobStoreDirectories(config);
		const envelope = makeEnvelope(config, "log-test-001");
		const logMessages: string[] = [];

		handleJobFailure(
			envelope,
			undefined,
			new Error("boom"),
			config,
			(msg) => logMessages.push(msg),
		);

		expect(logMessages.some((m) => m.includes("retry"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Claim gating: claimNextQueuedDaemonJob skips jobs with future nextRetryAt
// ---------------------------------------------------------------------------

describe("claim gating for retry backoff", () => {
	it("skips a job whose nextRetryAt is in the future", () => {
		const config = createTempConfig();
		ensureDaemonJobStoreDirectories(config);

		const futureTime = new Date(Date.now() + 60_000).toISOString();
		const envelope = makeEnvelope(config, "future-retry-001", {
			nextRetryAt: futureTime,
		});
		enqueueDaemonJob(config, envelope);

		const claimed = claimNextQueuedDaemonJob(config);
		expect(claimed).toBeNull();

		// The job is still in the queue
		expect(listQueuedDaemonJobs(config).length).toBe(1);
	});

	it("claims a job whose nextRetryAt is in the past", () => {
		const config = createTempConfig();
		ensureDaemonJobStoreDirectories(config);

		const pastTime = new Date(Date.now() - 60_000).toISOString();
		const envelope = makeEnvelope(config, "past-retry-001", {
			nextRetryAt: pastTime,
		});
		enqueueDaemonJob(config, envelope);

		const claimed = claimNextQueuedDaemonJob(config);
		expect(claimed).not.toBeNull();
		expect(claimed!.envelope.jobId).toBe("past-retry-001");
	});

	it("claims a job with no nextRetryAt (normal non-retry job)", () => {
		const config = createTempConfig();
		ensureDaemonJobStoreDirectories(config);

		const envelope = makeEnvelope(config, "normal-001");
		delete envelope.nextRetryAt;
		enqueueDaemonJob(config, envelope);

		const claimed = claimNextQueuedDaemonJob(config);
		expect(claimed).not.toBeNull();
	});

	it("treats invalid nextRetryAt as ready (defensive)", () => {
		const config = createTempConfig();
		ensureDaemonJobStoreDirectories(config);

		const envelope = makeEnvelope(config, "bad-timestamp-001", {
			nextRetryAt: "not-a-valid-timestamp",
		});
		enqueueDaemonJob(config, envelope);

		const claimed = claimNextQueuedDaemonJob(config);
		expect(claimed).not.toBeNull();
	});

	it("claims a ready job while skipping a not-yet-eligible one", () => {
		const config = createTempConfig();
		ensureDaemonJobStoreDirectories(config);

		// Enqueue a future-retry job first (older enqueuedAt)
		const futureEnvelope = makeEnvelope(config, "future-002", {
			nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
			enqueuedAt: "2026-01-01T00:00:00.000Z",
		});
		// Fix job and artifacts for the future envelope
		const futureArtifacts = getArtifactPaths(config.paths.resultsDir, "future-002");
		futureEnvelope.artifacts = {
			artifactDir: futureArtifacts.artifactDir,
			resultFile: futureArtifacts.resultFile,
		};
		enqueueDaemonJob(config, futureEnvelope);

		// Enqueue a ready job second (newer enqueuedAt)
		const readyEnvelope = makeEnvelope(config, "ready-002", {
			enqueuedAt: "2026-01-01T00:01:00.000Z",
		});
		delete readyEnvelope.nextRetryAt;
		const readyArtifacts = getArtifactPaths(config.paths.resultsDir, "ready-002");
		readyEnvelope.artifacts = {
			artifactDir: readyArtifacts.artifactDir,
			resultFile: readyArtifacts.resultFile,
		};
		enqueueDaemonJob(config, readyEnvelope);

		const claimed = claimNextQueuedDaemonJob(config);
		expect(claimed).not.toBeNull();
		expect(claimed!.envelope.jobId).toBe("ready-002");

		// Future job is still in queue
		expect(listQueuedDaemonJobs(config).length).toBe(1);
		expect(listQueuedDaemonJobs(config)[0]!.envelope.jobId).toBe("future-002");
	});
});
