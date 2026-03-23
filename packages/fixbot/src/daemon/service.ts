import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDaemonStatus, loadDaemonConfig } from "../config";
import { type Logger, toLogCallback } from "../logger";
import { runJob } from "../runner";
import type {
	DaemonErrorSummary,
	DaemonJobEnvelopeV1,
	DaemonRecentResultSummaryV1,
	DaemonStatusV1,
	JobResultV1,
	NormalizedDaemonConfigV1,
	NormalizedJobSpecV1,
} from "../types";
import { exchangeInstallationToken, isTokenExpiringSoon, type TokenCache } from "./github-app-auth";
import type { GitHubPollResult } from "./github-poller";
import { createWebhookServer, type WebhookServer } from "./webhook-server";
import { pollGitHubRepos } from "./github-poller";
import { reportJobResult } from "./github-reporter";
import {
	buildQueueStatusFromSpool,
	type ClaimedDaemonJobRecord,
	claimNextQueuedDaemonJob,
	enqueueDaemonJob,
	listOrphanedActiveDaemonJobs,
	listQueuedDaemonJobs,
	removeActiveDaemonJob,
	requeueOrphanedDaemonJob,
} from "./job-store";
import {
	cleanupDaemonRuntimeFiles,
	ensureDaemonStateDirectories,
	inspectDaemon,
	isProcessRunning,
	mergeDaemonStatus,
	mergeSpoolReconciliation,
	persistInspection,
	readDaemonStatusFile,
	writeDaemonLockFile,
	writeDaemonPidFile,
	writeDaemonStatusFile,
} from "./status-store";

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_INTERVAL_MS = 50;
const DEFAULT_RECENT_RESULTS_LIMIT = 10;

export interface StartDaemonOptions {
	startupTimeoutMs?: number;
	cwd?: string;
}

export interface StartedDaemon {
	pid: number;
	config: NormalizedDaemonConfigV1;
	status: DaemonStatusV1;
}

export interface DaemonJobRunnerOptions {
	resultsDir: string;
	configModel?: import("../types").DaemonModelConfig;
	logger?: Logger;
}

export type DaemonJobRunner = (job: NormalizedJobSpecV1, options: DaemonJobRunnerOptions) => Promise<JobResultV1>;

export type GitHubPollerFn = (config: NormalizedDaemonConfigV1) => Promise<GitHubPollResult>;

export type GitHubReporterFn = (
	envelope: DaemonJobEnvelopeV1,
	result: JobResultV1,
	config: NormalizedDaemonConfigV1,
	logger?: (message: string) => void,
) => Promise<void>;

export interface RunDaemonOptions {
	configFilePath?: string;
	signal?: AbortSignal;
	installSignalHandlers?: boolean;
	logger?: Logger;
	jobRunner?: DaemonJobRunner;
	githubPoller?: GitHubPollerFn;
	githubReporter?: GitHubReporterFn;
	recentResultsLimit?: number;
	tokenProvider?: () => Promise<string>;
}

export interface StopDaemonResult {
	status: DaemonStatusV1;
	stoppedPid?: number;
	alreadyStopped: boolean;
}

interface TransitionStatusFields {
	state?: DaemonStatusV1["state"];
	pid?: number | null;
	heartbeatAt?: string | null;
	lastError?: DaemonErrorSummary | null;
	queue?: DaemonStatusV1["queue"];
	activeJob?: DaemonStatusV1["activeJob"];
	recentResults?: DaemonStatusV1["recentResults"];
}

function buildErrorSummary(message: string, code: string): DaemonErrorSummary {
	return {
		message,
		code,
		at: new Date().toISOString(),
	};
}

function renderLog(logger: Logger | undefined, message: string): void {
	logger?.info(message);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(createAbortError());
	}

	return new Promise((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			cleanup();
			resolvePromise();
		}, milliseconds);
		const cleanup = () => {
			clearTimeout(timer);
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
		};
		const onAbort = () => {
			cleanup();
			rejectPromise(createAbortError());
		};
		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function createAbortError(): Error {
	const error = new Error("The daemon run was aborted");
	error.name = "AbortError";
	return error;
}

function resolveCliLaunch(): { command: string; args: string[] } {
	if (!process.argv[1]) {
		throw new Error("Unable to determine fixbot CLI path for background daemon");
	}
	return {
		command: process.execPath,
		args: [process.argv[1]],
	};
}

function transitionStatus(
	config: NormalizedDaemonConfigV1,
	currentStatus: DaemonStatusV1,
	fields: TransitionStatusFields,
	logger?: Logger,
): DaemonStatusV1 {
	const nextStatus = mergeDaemonStatus(config, currentStatus, {
		state: fields.state,
		pid: fields.pid,
		heartbeatAt: fields.heartbeatAt,
		lastTransitionAt: new Date().toISOString(),
		lastError: fields.lastError,
		queue: fields.queue,
		activeJob: fields.activeJob,
		recentResults: fields.recentResults,
	});
	writeDaemonStatusFile(config, { status: nextStatus });
	renderLog(
		logger,
		`state=${nextStatus.state} pid=${nextStatus.pid ?? "none"} heartbeat=${nextStatus.heartbeatAt ?? "none"} queue=${nextStatus.queue.depth} active=${nextStatus.activeJob?.jobId ?? "none"}`,
	);
	return nextStatus;
}

function createStopStatus(config: NormalizedDaemonConfigV1, currentStatus: DaemonStatusV1): DaemonStatusV1 {
	return createDaemonStatus(config, {
		state: currentStatus.state === "error" ? "error" : "degraded",
		startedAt: currentStatus.startedAt,
		heartbeatAt: new Date().toISOString(),
		lastTransitionAt: new Date().toISOString(),
		lastError: buildErrorSummary("daemon stopped by operator", "STOPPED"),
		queue: currentStatus.queue,
		activeJob: currentStatus.activeJob,
		recentResults: currentStatus.recentResults,
	});
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolvePromise, rejectPromise) => {
		const poll = async () => {
			try {
				if (!isProcessRunning(pid)) {
					resolvePromise(true);
					return;
				}
				if (Date.now() >= deadline) {
					resolvePromise(false);
					return;
				}
				await sleep(STOP_POLL_INTERVAL_MS);
				void poll();
			} catch (error) {
				rejectPromise(error);
			}
		};
		void poll();
	});
}

function ensureStartable(config: NormalizedDaemonConfigV1): void {
	const inspection = inspectDaemon(config);
	if (inspection.processRunning && inspection.observedPid !== undefined) {
		throw new Error(`fixbot daemon is already running with pid ${inspection.observedPid}`);
	}
}

function spawnBackgroundProcess(configFilePath: string, cwd: string): ChildProcess {
	const launch = resolveCliLaunch();
	const child = spawn(
		launch.command,
		[...launch.args, "daemon", "start", "--config", configFilePath, "--foreground"],
		{
			cwd,
			detached: true,
			stdio: "ignore",
			env: process.env,
		},
	);
	child.unref();
	return child;
}

async function waitForDaemonReady(config: NormalizedDaemonConfigV1, timeoutMs: number): Promise<DaemonStatusV1> {
	const deadline = Date.now() + timeoutMs;
	let latestStatus = inspectDaemon(config).status;
	while (Date.now() < deadline) {
		const inspection = inspectDaemon(config);
		latestStatus = inspection.status;
		if (inspection.processRunning && (latestStatus.state === "idle" || latestStatus.state === "running" || latestStatus.state === "degraded")) {
			return latestStatus;
		}
		if (latestStatus.state === "error") {
			return latestStatus;
		}
		await sleep(50);
	}
	throw new Error(`Timed out waiting for fixbot daemon startup at ${config.paths.statusFile}`);
}

function publishHeartbeat(
	config: NormalizedDaemonConfigV1,
	currentStatus: DaemonStatusV1,
	pid: number,
	startedAt: string,
	configFilePath: string | undefined,
	logger?: Logger,
	queueStatus?: DaemonStatusV1["queue"],
): DaemonStatusV1 {
	const heartbeatAt = new Date().toISOString();
	writeDaemonLockFile(config, {
		pid,
		startedAt,
		updatedAt: heartbeatAt,
		configFilePath,
	});
	return transitionStatus(
		config,
		currentStatus,
		{
			pid,
			heartbeatAt,
			queue: queueStatus ?? currentStatus.queue,
		},
		logger,
	);
}

function appendRecentResult(
	recentResults: DaemonRecentResultSummaryV1[],
	result: DaemonRecentResultSummaryV1,
	limit: number,
): DaemonRecentResultSummaryV1[] {
	return [result, ...recentResults].slice(0, limit);
}

function createActiveJobStatus(
	claimed: ClaimedDaemonJobRecord,
	startedAt: string,
): NonNullable<DaemonStatusV1["activeJob"]> {
	return {
		jobId: claimed.envelope.jobId,
		state: "running",
		enqueuedAt: claimed.envelope.enqueuedAt,
		startedAt,
		artifactDir: claimed.envelope.artifacts.artifactDir,
	};
}

function createRecentResultSummary(
	envelope: DaemonJobEnvelopeV1,
	startedAt: string,
	result: JobResultV1,
): DaemonRecentResultSummaryV1 {
	return {
		jobId: result.jobId,
		status: result.status,
		finishedAt: result.execution.finishedAt,
		submission: envelope.submission,
		enqueuedAt: envelope.enqueuedAt,
		startedAt,
		summary: result.summary,
		failureReason: result.failureReason,
		resultFile: result.artifacts.resultFile,
		artifactDir: result.artifacts.rootDir,
	};
}

function createRunnerFailureResult(
	envelope: DaemonJobEnvelopeV1,
	startedAt: string,
	error: unknown,
): DaemonRecentResultSummaryV1 {
	const failureReason = error instanceof Error ? error.message : String(error);
	return {
		jobId: envelope.jobId,
		status: "failed",
		finishedAt: new Date().toISOString(),
		submission: envelope.submission,
		enqueuedAt: envelope.enqueuedAt,
		startedAt,
		summary: "daemon runner failed before producing a result",
		failureReason,
		resultFile: envelope.artifacts.resultFile,
		artifactDir: envelope.artifacts.artifactDir,
	};
}

async function runClaimedDaemonJob(
	config: NormalizedDaemonConfigV1,
	currentStatus: DaemonStatusV1,
	claimed: ClaimedDaemonJobRecord,
	pid: number,
	daemonStartedAt: string,
	configFilePath: string | undefined,
	jobRunner: DaemonJobRunner,
	recentResultsLimit: number,
	logger?: Logger,
	githubReporter?: GitHubReporterFn,
): Promise<DaemonStatusV1> {
	const jobStartedAt = new Date().toISOString();
	const spoolQueueAfterClaim = buildQueueStatusFromSpool(config);
	writeDaemonLockFile(config, {
		pid,
		startedAt: daemonStartedAt,
		updatedAt: jobStartedAt,
		configFilePath,
	});
	currentStatus = transitionStatus(
		config,
		currentStatus,
		{
			state: "running",
			pid,
			heartbeatAt: jobStartedAt,
			lastError: null,
			queue: spoolQueueAfterClaim,
			activeJob: createActiveJobStatus(claimed, jobStartedAt),
		},
		logger,
	);
	renderLog(logger, `claimed job=${claimed.envelope.jobId} queue=${spoolQueueAfterClaim.depth}`);

	const heartbeatTimer = setInterval(() => {
		currentStatus = publishHeartbeat(
			config,
			currentStatus,
			pid,
			daemonStartedAt,
			configFilePath,
			logger,
			buildQueueStatusFromSpool(config),
		);
	}, config.runtime.heartbeatIntervalMs);
	heartbeatTimer.unref?.();

	try {
		const result = await jobRunner(claimed.envelope.job, {
			resultsDir: config.paths.resultsDir,
			configModel: config.model,
			logger,
		});
		removeActiveDaemonJob(config, claimed.envelope.jobId);
		const recentResults = appendRecentResult(
			currentStatus.recentResults,
			createRecentResultSummary(claimed.envelope, jobStartedAt, result),
			recentResultsLimit,
		);
		const idleStatus = publishHeartbeat(
			config,
			currentStatus,
			pid,
			daemonStartedAt,
			configFilePath,
			undefined,
			buildQueueStatusFromSpool(config),
		);
		if (result.status === "success") {
			logger?.success(`job complete — ${claimed.envelope.jobId} status=${result.status}`);
		} else {
			logger?.warn(`job complete — ${claimed.envelope.jobId} status=${result.status}`);
		}
		if (githubReporter) {
			try {
				await githubReporter(claimed.envelope, result, config, logger ? toLogCallback(logger) : undefined);
			} catch (reportError) {
				logger?.error(
					`github-report error: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
				);
			}
		}
		return transitionStatus(
			config,
			idleStatus,
			{
				state: "idle",
				lastError: null,
				activeJob: null,
				recentResults,
			},
			logger,
		);
	} catch (error) {
		removeActiveDaemonJob(config, claimed.envelope.jobId);
		const recentResult = createRunnerFailureResult(claimed.envelope, jobStartedAt, error);
		const recentResults = appendRecentResult(currentStatus.recentResults, recentResult, recentResultsLimit);
		const errorMessage = error instanceof Error ? error.message : String(error);
		const idleStatus = publishHeartbeat(
			config,
			currentStatus,
			pid,
			daemonStartedAt,
			configFilePath,
			undefined,
			buildQueueStatusFromSpool(config),
		);
		logger?.error(`job runner failed — ${claimed.envelope.jobId}: ${errorMessage}`);
		return transitionStatus(
			config,
			idleStatus,
			{
				state: "idle",
				lastError: buildErrorSummary(`job ${claimed.envelope.jobId} failed: ${errorMessage}`, "JOB_RUNNER_ERROR"),
				activeJob: null,
				recentResults,
			},
			logger,
		);
	} finally {
		clearInterval(heartbeatTimer);
	}
}

export async function startDaemonInBackground(
	configFilePath: string,
	options: StartDaemonOptions = {},
): Promise<StartedDaemon> {
	const resolvedConfigFilePath = resolve(configFilePath);
	const config = loadDaemonConfig(resolvedConfigFilePath);
	ensureDaemonStateDirectories(config);
	ensureStartable(config);
	const child = spawnBackgroundProcess(resolvedConfigFilePath, options.cwd ?? process.cwd());
	if (!child.pid) {
		throw new Error("Failed to spawn detached fixbot daemon process");
	}
	const status = await waitForDaemonReady(config, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
	return {
		pid: status.pid ?? child.pid,
		config,
		status,
	};
}

export async function runDaemonFromConfigFile(
	configFilePath: string,
	options: Omit<RunDaemonOptions, "configFilePath"> = {},
): Promise<void> {
	const resolvedConfigFilePath = resolve(configFilePath);
	const config = loadDaemonConfig(resolvedConfigFilePath);
	await runDaemon(config, {
		...options,
		configFilePath: resolvedConfigFilePath,
	});
}

export async function runDaemon(config: NormalizedDaemonConfigV1, options: RunDaemonOptions = {}): Promise<void> {
	ensureDaemonStateDirectories(config);
	ensureStartable(config);

	const logger = options.logger;
	const jobRunner = options.jobRunner ?? runJob;
	const recentResultsLimit = options.recentResultsLimit ?? DEFAULT_RECENT_RESULTS_LIMIT;
	const startedAt = new Date().toISOString();
	const pid = process.pid;

	// Build the GitHub poller: use injected poller if provided, otherwise create default when config.github exists.
	const defaultGitHubPoller: GitHubPollerFn | undefined = config.github
		? async (cfg) => {
				if (!cfg.github) {
					return { enqueued: [], skipped: 0, errors: 0 };
				}
				return pollGitHubRepos(
					cfg.github,
					cfg.paths.resultsDir,
					(envelope) => enqueueDaemonJob(cfg, envelope),
					logger ? toLogCallback(logger) : undefined,
				);
			}
		: undefined;
	const activeGitHubPoller = options.githubPoller ?? defaultGitHubPoller;
	let lastGitHubPollMs = 0;

	// App auth token resolution: resolve installation tokens before first poll.
	let tokenCache: TokenCache | undefined;
	const resolveToken = async (): Promise<void> => {
		if (options.tokenProvider) {
			config.github!.token = await options.tokenProvider();
			return;
		}
		if (config.github?.appAuth && !config.github.token) {
			const pem = readFileSync(config.github.appAuth.privateKeyPath, "utf-8");
			tokenCache = await exchangeInstallationToken(
				config.github.appAuth.appId,
				pem,
				config.github.appAuth.installationId,
			);
			config.github.token = tokenCache.token;
			renderLog(logger, `app-auth: exchanged installation token, expires at ${tokenCache.expiresAt.toISOString()}`);
		}
	};

	// Build the GitHub reporter: use injected reporter if provided, otherwise use default when token or appAuth exists.
	const defaultGitHubReporter: GitHubReporterFn | undefined =
		config.github?.token || config.github?.appAuth || options.tokenProvider ? reportJobResult : undefined;
	const activeGitHubReporter = options.githubReporter ?? defaultGitHubReporter;

	// Seed recentResults and queue preview from the durable status snapshot so they survive a stop/start cycle.
	const priorStatus = readDaemonStatusFile(config);
	const seededRecentResults = priorStatus?.recentResults ?? [];
	let spoolQueueAtStart = buildQueueStatusFromSpool(config);
	const orphansAtStart = listOrphanedActiveDaemonJobs(config, undefined);

	let currentStatus = createDaemonStatus(config, {
		state: "starting",
		pid,
		startedAt,
		heartbeatAt: startedAt,
		lastTransitionAt: startedAt,
		queue: spoolQueueAtStart,
		recentResults: seededRecentResults,
	});

	// Recover orphaned active spool files left behind by a crashed daemon.
	let orphanRecoveryFailed = false;
	if (orphansAtStart.length > 0) {
		let recoveryError: DaemonErrorSummary | undefined;
		for (const orphan of orphansAtStart) {
			try {
				const action = requeueOrphanedDaemonJob(config, orphan);
				renderLog(
					logger,
					action === "requeued"
						? `re-queued orphaned job: ${orphan.envelope.jobId}`
						: `cleaned up completed orphan: ${orphan.envelope.jobId}`,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger?.error(`failed to recover orphan ${orphan.envelope.jobId}: ${message}`);
				recoveryError = buildErrorSummary(
					`failed to recover orphaned job ${orphan.envelope.jobId}: ${message}`,
					"ORPHAN_RECOVERY_ERROR",
				);
				orphanRecoveryFailed = true;
			}
		}
		// Refresh queue status after recovery so it reflects re-queued jobs.
		spoolQueueAtStart = buildQueueStatusFromSpool(config);
		currentStatus = mergeDaemonStatus(config, currentStatus, {
			queue: spoolQueueAtStart,
			...(recoveryError ? { lastError: recoveryError } : {}),
		});
	}

	let webhookServer: WebhookServer | undefined;
	let shuttingDown = false;
	let stopSummary: DaemonErrorSummary | undefined;

	const onShutdownSignal = () => {
		shuttingDown = true;
		stopSummary = buildErrorSummary("daemon stopped by operator", "STOPPED");
	};

	const installSignalHandlers = options.installSignalHandlers ?? true;
	if (installSignalHandlers) {
		process.on("SIGTERM", onShutdownSignal);
		process.on("SIGINT", onShutdownSignal);
	}

	try {
		writeDaemonPidFile(config, pid);
		writeDaemonLockFile(config, {
			pid,
			startedAt,
			updatedAt: startedAt,
			configFilePath: options.configFilePath,
		});
		writeDaemonStatusFile(config, { status: currentStatus });
		renderLog(logger, `state=${currentStatus.state} pid=${pid}`);
		currentStatus = transitionStatus(
			config,
			currentStatus,
			{ state: orphanRecoveryFailed ? "degraded" : "idle", pid, heartbeatAt: startedAt },
			logger,
		);

		// Resolve App auth token before the first poll cycle.
		if (options.tokenProvider || (config.github?.appAuth && !config.github.token)) {
			await resolveToken();
		}

		// Start webhook server if configured and enabled.
		if (config.webhook?.enabled) {
			try {
				webhookServer = createWebhookServer({
					config,
					webhookConfig: config.webhook,
					logger,
				});
				renderLog(logger, `webhook: server started on port ${webhookServer.port}`);
			} catch (webhookError) {
				const msg = webhookError instanceof Error ? webhookError.message : String(webhookError);
				logger?.error(`webhook: failed to start server: ${msg}`);
			}
		}

		let lastHeartbeatMs = Date.parse(startedAt);
		while (!shuttingDown) {
			const claimed = claimNextQueuedDaemonJob(config);
			if (claimed) {
				currentStatus = await runClaimedDaemonJob(
					config,
					currentStatus,
					claimed,
					pid,
					startedAt,
					options.configFilePath,
					jobRunner,
					recentResultsLimit,
					logger,
					activeGitHubReporter,
				);
				lastHeartbeatMs = Date.parse(currentStatus.heartbeatAt ?? new Date().toISOString());
				continue;
			}

			const queuedDepth = listQueuedDaemonJobs(config).length;
			if (queuedDepth !== currentStatus.queue.depth) {
				const spoolQueue = buildQueueStatusFromSpool(config);
				const orphans = listOrphanedActiveDaemonJobs(config, currentStatus.activeJob?.jobId).map(
					(r) => r.envelope.jobId,
				);
				currentStatus =
					orphans.length > 0
						? mergeSpoolReconciliation(config, currentStatus, spoolQueue, orphans)
						: transitionStatus(config, currentStatus, { queue: spoolQueue }, logger);
			}

			// GitHub poll on its own interval, independent of spool claim.
			if (activeGitHubPoller && config.github) {
				const now = Date.now();
				if (now - lastGitHubPollMs >= config.github.pollIntervalMs) {
					// Proactively refresh App auth token before polling.
					if (tokenCache && isTokenExpiringSoon(tokenCache)) {
						try {
							await resolveToken();
							renderLog(logger, "app-auth: refreshed installation token");
						} catch (refreshError) {
						logger?.error(
							`app-auth: token refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
						);
						}
					}
					try {
						const pollResult = await activeGitHubPoller(config);
						renderLog(
							logger,
							`github-poll repos=${config.github.repos.length} enqueued=${pollResult.enqueued.length} skipped=${pollResult.skipped} errors=${pollResult.errors}`,
						);
						lastGitHubPollMs = now;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
					logger?.error(`github-poll error: ${message}`);
						currentStatus = transitionStatus(
							config,
							currentStatus,
							{
								lastError: buildErrorSummary(message, "GITHUB_POLL_ERROR"),
							},
							logger,
						);
						lastGitHubPollMs = now; // Avoid tight retry loop on persistent errors.
					}
				}
			}

			await sleep(config.runtime.idleSleepMs, options.signal);
			const now = Date.now();
			if (now - lastHeartbeatMs >= config.runtime.heartbeatIntervalMs) {
				currentStatus = publishHeartbeat(
					config,
					currentStatus,
					pid,
					startedAt,
					options.configFilePath,
					logger,
					buildQueueStatusFromSpool(config),
				);
				lastHeartbeatMs = now;
			}
		}
	} catch (error) {
		if (!isAbortError(error)) {
			const message = error instanceof Error ? error.message : String(error);
			currentStatus = transitionStatus(
				config,
				currentStatus,
				{
					state: "error",
					pid,
					lastError: buildErrorSummary(message, "DAEMON_RUNTIME_ERROR"),
				},
				logger,
			);
			throw error;
		}
		stopSummary = stopSummary ?? buildErrorSummary("daemon stopped by operator", "STOPPED");
	} finally {
		if (webhookServer) {
			try { await webhookServer.stop(); } catch (e) { logger?.error(`webhook shutdown: ${e instanceof Error ? e.message : String(e)}`); }
		}
		const stopStatus = createDaemonStatus(config, {
			state: currentStatus.state === "error" ? "error" : "degraded",
			startedAt: currentStatus.startedAt,
			heartbeatAt: new Date().toISOString(),
			lastTransitionAt: new Date().toISOString(),
			lastError: stopSummary ?? currentStatus.lastError,
			queue: currentStatus.queue,
			activeJob: currentStatus.activeJob,
			recentResults: currentStatus.recentResults,
		});
		writeDaemonStatusFile(config, { status: stopStatus });
		cleanupDaemonRuntimeFiles(config);
		renderLog(
			logger,
			`state=${stopStatus.state} pid=none heartbeat=${stopStatus.heartbeatAt ?? "none"} queue=${stopStatus.queue.depth} active=${stopStatus.activeJob?.jobId ?? "none"}`,
		);
		if (installSignalHandlers) {
			process.removeListener("SIGTERM", onShutdownSignal);
			process.removeListener("SIGINT", onShutdownSignal);
		}
	}
}

export async function getDaemonStatusFromConfigFile(
	configFilePath: string,
): Promise<{ status: DaemonStatusV1; issues: string[] }> {
	const config = loadDaemonConfig(resolve(configFilePath));
	const inspection = inspectDaemon(config);
	if (inspection.issues.length > 0) {
		persistInspection(config, inspection);
	}
	return {
		status: inspection.status,
		issues: inspection.issues,
	};
}

export async function stopDaemonFromConfigFile(configFilePath: string): Promise<StopDaemonResult> {
	const config = loadDaemonConfig(resolve(configFilePath));
	const inspection = inspectDaemon(config);
	if (!inspection.processRunning || inspection.observedPid === undefined) {
		persistInspection(config, inspection);
		cleanupDaemonRuntimeFiles(config);
		return {
			status: inspection.status,
			alreadyStopped: true,
		};
	}

	process.kill(inspection.observedPid, "SIGTERM");
	const exited = await waitForExit(inspection.observedPid, DEFAULT_STOP_TIMEOUT_MS);
	if (!exited) {
		const timeoutStatus = createDaemonStatus(config, {
			state: "error",
			pid: inspection.observedPid,
			startedAt: inspection.status.startedAt,
			heartbeatAt: inspection.status.heartbeatAt,
			lastTransitionAt: new Date().toISOString(),
			lastError: buildErrorSummary(
				`daemon pid ${inspection.observedPid} did not exit within ${DEFAULT_STOP_TIMEOUT_MS}ms`,
				"STOP_TIMEOUT",
			),
			queue: inspection.status.queue,
			activeJob: inspection.status.activeJob,
			recentResults: inspection.status.recentResults,
		});
		writeDaemonStatusFile(config, { status: timeoutStatus });
		throw new Error(`Timed out stopping fixbot daemon pid ${inspection.observedPid}`);
	}

	cleanupDaemonRuntimeFiles(config);
	const stopStatus = createStopStatus(config, inspection.status);
	writeDaemonStatusFile(config, { status: stopStatus });
	return {
		status: stopStatus,
		stoppedPid: inspection.observedPid,
		alreadyStopped: false,
	};
}
