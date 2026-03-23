import { getArtifactPaths } from "../artifacts";
import type {
	DaemonJobEnvelopeV1,
	FailureClassification,
	JobResultV1,
	NormalizedDaemonConfigV1,
} from "../types";
import { DAEMON_JOB_ENVELOPE_VERSION_V1 } from "../types";
import { enqueueDaemonJob } from "./job-store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_RETRIES = 3;

/** Backoff schedule in milliseconds: 2 min, 10 min, 30 min. */
export const DEFAULT_BACKOFF_SCHEDULE_MS: readonly number[] = [
	2 * 60 * 1_000,
	10 * 60 * 1_000,
	30 * 60 * 1_000,
];

/** +-20% jitter factor applied to each backoff delay. */
const JITTER_FACTOR = 0.2;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Classify a job failure so the retry handler knows whether to retry the
 * reporter only (reuse existing artifacts) or the full agent pipeline.
 *
 * "reporter" — a result exists with changes but no PR was created (reporter threw).
 * "agent"    — the job runner itself failed or the result indicates failure.
 * "unknown"  — cannot determine; treat as agent failure for retry purposes.
 */
export function classifyJobFailure(
	result: JobResultV1 | undefined,
	reporterError: Error | undefined,
): FailureClassification {
	if (result && isSuccessWithChanges(result) && reporterError) {
		return "reporter";
	}
	if (result) {
		return "agent";
	}
	return "unknown";
}

/**
 * Returns true when the result represents a successful job that produced
 * file changes (i.e. a PR should have been opened).
 */
export function isSuccessWithChanges(result: JobResultV1): boolean {
	return result.status === "success" && result.diagnostics.changedFileCount > 0;
}

/**
 * Compute the backoff delay in milliseconds for a given retry attempt,
 * applying +-20% jitter. The schedule is clamped so attempts beyond the
 * schedule length use the last entry.
 */
export function computeBackoffMs(
	retryCount: number,
	schedule: readonly number[] = DEFAULT_BACKOFF_SCHEDULE_MS,
	randomFn: () => number = Math.random,
): number {
	const index = Math.min(retryCount, schedule.length - 1);
	const baseMs = schedule[index] ?? schedule[schedule.length - 1]!;
	// jitter in [-JITTER_FACTOR, +JITTER_FACTOR]
	const jitter = 1 + (randomFn() * 2 - 1) * JITTER_FACTOR;
	return Math.round(baseMs * jitter);
}

/**
 * Build a retry envelope from the original envelope, bumping the retry
 * count and setting the next eligible claim time.
 *
 * For reporter-only retries the artifact paths are preserved (the agent
 * output is reused). For agent retries a new job ID is minted and fresh
 * artifact paths are computed.
 */
export function buildRetryEnvelope(
	original: DaemonJobEnvelopeV1,
	classification: FailureClassification,
	failureReason: string,
	config: Pick<NormalizedDaemonConfigV1, "paths">,
	nowIso?: string,
	backoffMs?: number,
): DaemonJobEnvelopeV1 {
	const now = nowIso ?? new Date().toISOString();
	const currentRetry = (original.retryCount ?? 0) + 1;
	const delayMs = backoffMs ?? computeBackoffMs(currentRetry - 1);
	const nextRetryAt = new Date(Date.parse(now) + delayMs).toISOString();
	const originalJobId = original.originalJobId ?? original.jobId;

	if (classification === "reporter") {
		// Reporter-only retry: reuse job ID and artifact paths.
		return {
			...original,
			retryCount: currentRetry,
			nextRetryAt,
			lastFailureReason: failureReason,
			lastFailureClassification: classification,
			originalJobId,
			enqueuedAt: now,
		};
	}

	// Agent retry: new job ID, fresh artifact paths.
	const retryJobId = `${originalJobId}--retry-${currentRetry}`;
	const retryJob = { ...original.job, jobId: retryJobId };
	const artifactPaths = getArtifactPaths(config.paths.resultsDir, retryJobId);

	return {
		version: DAEMON_JOB_ENVELOPE_VERSION_V1,
		jobId: retryJobId,
		job: retryJob,
		submission: original.submission,
		enqueuedAt: now,
		artifacts: {
			artifactDir: artifactPaths.artifactDir,
			resultFile: artifactPaths.resultFile,
		},
		retryCount: currentRetry,
		maxRetries: original.maxRetries ?? DEFAULT_MAX_RETRIES,
		nextRetryAt,
		lastFailureReason: failureReason,
		lastFailureClassification: classification,
		originalJobId,
	};
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface HandleJobFailureResult {
	retried: boolean;
	classification: FailureClassification;
	retryCount: number;
	maxRetries: number;
	failureReason: string;
}

/**
 * Decide whether a failed job should be retried, build the retry envelope,
 * and enqueue it. Returns metadata about the decision.
 */
export function handleJobFailure(
	envelope: DaemonJobEnvelopeV1,
	result: JobResultV1 | undefined,
	error: Error | undefined,
	config: Pick<NormalizedDaemonConfigV1, "paths">,
	logger?: (message: string) => void,
): HandleJobFailureResult {
	const classification = classifyJobFailure(result, error);
	const retryCount = (envelope.retryCount ?? 0);
	const maxRetries = envelope.maxRetries ?? DEFAULT_MAX_RETRIES;
	const failureReason = error?.message ?? result?.failureReason ?? "unknown failure";

	if (retryCount >= maxRetries) {
		logger?.(`[fixbot] retry: exhausted ${maxRetries} retries for ${envelope.originalJobId ?? envelope.jobId} — giving up`);
		return { retried: false, classification, retryCount, maxRetries, failureReason };
	}

	const retryEnvelope = buildRetryEnvelope(envelope, classification, failureReason, config);

	try {
		enqueueDaemonJob(config, retryEnvelope);
		logger?.(
			`[fixbot] retry: scheduled retry ${retryEnvelope.retryCount}/${maxRetries} for ${retryEnvelope.originalJobId ?? retryEnvelope.jobId} (${classification}), next eligible at ${retryEnvelope.nextRetryAt}`,
		);
		return {
			retried: true,
			classification,
			retryCount: retryEnvelope.retryCount ?? retryCount + 1,
			maxRetries,
			failureReason,
		};
	} catch (enqueueError) {
		logger?.(
			`[fixbot] retry: failed to enqueue retry for ${envelope.jobId}: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
		);
		return { retried: false, classification, retryCount, maxRetries, failureReason };
	}
}
