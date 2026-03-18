import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getArtifactPaths } from "../artifacts";
import { loadDaemonConfig } from "../config";
import { parseJobSpecText } from "../contracts";
import {
	DAEMON_JOB_ENVELOPE_VERSION_V1,
	type DaemonJobEnvelopeV1,
	type NormalizedDaemonConfigV1,
	type NormalizedJobSpecV1,
} from "../types";
import type { QueuedDaemonJobRecord } from "./job-store";
import { buildQueueStatusFromSpool, enqueueDaemonJob } from "./job-store";
import {
	type DaemonInspection,
	inspectDaemon,
	mergeDaemonStatus,
	persistInspection,
	readDaemonStatusFile,
	writeDaemonStatusFile,
} from "./status-store";

const LIVE_DAEMON_STATES = new Set(["starting", "idle", "running"]);

export interface EnqueueDaemonJobFromFileResult {
	config: NormalizedDaemonConfigV1;
	inspection: DaemonInspection;
	jobFilePath: string;
	job: NormalizedJobSpecV1;
	envelope: DaemonJobEnvelopeV1;
	queued: QueuedDaemonJobRecord;
}

export interface CreateDaemonJobEnvelopeOptions {
	jobFilePath?: string;
	enqueuedAt?: string;
}

export function createDaemonJobEnvelope(
	config: Pick<NormalizedDaemonConfigV1, "paths">,
	job: NormalizedJobSpecV1,
	options: CreateDaemonJobEnvelopeOptions = {},
): DaemonJobEnvelopeV1 {
	const artifactPaths = getArtifactPaths(config.paths.resultsDir, job.jobId);
	return {
		version: DAEMON_JOB_ENVELOPE_VERSION_V1,
		jobId: job.jobId,
		job,
		submission: {
			kind: "cli",
			filePath: options.jobFilePath,
		},
		enqueuedAt: options.enqueuedAt ?? new Date().toISOString(),
		artifacts: {
			artifactDir: artifactPaths.artifactDir,
			resultFile: artifactPaths.resultFile,
		},
	};
}

function formatDaemonLivenessFailure(inspection: DaemonInspection): string {
	if (inspection.issues.length > 0) {
		return inspection.issues.join("; ");
	}
	if (!inspection.processRunning || inspection.observedPid === undefined) {
		const lastErrorMessage = inspection.status.lastError?.message;
		if (lastErrorMessage) {
			return `${lastErrorMessage} (state=${inspection.status.state})`;
		}
		return `daemon is not running (state=${inspection.status.state})`;
	}
	return `daemon state is ${inspection.status.state}`;
}

export function assertDaemonLiveForEnqueue(config: NormalizedDaemonConfigV1, jobId: string): DaemonInspection {
	const inspection = inspectDaemon(config);
	const daemonState = inspection.status.state;
	const liveState = LIVE_DAEMON_STATES.has(daemonState);
	if (
		inspection.issues.length > 0 ||
		!inspection.processRunning ||
		inspection.observedPid === undefined ||
		!liveState
	) {
		persistInspection(config, inspection);
		throw new Error(
			`Cannot enqueue job "${jobId}" because fixbot daemon is not live: ${formatDaemonLivenessFailure(inspection)}`,
		);
	}
	return inspection;
}

export async function enqueueDaemonJobFromFile(
	configFilePath: string,
	jobFilePath: string,
): Promise<EnqueueDaemonJobFromFileResult> {
	const resolvedJobFilePath = resolve(jobFilePath);
	const jobText = readFileSync(resolvedJobFilePath, "utf-8");
	const job = parseJobSpecText(jobText, resolvedJobFilePath);
	const resolvedConfigFilePath = resolve(configFilePath);
	const config = loadDaemonConfig(resolvedConfigFilePath);
	const inspection = assertDaemonLiveForEnqueue(config, job.jobId);
	const envelope = createDaemonJobEnvelope(config, job, {
		jobFilePath: resolvedJobFilePath,
	});
	const queued = enqueueDaemonJob(config, envelope);

	// Refresh the persisted status immediately so the backlog is visible without
	// waiting for the next daemon heartbeat or idle-loop cycle.
	refreshStatusAfterEnqueue(config);

	return {
		config,
		inspection,
		jobFilePath: resolvedJobFilePath,
		job,
		envelope,
		queued,
	};
}

/**
 * Recompute queue depth/preview from the durable spool and write an updated
 * status file. Called immediately after a new queue file is written so that
 * `fixbot daemon status` reflects the new backlog without waiting for a heartbeat.
 *
 * Safe to call even if the status file is absent or the running daemon has not
 * yet written a status — the read is best-effort.
 */
function refreshStatusAfterEnqueue(config: NormalizedDaemonConfigV1): void {
	const current = readDaemonStatusFile(config);
	if (!current) {
		return;
	}
	const spoolQueue = buildQueueStatusFromSpool(config);
	const updated = mergeDaemonStatus(config, current, { queue: spoolQueue });
	writeDaemonStatusFile(config, { status: updated });
}

export function renderDaemonEnqueueSummary(result: EnqueueDaemonJobFromFileResult): string {
	return [
		"Enqueued daemon job:",
		`Job ID: ${result.envelope.jobId}`,
		`Queue destination: ${result.queued.filePath}`,
		`Artifact root: ${result.envelope.artifacts.artifactDir}`,
		`Result file: ${result.envelope.artifacts.resultFile}`,
		`Enqueued at: ${result.envelope.enqueuedAt}`,
	]
		.join("\n")
		.concat("\n");
}
