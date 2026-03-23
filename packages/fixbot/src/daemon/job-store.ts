import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getArtifactPaths } from "../artifacts";
import { normalizeJobSpec } from "../contracts";
import {
	DAEMON_JOB_ENVELOPE_VERSION_V1,
	type DaemonJobEnvelopeV1,
	type DaemonSubmissionKind,
	type DaemonSubmissionSourceV1,
	type NormalizedDaemonConfigV1,
} from "../types";
import { assertNonEmptyString, assertObject, assertPositiveInteger, assertTimestamp } from "../validation";

const QUEUE_DIRECTORY_NAME = "queue";
const ACTIVE_DIRECTORY_NAME = "active";

export interface DaemonJobStorePaths {
	stateDir: string;
	queueDir: string;
	activeDir: string;
}

export interface QueuedDaemonJobRecord {
	envelope: DaemonJobEnvelopeV1;
	fileName: string;
	filePath: string;
}

export interface ActiveDaemonJobRecord {
	envelope: DaemonJobEnvelopeV1;
	fileName: string;
	filePath: string;
}

export interface ClaimedDaemonJobRecord extends ActiveDaemonJobRecord {
	queueFilePath: string;
}

export interface DuplicateDaemonJobCollision {
	kind: "queue" | "active" | "result-file" | "artifact-dir";
	path: string;
}

export class DuplicateDaemonJobError extends Error {
	readonly jobId: string;
	readonly collisions: DuplicateDaemonJobCollision[];

	constructor(jobId: string, collisions: DuplicateDaemonJobCollision[]) {
		super(
			`Cannot enqueue duplicate daemon job "${jobId}" because it already exists in ${collisions
				.map((collision) => `${collision.kind}:${collision.path}`)
				.join(", ")}`,
		);
		this.name = "DuplicateDaemonJobError";
		this.jobId = jobId;
		this.collisions = collisions.map((collision) => ({ ...collision }));
	}
}

const VALID_SUBMISSION_KINDS = new Set<DaemonSubmissionKind>(["cli", "github-label"]);

function parseSubmissionSource(value: unknown, label: string): DaemonSubmissionSourceV1 {
	const submission = assertObject(value, label);
	const kind = submission.kind as string;
	if (!VALID_SUBMISSION_KINDS.has(kind as DaemonSubmissionKind)) {
		throw new Error(`${label}.kind must be one of ${[...VALID_SUBMISSION_KINDS].map((k) => `"${k}"`).join(", ")}`);
	}
	const filePath = submission.filePath;
	const result: DaemonSubmissionSourceV1 = {
		kind: kind as DaemonSubmissionKind,
		filePath: filePath === undefined ? undefined : assertNonEmptyString(filePath, `${label}.filePath`),
	};
	if (kind === "github-label") {
		const githubRepo = submission.githubRepo;
		const githubIssueNumber = submission.githubIssueNumber;
		const githubLabelName = submission.githubLabelName;
		const githubActionsRunId = submission.githubActionsRunId;
		if (githubRepo !== undefined) {
			result.githubRepo = assertNonEmptyString(githubRepo, `${label}.githubRepo`);
		}
		if (githubIssueNumber !== undefined) {
			result.githubIssueNumber = assertPositiveInteger(githubIssueNumber, `${label}.githubIssueNumber`);
		}
		if (githubLabelName !== undefined) {
			result.githubLabelName = assertNonEmptyString(githubLabelName, `${label}.githubLabelName`);
		}
		if (githubActionsRunId !== undefined) {
			result.githubActionsRunId = assertPositiveInteger(githubActionsRunId, `${label}.githubActionsRunId`);
		}
	}
	return result;
}

function parseDaemonJobEnvelope(value: unknown, label: string): DaemonJobEnvelopeV1 {
	const envelope = assertObject(value, label);
	if (envelope.version !== DAEMON_JOB_ENVELOPE_VERSION_V1) {
		throw new Error(`${label}.version must be "${DAEMON_JOB_ENVELOPE_VERSION_V1}"`);
	}

	const jobId = assertNonEmptyString(envelope.jobId, `${label}.jobId`);
	const job = normalizeJobSpec(envelope.job, `${label}.job`);
	if (job.jobId !== jobId) {
		throw new Error(`${label}.job.jobId must match ${label}.jobId`);
	}

	const artifacts = assertObject(envelope.artifacts, `${label}.artifacts`);
	const parsed: DaemonJobEnvelopeV1 = {
		version: DAEMON_JOB_ENVELOPE_VERSION_V1,
		jobId,
		job,
		submission: parseSubmissionSource(envelope.submission, `${label}.submission`),
		enqueuedAt: assertTimestamp(envelope.enqueuedAt, `${label}.enqueuedAt`),
		artifacts: {
			artifactDir: assertNonEmptyString(artifacts.artifactDir, `${label}.artifacts.artifactDir`),
			resultFile: assertNonEmptyString(artifacts.resultFile, `${label}.artifacts.resultFile`),
		},
	};
	if (typeof envelope.retryCount === "number") parsed.retryCount = envelope.retryCount;
	if (typeof envelope.maxRetries === "number") parsed.maxRetries = envelope.maxRetries;
	if (typeof envelope.nextRetryAt === "string") parsed.nextRetryAt = envelope.nextRetryAt;
	if (typeof envelope.lastFailureReason === "string") parsed.lastFailureReason = envelope.lastFailureReason;
	if (typeof envelope.lastFailureClassification === "string") parsed.lastFailureClassification = envelope.lastFailureClassification as DaemonJobEnvelopeV1["lastFailureClassification"];
	if (typeof envelope.originalJobId === "string") parsed.originalJobId = envelope.originalJobId;
	return parsed;
}

function fileExists(filePath: string): boolean {
	try {
		return statSync(filePath).isFile() || statSync(filePath).isDirectory();
	} catch (error) {
		if (isFileMissingError(error)) {
			return false;
		}
		throw error;
	}
}

function isFileMissingError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sanitizeFileNameSegment(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+/g, "")
		.replace(/-+$/g, "");
	return sanitized === "" ? "job" : sanitized;
}

function buildJobToken(jobId: string): string {
	const hash = createHash("sha256").update(jobId).digest("hex").slice(0, 10);
	return `${sanitizeFileNameSegment(jobId)}-${hash}`;
}

function buildEnqueuedAtToken(enqueuedAt: string): string {
	return enqueuedAt.replace(/[^0-9]/g, "");
}

function buildQueueFileName(envelope: DaemonJobEnvelopeV1): string {
	return `${buildEnqueuedAtToken(envelope.enqueuedAt)}--${buildJobToken(envelope.jobId)}.json`;
}

function buildActiveFileName(jobId: string): string {
	return `${buildJobToken(jobId)}.json`;
}

function writeAtomicJsonFile(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const temporaryFilePath = join(
		dirname(filePath),
		`.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}-${basename(filePath)}`,
	);
	writeFileSync(temporaryFilePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
	try {
		renameSync(temporaryFilePath, filePath);
	} catch (error) {
		rmSync(temporaryFilePath, { force: true });
		throw error;
	}
}

function readJsonFile(filePath: string): unknown {
	const text = readFileSync(filePath, "utf-8");
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse JSON from "${filePath}": ${msg}`);
	}
}

function listJsonFiles(directoryPath: string): string[] {
	try {
		return readdirSync(directoryPath)
			.filter((entry) => entry.endsWith(".json"))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		if (isFileMissingError(error)) {
			return [];
		}
		throw error;
	}
}

function readQueuedRecord(filePath: string): QueuedDaemonJobRecord {
	const envelope = parseDaemonJobEnvelope(readJsonFile(filePath), filePath);
	return {
		envelope,
		fileName: basename(filePath),
		filePath,
	};
}

function readActiveRecord(filePath: string): ActiveDaemonJobRecord {
	const envelope = parseDaemonJobEnvelope(readJsonFile(filePath), filePath);
	return {
		envelope,
		fileName: basename(filePath),
		filePath,
	};
}

function compareQueuedRecords(left: QueuedDaemonJobRecord, right: QueuedDaemonJobRecord): number {
	const byTimestamp = left.envelope.enqueuedAt.localeCompare(right.envelope.enqueuedAt);
	if (byTimestamp !== 0) {
		return byTimestamp;
	}
	return left.fileName.localeCompare(right.fileName);
}

export function getDaemonJobStorePaths(config: Pick<NormalizedDaemonConfigV1, "paths">): DaemonJobStorePaths {
	const stateDir = resolve(config.paths.stateDir);
	return {
		stateDir,
		queueDir: join(stateDir, QUEUE_DIRECTORY_NAME),
		activeDir: join(stateDir, ACTIVE_DIRECTORY_NAME),
	};
}

export function ensureDaemonJobStoreDirectories(config: Pick<NormalizedDaemonConfigV1, "paths">): DaemonJobStorePaths {
	const paths = getDaemonJobStorePaths(config);
	mkdirSync(paths.queueDir, { recursive: true });
	mkdirSync(paths.activeDir, { recursive: true });
	return paths;
}

export function listQueuedDaemonJobs(config: Pick<NormalizedDaemonConfigV1, "paths">): QueuedDaemonJobRecord[] {
	const paths = ensureDaemonJobStoreDirectories(config);
	return listJsonFiles(paths.queueDir)
		.map((fileName) => readQueuedRecord(join(paths.queueDir, fileName)))
		.sort(compareQueuedRecords);
}

export function listActiveDaemonJobs(config: Pick<NormalizedDaemonConfigV1, "paths">): ActiveDaemonJobRecord[] {
	const paths = ensureDaemonJobStoreDirectories(config);
	return listJsonFiles(paths.activeDir)
		.map((fileName) => readActiveRecord(join(paths.activeDir, fileName)))
		.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export function findDuplicateDaemonJobCollisions(
	config: Pick<NormalizedDaemonConfigV1, "paths">,
	jobId: string,
): DuplicateDaemonJobCollision[] {
	const collisions: DuplicateDaemonJobCollision[] = [];
	for (const queued of listQueuedDaemonJobs(config)) {
		if (queued.envelope.jobId === jobId) {
			collisions.push({
				kind: "queue",
				path: queued.filePath,
			});
		}
	}
	for (const active of listActiveDaemonJobs(config)) {
		if (active.envelope.jobId === jobId) {
			collisions.push({
				kind: "active",
				path: active.filePath,
			});
		}
	}
	const artifactPaths = getArtifactPaths(config.paths.resultsDir, jobId);
	if (fileExists(artifactPaths.resultFile)) {
		collisions.push({
			kind: "result-file",
			path: artifactPaths.resultFile,
		});
	}
	if (fileExists(artifactPaths.artifactDir)) {
		collisions.push({
			kind: "artifact-dir",
			path: artifactPaths.artifactDir,
		});
	}
	return collisions;
}

export function assertDaemonJobIdAvailable(config: Pick<NormalizedDaemonConfigV1, "paths">, jobId: string): void {
	const collisions = findDuplicateDaemonJobCollisions(config, jobId);
	if (collisions.length > 0) {
		throw new DuplicateDaemonJobError(jobId, collisions);
	}
}

export function enqueueDaemonJob(
	config: Pick<NormalizedDaemonConfigV1, "paths">,
	envelope: DaemonJobEnvelopeV1,
): QueuedDaemonJobRecord {
	const normalizedEnvelope = parseDaemonJobEnvelope(envelope, "daemon job envelope");
	const expectedArtifacts = getArtifactPaths(config.paths.resultsDir, normalizedEnvelope.jobId);
	if (
		normalizedEnvelope.artifacts.artifactDir !== expectedArtifacts.artifactDir ||
		normalizedEnvelope.artifacts.resultFile !== expectedArtifacts.resultFile
	) {
		throw new Error(`daemon job envelope artifacts must match results dir for job "${normalizedEnvelope.jobId}"`);
	}
	assertDaemonJobIdAvailable(config, normalizedEnvelope.jobId);
	const paths = ensureDaemonJobStoreDirectories(config);
	const fileName = buildQueueFileName(normalizedEnvelope);
	const filePath = join(paths.queueDir, fileName);
	writeAtomicJsonFile(filePath, normalizedEnvelope);
	return {
		envelope: normalizedEnvelope,
		fileName,
		filePath,
	};
}

function isRetryEligible(envelope: DaemonJobEnvelopeV1): boolean {
	if (!envelope.nextRetryAt) return true;
	const retryAtMs = Date.parse(envelope.nextRetryAt);
	if (Number.isNaN(retryAtMs)) return true;
	return Date.now() >= retryAtMs;
}

export function claimNextQueuedDaemonJob(
	config: Pick<NormalizedDaemonConfigV1, "paths">,
): ClaimedDaemonJobRecord | null {
	const paths = ensureDaemonJobStoreDirectories(config);
	for (const queued of listQueuedDaemonJobs(config)) {
		if (!isRetryEligible(queued.envelope)) continue;
		const activeFileName = buildActiveFileName(queued.envelope.jobId);
		const activeFilePath = join(paths.activeDir, activeFileName);
		if (fileExists(activeFilePath)) {
			throw new DuplicateDaemonJobError(queued.envelope.jobId, [
				{
					kind: "active",
					path: activeFilePath,
				},
			]);
		}
		try {
			renameSync(queued.filePath, activeFilePath);
		} catch (error) {
			if (isFileMissingError(error)) {
				continue;
			}
			throw error;
		}
		return {
			envelope: queued.envelope,
			fileName: activeFileName,
			filePath: activeFilePath,
			queueFilePath: queued.filePath,
		};
	}
	return null;
}

export function removeActiveDaemonJob(config: Pick<NormalizedDaemonConfigV1, "paths">, jobId: string): boolean {
	for (const active of listActiveDaemonJobs(config)) {
		if (active.envelope.jobId !== jobId) {
			continue;
		}
		rmSync(active.filePath, { force: true });
		return true;
	}
	return false;
}

export type OrphanRecoveryAction = "requeued" | "cleaned";

/**
 * Recover an orphaned active spool file left behind by a crashed daemon.
 *
 * If result artifacts already exist for the job (meaning it completed before the crash),
 * the active file is simply removed ("cleaned"). Otherwise, the active file is atomically
 * renamed back into the queue directory for retry ("requeued").
 *
 * The original `enqueuedAt` timestamp is preserved so FIFO ordering is maintained.
 */
export function requeueOrphanedDaemonJob(
	config: Pick<NormalizedDaemonConfigV1, "paths">,
	orphan: ActiveDaemonJobRecord,
): OrphanRecoveryAction {
	const artifactPaths = getArtifactPaths(config.paths.resultsDir, orphan.envelope.jobId);
	if (fileExists(artifactPaths.resultFile)) {
		// Job completed before the crash — just clean up the stale active file.
		rmSync(orphan.filePath, { force: true });
		return "cleaned";
	}
	// Job did not complete — move the active file back to the queue for retry.
	// Guard against queue collision (e.g., crash-loop leaving files in both dirs).
	const paths = ensureDaemonJobStoreDirectories(config);
	const queueFileName = buildQueueFileName(orphan.envelope);
	const queueFilePath = join(paths.queueDir, queueFileName);
	if (fileExists(queueFilePath)) {
		// Queue file already exists for this job — just clean up the duplicate active file.
		rmSync(orphan.filePath, { force: true });
		return "cleaned";
	}
	renameSync(orphan.filePath, queueFilePath);
	return "requeued";
}

/**
 * Build a DaemonQueueStatusV1 from the durable spool state.
 * Preview entries are derived from FIFO-ordered queue records up to `previewLimit`.
 */
export function buildQueueStatusFromSpool(
	config: Pick<NormalizedDaemonConfigV1, "paths">,
	previewLimit: number = 5,
): import("../types").DaemonQueueStatusV1 {
	const queued = listQueuedDaemonJobs(config);
	const depth = queued.length;
	const preview = queued.slice(0, previewLimit).map((record) => ({
		jobId: record.envelope.jobId,
		enqueuedAt: record.envelope.enqueuedAt,
		submission: { ...record.envelope.submission },
		artifactDir: record.envelope.artifacts.artifactDir,
	}));
	return {
		depth,
		preview,
		previewTruncated: depth > previewLimit,
	};
}

/**
 * Return all active spool records that are NOT accounted for by `knownActiveJobId`.
 * When `knownActiveJobId` is undefined, all active records are considered orphaned.
 */
export function listOrphanedActiveDaemonJobs(
	config: Pick<NormalizedDaemonConfigV1, "paths">,
	knownActiveJobId: string | undefined,
): ActiveDaemonJobRecord[] {
	return listActiveDaemonJobs(config).filter((record) => record.envelope.jobId !== knownActiveJobId);
}
