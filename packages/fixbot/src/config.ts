import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	DAEMON_CONFIG_VERSION_V1,
	DAEMON_LIFECYCLE_STATES,
	DAEMON_STATUS_VERSION_V1,
	type DaemonActiveJobStatusV1,
	type DaemonConfigV1,
	type DaemonErrorSummary,
	type DaemonGitHubConfig,
	type DaemonLifecycleState,
	type DaemonQueueStatusV1,
	type DaemonRecentResultSummaryV1,
	type DaemonStatusV1,
	type DaemonSubmissionKind,
	type DaemonSubmissionSourceV1,
	type GitHubAppAuthConfig,
	type NormalizedDaemonConfigV1,
	type NormalizedDaemonGitHubConfig,
	type NormalizedDaemonGitHubRepoConfig,
	type NormalizedDaemonWebhookConfig,
	type ResultStatus,
	TASK_CLASSES,
	type TaskClass,
	VALID_SUBMISSION_KINDS,
} from "./types";
import {
	assertBoolean,
	assertNonEmptyString,
	assertNonNegativeInteger,
	assertObject,
	assertPositiveInteger,
} from "./validation";

export const DEFAULT_DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_DAEMON_IDLE_SLEEP_MS = 1_000;
export const DEFAULT_DAEMON_STATUS_FILE = "daemon-status.json";
export const DEFAULT_DAEMON_PID_FILE = "daemon.pid";
export const DEFAULT_DAEMON_LOCK_FILE = "daemon.lock";
export const DEFAULT_BOT_URL = "https://github.com/nicobailon/fixbot";
export const DEFAULT_DAEMON_CONFIG_FILENAME = "daemon.config.json";
export const DEFAULT_FIXBOT_DIR = join(homedir(), ".fixbot");
export const DEFAULT_DAEMON_CONFIG_PATH = join(DEFAULT_FIXBOT_DIR, DEFAULT_DAEMON_CONFIG_FILENAME);

export interface CreateDaemonStatusInput {
	state: DaemonLifecycleState;
	pid?: number;
	startedAt?: string;
	heartbeatAt?: string;
	lastTransitionAt?: string;
	lastError?: DaemonErrorSummary;
	queue?: DaemonQueueStatusV1;
	activeJob?: DaemonActiveJobStatusV1 | null;
	recentResults?: DaemonRecentResultSummaryV1[];
}

function resolveConfigBaseDir(source: string): string {
	if (source.trim() === "" || source === "<inline>") {
		return process.cwd();
	}
	return dirname(resolve(source));
}

function resolveConfigPath(baseDir: string, value: string): string {
	return resolve(baseDir, value);
}

function parseDaemonErrorSummary(value: unknown, label: string): DaemonErrorSummary | undefined {
	if (value === undefined) {
		return undefined;
	}
	const summary = assertObject(value, label);
	const code = summary.code;
	return {
		message: assertNonEmptyString(summary.message, `${label}.message`),
		at: assertNonEmptyString(summary.at, `${label}.at`),
		code: code === undefined ? undefined : assertNonEmptyString(code, `${label}.code`),
	};
}

export const DEFAULT_GITHUB_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_WEBHOOK_PORT = 8787;
export const DEFAULT_WEBHOOK_RATE_LIMIT_PER_REPO_PER_MIN = 10;

function parseDaemonSubmissionSource(value: unknown, label: string): DaemonSubmissionSourceV1 | undefined {
	if (value === undefined) {
		return undefined;
	}
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
	if (kind === "github-label" || kind === "github-webhook") {
		const githubRepo = submission.githubRepo;
		const githubIssueNumber = submission.githubIssueNumber;
		const githubLabelName = submission.githubLabelName;
		const githubActionsRunId = submission.githubActionsRunId;
		const githubDeliveryId = submission.githubDeliveryId;
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
		if (githubDeliveryId !== undefined) {
			result.githubDeliveryId = assertNonEmptyString(githubDeliveryId, `${label}.githubDeliveryId`);
		}
	}
	return result;
}

function parseDaemonQueuedJobPreviewEntry(value: unknown, label: string): DaemonQueueStatusV1["preview"][number] {
	const preview = assertObject(value, label);
	const enqueuedAt = preview.enqueuedAt;
	const submission = preview.submission;
	const artifactDir = preview.artifactDir;
	return {
		jobId: assertNonEmptyString(preview.jobId, `${label}.jobId`),
		enqueuedAt: enqueuedAt === undefined ? undefined : assertNonEmptyString(enqueuedAt, `${label}.enqueuedAt`),
		submission: parseDaemonSubmissionSource(submission, `${label}.submission`),
		artifactDir: artifactDir === undefined ? undefined : assertNonEmptyString(artifactDir, `${label}.artifactDir`),
	};
}

function parseDaemonQueueStatus(value: unknown, label: string): DaemonQueueStatusV1 {
	if (value === undefined) {
		return { depth: 0, preview: [], previewTruncated: false };
	}
	const queue = assertObject(value, label);
	const preview = queue.preview;
	const previewTruncated = queue.previewTruncated;
	if (preview !== undefined && !Array.isArray(preview)) {
		throw new Error(`${label}.preview must be an array`);
	}
	return {
		depth: queue.depth === undefined ? 0 : assertNonNegativeInteger(queue.depth, `${label}.depth`),
		preview:
			preview === undefined
				? []
				: preview.map((entry, index) => parseDaemonQueuedJobPreviewEntry(entry, `${label}.preview[${index}]`)),
		previewTruncated:
			previewTruncated === undefined ? false : assertBoolean(previewTruncated, `${label}.previewTruncated`),
	};
}

function parseDaemonActiveJobStatus(value: unknown, label: string): DaemonActiveJobStatusV1 | null {
	if (value === undefined || value === null) {
		return null;
	}
	const activeJob = assertObject(value, label);
	const enqueuedAt = activeJob.enqueuedAt;
	const startedAt = activeJob.startedAt;
	const artifactDir = activeJob.artifactDir;
	return {
		jobId: assertNonEmptyString(activeJob.jobId, `${label}.jobId`),
		state: assertNonEmptyString(activeJob.state, `${label}.state`),
		enqueuedAt: enqueuedAt === undefined ? undefined : assertNonEmptyString(enqueuedAt, `${label}.enqueuedAt`),
		startedAt: startedAt === undefined ? undefined : assertNonEmptyString(startedAt, `${label}.startedAt`),
		artifactDir: artifactDir === undefined ? undefined : assertNonEmptyString(artifactDir, `${label}.artifactDir`),
	};
}

function parseResultStatus(value: unknown, label: string): ResultStatus {
	if (value === "success" || value === "failed" || value === "timeout") {
		return value;
	}
	throw new Error(`${label} must be one of "success", "failed", "timeout"`);
}

function parseDaemonRecentResults(value: unknown, label: string): DaemonRecentResultSummaryV1[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	return value.map((entry, index) => {
		const result = assertObject(entry, `${label}[${index}]`);
		const submission = result.submission;
		const enqueuedAt = result.enqueuedAt;
		const startedAt = result.startedAt;
		const summary = result.summary;
		const failureReason = result.failureReason;
		const resultFile = result.resultFile;
		const artifactDir = result.artifactDir;
		return {
			jobId: assertNonEmptyString(result.jobId, `${label}[${index}].jobId`),
			status: parseResultStatus(result.status, `${label}[${index}].status`),
			finishedAt: assertNonEmptyString(result.finishedAt, `${label}[${index}].finishedAt`),
			submission: parseDaemonSubmissionSource(submission, `${label}[${index}].submission`),
			enqueuedAt:
				enqueuedAt === undefined ? undefined : assertNonEmptyString(enqueuedAt, `${label}[${index}].enqueuedAt`),
			startedAt:
				startedAt === undefined ? undefined : assertNonEmptyString(startedAt, `${label}[${index}].startedAt`),
			summary: summary === undefined ? undefined : assertNonEmptyString(summary, `${label}[${index}].summary`),
			failureReason:
				failureReason === undefined
					? undefined
					: assertNonEmptyString(failureReason, `${label}[${index}].failureReason`),
			resultFile:
				resultFile === undefined ? undefined : assertNonEmptyString(resultFile, `${label}[${index}].resultFile`),
			artifactDir:
				artifactDir === undefined ? undefined : assertNonEmptyString(artifactDir, `${label}[${index}].artifactDir`),
		};
	});
}

function parseGitHubRepoConfigEntry(value: unknown, label: string): NormalizedDaemonGitHubRepoConfig {
	const entry = assertObject(value, label);
	const result: NormalizedDaemonGitHubRepoConfig = {
		url: assertNonEmptyString(entry.url, `${label}.url`),
		baseBranch: assertNonEmptyString(entry.baseBranch, `${label}.baseBranch`),
		triggerLabel: assertNonEmptyString(entry.triggerLabel, `${label}.triggerLabel`),
	};
	if (entry.taskClassOverrides !== undefined) {
		const overrides = assertObject(entry.taskClassOverrides, `${label}.taskClassOverrides`);
		const validated: Record<string, TaskClass> = {};
		for (const [key, val] of Object.entries(overrides)) {
			assertNonEmptyString(key, `${label}.taskClassOverrides key`);
			const valStr = assertNonEmptyString(val, `${label}.taskClassOverrides["${key}"]`);
			if (!TASK_CLASSES.includes(valStr as TaskClass)) {
				throw new Error(
					`${label}.taskClassOverrides["${key}"] must be one of ${TASK_CLASSES.map((c) => `"${c}"`).join(", ")}`,
				);
			}
			validated[key] = valStr as TaskClass;
		}
		result.taskClassOverrides = validated;
	}
	return result;
}

function parseAppAuth(value: unknown, label: string): GitHubAppAuthConfig {
	const obj = assertObject(value, label);
	return {
		appId: assertPositiveInteger(obj.appId, `${label}.appId`),
		privateKeyPath: assertNonEmptyString(obj.privateKeyPath, `${label}.privateKeyPath`),
		installationId: assertPositiveInteger(obj.installationId, `${label}.installationId`),
	};
}

function parseGitHubConfig(value: unknown, label: string): DaemonGitHubConfig {
	const gh = assertObject(value, label);
	if (!Array.isArray(gh.repos) || gh.repos.length === 0) {
		throw new Error(`${label}.repos must be a non-empty array`);
	}
	const repos = gh.repos.map((entry: unknown, index: number) =>
		parseGitHubRepoConfigEntry(entry, `${label}.repos[${index}]`),
	);
	const token = gh.token;
	const pollIntervalMs = gh.pollIntervalMs;
	const appAuth = gh.appAuth === undefined ? undefined : parseAppAuth(gh.appAuth, `${label}.appAuth`);
	const gpgKeyId = gh.gpgKeyId;
	const botUsername = gh.botUsername;
	return {
		repos,
		token: token === undefined ? undefined : assertNonEmptyString(token, `${label}.token`),
		pollIntervalMs:
			pollIntervalMs === undefined ? undefined : assertPositiveInteger(pollIntervalMs, `${label}.pollIntervalMs`),
		appAuth,
		gpgKeyId: gpgKeyId === undefined ? undefined : assertNonEmptyString(gpgKeyId, `${label}.gpgKeyId`),
		botUsername: botUsername === undefined ? undefined : assertNonEmptyString(botUsername, `${label}.botUsername`),
	};
}
function normalizeGitHubConfig(raw: unknown, label: string): NormalizedDaemonGitHubConfig {
	const parsed = parseGitHubConfig(raw, label);
	return {
		repos: parsed.repos,
		token: parsed.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined,
		pollIntervalMs: parsed.pollIntervalMs ?? DEFAULT_GITHUB_POLL_INTERVAL_MS,
		appAuth: parsed.appAuth,
		gpgKeyId: parsed.gpgKeyId,
		botUsername: parsed.botUsername,
	};
}

function normalizeWebhookConfig(raw: unknown, label: string): NormalizedDaemonWebhookConfig {
	const wh = assertObject(raw, label);
	const enabled = wh.enabled === undefined ? false : assertBoolean(wh.enabled, `${label}.enabled`);
	const port = wh.port === undefined ? DEFAULT_WEBHOOK_PORT : assertPositiveInteger(wh.port, `${label}.port`);
	if (enabled && (wh.secret === undefined || wh.secret === "")) {
		throw new Error(
			`${label}.secret is required when webhook is enabled. ` +
				"Set it to the GitHub webhook secret configured for your repository.",
		);
	}
	const secret = assertNonEmptyString(wh.secret, `${label}.secret`);
	const rateLimitPerRepoPerMin =
		wh.rateLimitPerRepoPerMin === undefined
			? DEFAULT_WEBHOOK_RATE_LIMIT_PER_REPO_PER_MIN
			: assertPositiveInteger(wh.rateLimitPerRepoPerMin, `${label}.rateLimitPerRepoPerMin`);
	return { enabled, port, secret, rateLimitPerRepoPerMin };
}

export function normalizeDaemonConfig(value: unknown, source: string = "daemon config"): NormalizedDaemonConfigV1 {
	const root = assertObject(value, source);
	if (root.version !== DAEMON_CONFIG_VERSION_V1) {
		throw new Error(`${source}.version must be "${DAEMON_CONFIG_VERSION_V1}"`);
	}

	const baseDir = resolveConfigBaseDir(source);
	const paths = assertObject(root.paths, `${source}.paths`);
	const runtime = root.runtime === undefined ? {} : assertObject(root.runtime, `${source}.runtime`);
	const status = root.status === undefined ? {} : assertObject(root.status, `${source}.status`);

	const stateDir = resolveConfigPath(baseDir, assertNonEmptyString(paths.stateDir, `${source}.paths.stateDir`));
	const resultsDir = resolveConfigPath(baseDir, assertNonEmptyString(paths.resultsDir, `${source}.paths.resultsDir`));
	const statusFile =
		status.file === undefined
			? join(stateDir, DEFAULT_DAEMON_STATUS_FILE)
			: resolveConfigPath(baseDir, assertNonEmptyString(status.file, `${source}.status.file`));
	const heartbeatIntervalMs =
		runtime.heartbeatIntervalMs === undefined
			? DEFAULT_DAEMON_HEARTBEAT_INTERVAL_MS
			: assertPositiveInteger(runtime.heartbeatIntervalMs, `${source}.runtime.heartbeatIntervalMs`);
	const idleSleepMs =
		runtime.idleSleepMs === undefined
			? DEFAULT_DAEMON_IDLE_SLEEP_MS
			: assertPositiveInteger(runtime.idleSleepMs, `${source}.runtime.idleSleepMs`);
	const pretty = status.pretty === undefined ? true : assertBoolean(status.pretty, `${source}.status.pretty`);
	const github = root.github === undefined ? undefined : normalizeGitHubConfig(root.github, `${source}.github`);

	// Optional model override — { provider, modelId }
	let model: import("./types").DaemonModelConfig | undefined;
	if (root.model !== undefined) {
		const m = assertObject(root.model, `${source}.model`);
		model = {
			provider: assertNonEmptyString(m.provider, `${source}.model.provider`),
			modelId: assertNonEmptyString(m.modelId, `${source}.model.modelId`),
		};
	}

	const identityRaw = root.identity === undefined ? {} : assertObject(root.identity, `${source}.identity`);
	const botUrl =
		identityRaw.botUrl === undefined
			? DEFAULT_BOT_URL
			: assertNonEmptyString(identityRaw.botUrl, `${source}.identity.botUrl`);

	return {
		version: DAEMON_CONFIG_VERSION_V1,
		paths: {
			stateDir,
			resultsDir,
			statusFile,
			pidFile: join(stateDir, DEFAULT_DAEMON_PID_FILE),
			lockFile: join(stateDir, DEFAULT_DAEMON_LOCK_FILE),
		},
		status: {
			format: "json",
			file: statusFile,
			pretty,
		},
		runtime: {
			heartbeatIntervalMs,
			idleSleepMs,
		},
		github,
		identity: { botUrl },
		model,
		webhook: root.webhook === undefined ? undefined : normalizeWebhookConfig(root.webhook, `${source}.webhook`),
	};
}

export function parseDaemonConfigText(text: string, source: string): NormalizedDaemonConfigV1 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as DaemonConfigV1;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid JSON";
		throw new Error(`${source}: ${message}`);
	}
	return normalizeDaemonConfig(parsed, source);
}

export function loadDaemonConfig(configFilePath: string): NormalizedDaemonConfigV1 {
	const text = readFileSync(configFilePath, "utf-8");
	return parseDaemonConfigText(text, configFilePath);
}

export function normalizeDaemonStatus(value: unknown, label: string = "daemon status"): DaemonStatusV1 {
	const root = assertObject(value, label);
	if (root.version !== DAEMON_STATUS_VERSION_V1) {
		throw new Error(`${label}.version must be "${DAEMON_STATUS_VERSION_V1}"`);
	}

	const state = root.state;
	if (typeof state !== "string" || !DAEMON_LIFECYCLE_STATES.includes(state as DaemonLifecycleState)) {
		throw new Error(
			`${label}.state must be one of ${DAEMON_LIFECYCLE_STATES.map((value) => `"${value}"`).join(", ")}`,
		);
	}

	const normalizedState = state as DaemonLifecycleState;
	const paths = assertObject(root.paths, `${label}.paths`);
	const pid = root.pid;
	const startedAt = root.startedAt;
	const heartbeatAt = root.heartbeatAt;

	return {
		version: DAEMON_STATUS_VERSION_V1,
		state: normalizedState,
		pid: pid === undefined ? undefined : assertPositiveInteger(pid, `${label}.pid`),
		startedAt: startedAt === undefined ? undefined : assertNonEmptyString(startedAt, `${label}.startedAt`),
		heartbeatAt: heartbeatAt === undefined ? undefined : assertNonEmptyString(heartbeatAt, `${label}.heartbeatAt`),
		lastTransitionAt: assertNonEmptyString(root.lastTransitionAt, `${label}.lastTransitionAt`),
		paths: {
			stateDir: assertNonEmptyString(paths.stateDir, `${label}.paths.stateDir`),
			resultsDir: assertNonEmptyString(paths.resultsDir, `${label}.paths.resultsDir`),
			statusFile: assertNonEmptyString(paths.statusFile, `${label}.paths.statusFile`),
			pidFile: assertNonEmptyString(paths.pidFile, `${label}.paths.pidFile`),
			lockFile: assertNonEmptyString(paths.lockFile, `${label}.paths.lockFile`),
		},
		lastError: parseDaemonErrorSummary(root.lastError, `${label}.lastError`),
		queue: parseDaemonQueueStatus(root.queue, `${label}.queue`),
		activeJob: parseDaemonActiveJobStatus(root.activeJob, `${label}.activeJob`),
		recentResults: parseDaemonRecentResults(root.recentResults, `${label}.recentResults`),
	};
}

export function createDaemonStatus(config: NormalizedDaemonConfigV1, input: CreateDaemonStatusInput): DaemonStatusV1 {
	return normalizeDaemonStatus(
		{
			version: DAEMON_STATUS_VERSION_V1,
			state: input.state,
			pid: input.pid,
			startedAt: input.startedAt,
			heartbeatAt: input.heartbeatAt,
			lastTransitionAt: input.lastTransitionAt ?? new Date().toISOString(),
			paths: config.paths,
			lastError: input.lastError,
			queue: input.queue,
			activeJob: input.activeJob,
			recentResults: input.recentResults,
		},
		"daemon status",
	);
}
