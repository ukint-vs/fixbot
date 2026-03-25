import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getArtifactPaths, resetArtifactDirectories } from "./artifacts";
import {
	assertDockerGithubAuth,
	createDefaultPreparedJobExecutor,
	ExecutionTimeoutError,
	type PreparedJobContext,
	type PreparedJobExecutor,
} from "./execution";
import {
	captureGitStatus,
	capturePatch,
	cloneRepository,
	configureLocalGitIdentity,
	copyOptionalWorkspaceArtifact,
	countChangedFilesFromStatus,
	countCommittedChangedFiles,
	getHeadCommit,
} from "./git";
import { resolveExecutionModel, resolveHostAgentConfig } from "./host-agent";
import { assertDockerImageReady } from "./image";
import { createStderrLogger, type Logger } from "./logger";
import { deriveResultStatus, parseResultMarkers } from "./markers";
import { getOrCreateWorkspace, type WorkspaceResult } from "./repo-cache";
import {
	type DaemonModelConfig,
	EXECUTION_PLAN_VERSION_V1,
	type ExecutionOutputV1,
	type ExecutionPlanV1,
	JOB_RESULT_VERSION_V1,
	type JobResultV1,
	type ModelSelection,
	type NormalizedJobSpecV1,
	type RepoCacheConfig,
} from "./types";

export interface RunJobOptions {
	resultsDir?: string;
	executor?: PreparedJobExecutor;
	now?: () => Date;
	dockerImageVerifier?: () => Promise<string>;
	/** Model override from daemon config — passed to resolveExecutionModel. */
	configModel?: DaemonModelConfig;
	/** Structured logger. Defaults to a stderr logger scoped to "runner". */
	logger?: Logger;
	/** When set, use the repo cache (bare clone + worktrees) instead of a fresh shallow clone. */
	repoCacheConfig?: RepoCacheConfig;
}

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function safeReadFile(filePath: string): string {
	try {
		return readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function summarizeTimeout(timeoutMs: number): string {
	return `Job timed out after ${timeoutMs}ms.`;
}

function buildExecutionPlan(
	job: NormalizedJobSpecV1,
	baseCommit: string,
	selectedModel: ModelSelection,
): ExecutionPlanV1 {
	return {
		version: EXECUTION_PLAN_VERSION_V1,
		job,
		baseCommit,
		selectedModel,
	};
}

/** Format milliseconds as a human-readable duration, e.g. "2m 18s" or "45s". */
function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * Derive a short context label for the final summary line.
 * For solve_issue: "solve_issue #42"; for fix_ci: "fix_ci run #999"; others: task class.
 */
function buildJobContext(job: NormalizedJobSpecV1): string {
	if (job.taskClass === "solve_issue" && job.solveIssue?.issueNumber !== undefined) {
		return `${job.taskClass} #${job.solveIssue.issueNumber}`;
	}
	if (job.taskClass === "fix_ci" && job.fixCi?.githubActionsRunId !== undefined) {
		return `${job.taskClass} run #${job.fixCi.githubActionsRunId}`;
	}
	return job.taskClass;
}

/**
 * Emit a one-line summary of the completed job.
 * Example: Job abc123 complete — solve_issue #42 (3 files, 2m 18s, claude-sonnet-4-6)
 */
function logFinalSummary(logger: Logger, result: JobResultV1, job: NormalizedJobSpecV1): void {
	const context = buildJobContext(job);
	const duration = formatDuration(result.execution.durationMs);
	const model = result.execution.selectedModel?.modelId ?? "unknown-model";
	const files = result.diagnostics.changedFileCount;
	const detail = `${files} file${files === 1 ? "" : "s"}, ${duration}, ${model}`;
	const line = `Job ${result.jobId} complete \u2014 ${context} (${detail})`;

	switch (result.status) {
		case "success":
			logger.success(line);
			break;
		case "timeout":
			logger.warn(`${line} [timed out]`);
			break;
		default:
			logger.error(line);
	}
}

export async function runJob(job: NormalizedJobSpecV1, options: RunJobOptions = {}): Promise<JobResultV1> {
	const log = options.logger ?? createStderrLogger("runner");
	const now = options.now ?? (() => new Date());
	const startedAt = now();
	const resultsDir = options.resultsDir ?? join(process.cwd(), "results");
	const executor = options.executor ?? createDefaultPreparedJobExecutor();
	const dockerImageVerifier = options.dockerImageVerifier ?? (() => assertDockerImageReady());
	const paths = getArtifactPaths(resultsDir, job.jobId);
	/** Mutable workspace directory — may be overridden by repo-cache worktree. */
	let workspaceDir = paths.workspaceDir;

	log.info(`starting job ${job.jobId} (${job.execution.mode})`);
	log.info(`results will be written under ${paths.artifactDir}`);
	resetArtifactDirectories(paths);
	writeJson(paths.jobSpecFile, job);

	let baseCommit: string | undefined;
	let headCommit: string | undefined;
	let executionOutput: ExecutionOutputV1 | undefined;
	let executionError: string | undefined;
	let timedOut = false;
	let gitStatusText = "";
	let patchText = "";
	let selectedModel: ModelSelection | undefined;
	let cacheResult: WorkspaceResult | undefined;

	try {
		const hostConfig = resolveHostAgentConfig();
		const resolvedModel = await resolveExecutionModel(job, { configModel: options.configModel });
		selectedModel = {
			provider: resolvedModel.provider,
			modelId: resolvedModel.id,
		};
		log.info(`preflight selected model ${resolvedModel.provider}/${resolvedModel.id}`);
		if (job.execution.mode === "docker") {
			assertDockerGithubAuth();
			await dockerImageVerifier();
		}

		// Obtain workspace: repo-cache (bare clone + worktree) or fresh shallow clone.
		const cacheConfig = options.repoCacheConfig;
		if (cacheConfig?.enabled) {
			try {
				log.info(`repo-cache: preparing workspace for ${job.repo.url} @ ${job.repo.baseBranch}`);
				cacheResult = await getOrCreateWorkspace({
					repoUrl: job.repo.url,
					baseBranch: job.repo.baseBranch,
					jobId: job.jobId,
					config: cacheConfig,
					logger: (msg) => log.info(msg),
				});
				// Use the worktree location instead of the default workspace dir.
				workspaceDir = cacheResult.workspaceDir;
				log.info(
					`repo-cache: workspace ready at ${workspaceDir} (fromCache=${cacheResult.fromCache})`,
				);
			} catch (cacheError) {
				log.warn(
					`repo-cache: failed, falling back to fresh clone: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`,
				);
				cacheResult = undefined;
			}
		}

		if (!cacheResult) {
			log.info(`cloning ${job.repo.url} @ ${job.repo.baseBranch}`);
			await cloneRepository(job.repo.url, job.repo.baseBranch, workspaceDir);
		}

		await configureLocalGitIdentity(workspaceDir);
		baseCommit = await getHeadCommit(workspaceDir);
		log.info(`repository ready at ${baseCommit}`);
		writeJson(paths.executionPlanFile, buildExecutionPlan(job, baseCommit, selectedModel));

		const context: PreparedJobContext = {
			job,
			paths: { ...paths, workspaceDir },
			baseCommit,
			hostConfig,
			selectedModel,
		};
		log.info("agent running");
		executionOutput = await executor.execute(context);
		log.info("agent finished");
	} catch (error) {
		timedOut = error instanceof ExecutionTimeoutError;
		executionError = error instanceof Error ? error.message : String(error);
		log.error(`execution failed: ${executionError}`);
	} finally {
		if (existsSync(workspaceDir)) {
			log.info("capturing workspace artifacts");
			try {
				headCommit = await getHeadCommit(workspaceDir);
			} catch {
				headCommit = undefined;
			}

			try {
				patchText = baseCommit ? await capturePatch(workspaceDir, baseCommit, paths.patchFile) : "";
			} catch {
				patchText = safeReadFile(paths.patchFile);
			}

			try {
				gitStatusText = await captureGitStatus(workspaceDir, paths.gitStatusFile);
			} catch {
				gitStatusText = safeReadFile(paths.gitStatusFile);
			}

			copyOptionalWorkspaceArtifact(workspaceDir, "TODO.md", paths.todoFile);
			copyOptionalWorkspaceArtifact(workspaceDir, "ci-log.txt", paths.ciLogFile);
			if (!existsSync(paths.ciLogFile)) {
				copyOptionalWorkspaceArtifact(workspaceDir, ".fixbot/ci-log.txt", paths.ciLogFile);
			}
		}
	}

	if (!existsSync(paths.patchFile)) {
		writeFileSync(paths.patchFile, patchText, "utf-8");
	}
	if (!existsSync(paths.assistantFinalFile)) {
		writeFileSync(paths.assistantFinalFile, executionOutput?.assistantFinalText ?? "", "utf-8");
	}

	const assistantFinalText = executionOutput?.assistantFinalText ?? safeReadFile(paths.assistantFinalFile);
	const parsedMarkers = executionOutput?.parsedMarkers ?? parseResultMarkers(assistantFinalText);

	let status: JobResultV1["status"];
	let summary: string;
	let failureReason: string | undefined;
	if (timedOut) {
		status = "timeout";
		summary = summarizeTimeout(job.execution.timeoutMs);
		failureReason = executionError;
	} else {
		const derived = deriveResultStatus({
			assistantFinalText,
			patchText,
			parsedMarkers,
			assistantError: executionOutput?.assistantError,
			executionError: executionError ?? executionOutput?.internalError,
		});
		status = derived.status;
		summary = derived.summary;
		failureReason = derived.failureReason;
	}

	const finishedAt = now();
	// Count both uncommitted working-tree changes AND committed-but-not-pushed changes.
	// The agent typically commits its work, so `git status --short` shows a clean tree
	// while the actual diff vs baseCommit has real changes.
	const uncommittedCount = countChangedFilesFromStatus(gitStatusText);
	const committedCount = baseCommit ? await countCommittedChangedFiles(workspaceDir, baseCommit) : 0;
	const changedFileCount = Math.max(uncommittedCount, committedCount);
	const result: JobResultV1 = {
		version: JOB_RESULT_VERSION_V1,
		jobId: job.jobId,
		taskClass: job.taskClass,
		status,
		summary,
		failureReason,
		repo: job.repo,
		...(job.fixCi !== undefined && { fixCi: job.fixCi }),
		...(job.fixLint !== undefined && { fixLint: job.fixLint }),
		...(job.fixTests !== undefined && { fixTests: job.fixTests }),
		...(job.solveIssue !== undefined && { solveIssue: job.solveIssue }),
		...(job.fixCve !== undefined && { fixCve: job.fixCve }),
		execution: {
			mode: job.execution.mode,
			timeoutMs: job.execution.timeoutMs,
			memoryLimitMb: job.execution.memoryLimitMb,
			sandbox: job.execution.sandbox,
			model: job.execution.model,
			selectedModel: executionOutput?.model ?? selectedModel,
			workspaceDir,
			baseCommit,
			headCommit,
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - startedAt.getTime(),
		},
		artifacts: {
			resultFile: paths.resultFile,
			rootDir: paths.artifactDir,
			jobSpecFile: paths.jobSpecFile,
			patchFile: paths.patchFile,
			traceFile: paths.traceFile,
			assistantFinalFile: paths.assistantFinalFile,
			gitStatusFile: existsSync(paths.gitStatusFile) ? paths.gitStatusFile : undefined,
			todoFile: existsSync(paths.todoFile) ? paths.todoFile : undefined,
			ciLogFile: existsSync(paths.ciLogFile) ? paths.ciLogFile : undefined,
		},
		diagnostics: {
			patchSha256: sha256(patchText),
			changedFileCount,
			markers: {
				result: parsedMarkers.hasResult,
				summary: parsedMarkers.hasSummary,
				failureReason: parsedMarkers.hasFailureReason,
			},
		},
	};

	writeJson(paths.resultFile, result);
	logFinalSummary(log, result, job);
	log.info(`result JSON written to ${paths.resultFile}`);
	return result;
}
