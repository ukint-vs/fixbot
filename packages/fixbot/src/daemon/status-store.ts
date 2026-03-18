import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createDaemonStatus, normalizeDaemonStatus } from "../config";
import type {
	DaemonActiveJobStatusV1,
	DaemonErrorSummary,
	DaemonQueueStatusV1,
	DaemonRecentResultSummaryV1,
	DaemonStatusSnapshotV1,
	DaemonStatusV1,
	NormalizedDaemonConfigV1,
} from "../types";

interface PersistStatusOptions {
	status: DaemonStatusV1;
	pretty?: boolean;
}

export interface DaemonLockRecord {
	pid: number;
	startedAt: string;
	configFilePath?: string;
	updatedAt: string;
}

export interface DaemonInspection {
	status: DaemonStatusV1;
	lock?: DaemonLockRecord;
	pidFilePid?: number;
	observedPid?: number;
	processRunning: boolean;
	stale: boolean;
	issues: string[];
	statusFileExists: boolean;
}

export interface MergeDaemonStatusInput {
	state?: DaemonStatusV1["state"];
	pid?: number | null;
	startedAt?: string | null;
	heartbeatAt?: string | null;
	lastTransitionAt?: string;
	lastError?: DaemonErrorSummary | null;
	queue?: DaemonQueueStatusV1;
	activeJob?: DaemonActiveJobStatusV1 | null;
	recentResults?: DaemonRecentResultSummaryV1[];
}

type UnknownRecord = Record<string, unknown>;

function isFileMissingError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readTextFileIfPresent(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf-8");
	} catch (error) {
		if (isFileMissingError(error)) {
			return undefined;
		}
		throw error;
	}
}

function writeAtomicTextFile(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const temporaryFilePath = `${filePath}.tmp`;
	writeFileSync(temporaryFilePath, content, "utf-8");
	renameSync(temporaryFilePath, filePath);
}

function buildErrorSummary(message: string, code: string): DaemonErrorSummary {
	return {
		message,
		code,
		at: new Date().toISOString(),
	};
}

export function getDaemonHeartbeatAgeMs(
	status: Pick<DaemonStatusV1, "heartbeatAt">,
	now: number = Date.now(),
): number | null {
	if (status.heartbeatAt === undefined) {
		return null;
	}
	const heartbeatTimestamp = Date.parse(status.heartbeatAt);
	if (!Number.isFinite(heartbeatTimestamp)) {
		return null;
	}
	return Math.max(0, now - heartbeatTimestamp);
}

function cloneDaemonQueueStatus(queue: DaemonStatusV1["queue"]): DaemonStatusSnapshotV1["queue"] {
	return {
		...queue,
		preview: queue.preview.map((job) => ({
			...job,
			submission: job.submission ? { ...job.submission } : undefined,
		})),
	};
}

export function createDaemonStatusSnapshot(status: DaemonStatusV1, now: number = Date.now()): DaemonStatusSnapshotV1 {
	return {
		version: status.version,
		state: status.state,
		pid: status.pid ?? null,
		startedAt: status.startedAt ?? null,
		heartbeatAt: status.heartbeatAt ?? null,
		heartbeatAgeMs: getDaemonHeartbeatAgeMs(status, now),
		lastTransitionAt: status.lastTransitionAt,
		paths: { ...status.paths },
		lastError: status.lastError ? { ...status.lastError } : null,
		queue: cloneDaemonQueueStatus(status.queue),
		activeJob: status.activeJob ? { ...status.activeJob } : null,
		recentResults: status.recentResults.map((result) => ({ ...result })),
	};
}

function formatQueuePreviewSummary(status: DaemonStatusSnapshotV1): string {
	if (status.queue.depth === 0) {
		return "Queue preview: none";
	}
	if (status.queue.preview.length === 0) {
		return "Queue preview: none recorded";
	}
	if (status.queue.previewTruncated || status.queue.preview.length !== status.queue.depth) {
		return `Queue preview: ${status.queue.preview.length} shown of ${status.queue.depth}`;
	}
	return `Queue preview: ${status.queue.preview.length} shown`;
}

function formatQueuedJobLine(index: number, status: DaemonStatusSnapshotV1): string | undefined {
	const job = status.queue.preview[index];
	if (!job) {
		return undefined;
	}
	const parts = [job.jobId];
	if (job.enqueuedAt) {
		parts.push(`enqueued=${job.enqueuedAt}`);
	}
	return `Queued job ${index + 1}: ${parts.join(" ")}`;
}

function formatActiveJobLine(status: DaemonStatusSnapshotV1): string {
	if (!status.activeJob) {
		return "Active job: none";
	}
	const parts = [`${status.activeJob.jobId} (${status.activeJob.state})`];
	if (status.activeJob.enqueuedAt) {
		parts.push(`enqueued=${status.activeJob.enqueuedAt}`);
	}
	if (status.activeJob.startedAt) {
		parts.push(`started=${status.activeJob.startedAt}`);
	}
	return `Active job: ${parts.join(" ")}`;
}

function formatRecentResultLine(index: number, status: DaemonStatusSnapshotV1): string | undefined {
	const result = status.recentResults[index];
	if (!result) {
		return undefined;
	}
	const parts = [`${result.jobId}`, result.status, `finished=${result.finishedAt}`];
	if (result.enqueuedAt) {
		parts.push(`enqueued=${result.enqueuedAt}`);
	}
	if (result.startedAt) {
		parts.push(`started=${result.startedAt}`);
	}
	if (result.summary) {
		parts.push(`summary=${result.summary}`);
	}
	if (result.failureReason) {
		parts.push(`failure=${result.failureReason}`);
	}
	return `Recent result ${index + 1}: ${parts.join(" ")}`;
}

export function renderDaemonStatus(status: DaemonStatusV1, issues: string[] = [], now: number = Date.now()): string {
	const snapshot = createDaemonStatusSnapshot(status, now);
	const lines = [
		`State: ${snapshot.state}`,
		`PID: ${snapshot.pid ?? "none"}`,
		`Started: ${snapshot.startedAt ?? "unknown"}`,
		`Heartbeat: ${snapshot.heartbeatAt ?? "never"}`,
		`Heartbeat age ms: ${snapshot.heartbeatAgeMs ?? "unknown"}`,
		`Last transition: ${snapshot.lastTransitionAt}`,
		`State dir: ${snapshot.paths.stateDir}`,
		`Results dir: ${snapshot.paths.resultsDir}`,
		`Status file: ${snapshot.paths.statusFile}`,
		`PID file: ${snapshot.paths.pidFile}`,
		`Lock file: ${snapshot.paths.lockFile}`,
		`Queue depth: ${snapshot.queue.depth}`,
		formatQueuePreviewSummary(snapshot),
	];

	for (let index = 0; index < snapshot.queue.preview.length; index += 1) {
		const line = formatQueuedJobLine(index, snapshot);
		if (line) {
			lines.push(line);
		}
	}

	lines.push(formatActiveJobLine(snapshot), `Recent results: ${snapshot.recentResults.length}`);

	for (let index = 0; index < snapshot.recentResults.length; index += 1) {
		const line = formatRecentResultLine(index, snapshot);
		if (line) {
			lines.push(line);
		}
	}

	if (snapshot.lastError) {
		lines.push(
			`Last error: ${snapshot.lastError.code ? `[${snapshot.lastError.code}] ` : ""}${snapshot.lastError.message} @ ${snapshot.lastError.at}`,
		);
	}
	if (issues.length > 0) {
		lines.push(`Issues: ${issues.join("; ")}`);
	}

	return `${lines.join("\n")}\n`;
}

function parsePid(text: string, label: string): number {
	const trimmed = text.trim();
	if (trimmed === "") {
		throw new Error(`${label} is empty`);
	}
	const pid = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(`${label} must contain a positive integer pid`);
	}
	return pid;
}

function parseLockRecord(text: string, filePath: string): DaemonLockRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as DaemonLockRecord;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid JSON";
		throw new Error(`${filePath}: ${message}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${filePath} must contain an object`);
	}

	const record = parsed as UnknownRecord;
	const pid = record.pid;
	const startedAt = record.startedAt;
	const updatedAt = record.updatedAt;
	const configFilePath = record.configFilePath;

	if (!Number.isInteger(pid) || (pid as number) <= 0) {
		throw new Error(`${filePath}.pid must be a positive integer`);
	}
	if (typeof startedAt !== "string" || startedAt.trim() === "") {
		throw new Error(`${filePath}.startedAt must be a non-empty string`);
	}
	if (typeof updatedAt !== "string" || updatedAt.trim() === "") {
		throw new Error(`${filePath}.updatedAt must be a non-empty string`);
	}
	if (configFilePath !== undefined && (typeof configFilePath !== "string" || configFilePath.trim() === "")) {
		throw new Error(`${filePath}.configFilePath must be a non-empty string when present`);
	}

	return {
		pid: pid as number,
		startedAt: startedAt.trim(),
		updatedAt: updatedAt.trim(),
		configFilePath: typeof configFilePath === "string" ? configFilePath.trim() : undefined,
	};
}

function createObservedStatus(
	config: NormalizedDaemonConfigV1,
	storedStatus: DaemonStatusV1 | undefined,
	pid: number | undefined,
	issues: string[],
): DaemonStatusV1 {
	if (issues.length === 0 && storedStatus) {
		if (pid === undefined || storedStatus.pid === pid) {
			return storedStatus;
		}
	}

	const baseline = storedStatus ?? createDaemonStatus(config, { state: "degraded" });
	const primaryCode =
		issues.find((issue) => issue.includes("stale")) !== undefined
			? "STALE_PID"
			: issues.find((issue) => issue.includes("mismatch")) !== undefined
				? "PID_MISMATCH"
				: issues.length > 0
					? "STATUS_UNHEALTHY"
					: "NOT_RUNNING";
	const primaryMessage = issues[0] ?? "daemon is not running";

	return createDaemonStatus(config, {
		state: baseline.state === "error" ? "error" : "degraded",
		pid,
		startedAt: baseline.startedAt,
		heartbeatAt: baseline.heartbeatAt,
		lastTransitionAt: baseline.lastTransitionAt,
		lastError: buildErrorSummary(primaryMessage, primaryCode),
		queue: baseline.queue,
		activeJob: baseline.activeJob,
		recentResults: baseline.recentResults,
	});
}

export function ensureDaemonStateDirectories(config: NormalizedDaemonConfigV1): void {
	mkdirSync(config.paths.stateDir, { recursive: true });
	mkdirSync(config.paths.resultsDir, { recursive: true });
	mkdirSync(dirname(config.paths.statusFile), { recursive: true });
}

export function readDaemonStatusFile(config: NormalizedDaemonConfigV1): DaemonStatusV1 | undefined {
	const text = readTextFileIfPresent(config.paths.statusFile);
	if (text === undefined) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as DaemonStatusV1;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid JSON";
		throw new Error(`${config.paths.statusFile}: ${message}`);
	}
	return normalizeDaemonStatus(parsed, config.paths.statusFile);
}

export function writeDaemonStatusFile(config: NormalizedDaemonConfigV1, options: PersistStatusOptions): void {
	const spaces = (options.pretty ?? config.status.pretty) ? 2 : undefined;
	const payload = `${JSON.stringify(options.status, null, spaces)}\n`;
	writeAtomicTextFile(config.paths.statusFile, payload);
}

export function mergeDaemonStatus(
	config: NormalizedDaemonConfigV1,
	currentStatus: DaemonStatusV1,
	input: MergeDaemonStatusInput,
): DaemonStatusV1 {
	return createDaemonStatus(config, {
		state: input.state ?? currentStatus.state,
		pid: input.pid === null ? undefined : (input.pid ?? currentStatus.pid),
		startedAt: input.startedAt === null ? undefined : (input.startedAt ?? currentStatus.startedAt),
		heartbeatAt: input.heartbeatAt === null ? undefined : (input.heartbeatAt ?? currentStatus.heartbeatAt),
		lastTransitionAt: input.lastTransitionAt ?? new Date().toISOString(),
		lastError: input.lastError === null ? undefined : (input.lastError ?? currentStatus.lastError),
		queue: input.queue ?? currentStatus.queue,
		activeJob: input.activeJob === undefined ? currentStatus.activeJob : input.activeJob,
		recentResults: input.recentResults ?? currentStatus.recentResults,
	});
}

export function readDaemonPidFile(config: NormalizedDaemonConfigV1): number | undefined {
	const text = readTextFileIfPresent(config.paths.pidFile);
	if (text === undefined) {
		return undefined;
	}
	return parsePid(text, config.paths.pidFile);
}

export function writeDaemonPidFile(config: NormalizedDaemonConfigV1, pid: number): void {
	writeAtomicTextFile(config.paths.pidFile, `${pid}\n`);
}

export function removeDaemonPidFile(config: NormalizedDaemonConfigV1): void {
	rmSync(config.paths.pidFile, { force: true });
}

export function readDaemonLockFile(config: NormalizedDaemonConfigV1): DaemonLockRecord | undefined {
	const text = readTextFileIfPresent(config.paths.lockFile);
	if (text === undefined) {
		return undefined;
	}
	return parseLockRecord(text, config.paths.lockFile);
}

export function writeDaemonLockFile(config: NormalizedDaemonConfigV1, lock: DaemonLockRecord): void {
	writeAtomicTextFile(config.paths.lockFile, `${JSON.stringify(lock, null, 2)}\n`);
}

export function removeDaemonLockFile(config: NormalizedDaemonConfigV1): void {
	rmSync(config.paths.lockFile, { force: true });
}

export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error) {
			const code = error.code;
			if (code === "ESRCH") {
				return false;
			}
			if (code === "EPERM") {
				return true;
			}
		}
		throw error;
	}
}

export function inspectDaemon(config: NormalizedDaemonConfigV1): DaemonInspection {
	ensureDaemonStateDirectories(config);

	const issues: string[] = [];
	let storedStatus: DaemonStatusV1 | undefined;
	let pidFilePid: number | undefined;
	let lock: DaemonLockRecord | undefined;

	try {
		storedStatus = readDaemonStatusFile(config);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		issues.push(`status file unreadable: ${message}`);
	}

	try {
		pidFilePid = readDaemonPidFile(config);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		issues.push(`pid file unreadable: ${message}`);
	}

	try {
		lock = readDaemonLockFile(config);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		issues.push(`lock file unreadable: ${message}`);
	}

	const statusPid = storedStatus?.pid;
	const lockPid = lock?.pid;
	if (statusPid !== undefined && pidFilePid !== undefined && statusPid !== pidFilePid) {
		issues.push(`status pid ${statusPid} does not match pid file pid ${pidFilePid} (pid mismatch)`);
	}
	if (lockPid !== undefined && pidFilePid !== undefined && lockPid !== pidFilePid) {
		issues.push(`lock pid ${lockPid} does not match pid file pid ${pidFilePid} (pid mismatch)`);
	}
	if (lockPid !== undefined && statusPid !== undefined && lockPid !== statusPid) {
		issues.push(`lock pid ${lockPid} does not match status pid ${statusPid} (pid mismatch)`);
	}

	const observedPid = pidFilePid ?? statusPid ?? lockPid;
	const processRunning = observedPid === undefined ? false : isProcessRunning(observedPid);
	const stale = observedPid !== undefined && !processRunning;
	if (observedPid === undefined) {
		if (storedStatus === undefined) {
			issues.push("daemon has not recorded a status file yet");
		} else if (
			storedStatus.state === "starting" ||
			storedStatus.state === "idle" ||
			storedStatus.state === "running"
		) {
			issues.push("daemon status is missing a pid for an active lifecycle state");
		}
	} else if (!processRunning) {
		issues.push(`recorded daemon pid ${observedPid} is stale and no longer running`);
	}

	return {
		status: createObservedStatus(config, storedStatus, observedPid, issues),
		lock,
		pidFilePid,
		observedPid,
		processRunning,
		stale,
		issues,
		statusFileExists: storedStatus !== undefined || fileExists(config.paths.statusFile),
	};
}

function fileExists(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch (error) {
		if (isFileMissingError(error)) {
			return false;
		}
		throw error;
	}
}

export function persistInspection(config: NormalizedDaemonConfigV1, inspection: DaemonInspection): void {
	writeDaemonStatusFile(config, { status: inspection.status });
}

export function cleanupDaemonRuntimeFiles(config: NormalizedDaemonConfigV1): void {
	removeDaemonPidFile(config);
	removeDaemonLockFile(config);
}

/**
 * Merge durable spool facts (queue depth/preview and orphaned active jobs) into
 * `currentStatus` and return the updated value without writing to disk.
 *
 * - `spoolQueue`: queue status derived from the live spool (from `buildQueueStatusFromSpool`)
 * - `orphanedJobIds`: active spool files not matched by a running job
 *
 * If orphaned jobs exist the status state is set to `degraded` (unless it is
 * already `error`) and `lastError` describes the orphan condition.
 */
export function mergeSpoolReconciliation(
	config: NormalizedDaemonConfigV1,
	currentStatus: DaemonStatusV1,
	spoolQueue: import("../types").DaemonQueueStatusV1,
	orphanedJobIds: string[],
): DaemonStatusV1 {
	if (orphanedJobIds.length === 0) {
		return mergeDaemonStatus(config, currentStatus, {
			queue: spoolQueue,
		});
	}

	const orphanList = orphanedJobIds.join(", ");
	const lastError: import("../types").DaemonErrorSummary = {
		message: `orphaned claimed job(s) found in active spool: ${orphanList}`,
		code: "ORPHANED_ACTIVE_JOB",
		at: new Date().toISOString(),
	};
	return mergeDaemonStatus(config, currentStatus, {
		state: currentStatus.state === "error" ? "error" : "degraded",
		queue: spoolQueue,
		lastError,
	});
}
