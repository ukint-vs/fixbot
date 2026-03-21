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
	getHeadCommit,
} from "./git";
import { resolveExecutionModel, resolveHostAgentConfig } from "./host-agent";
import { assertDockerImageReady } from "./image";
import { deriveResultStatus, parseResultMarkers } from "./markers";
import {
	EXECUTION_PLAN_VERSION_V1,
	type ExecutionOutputV1,
	type ExecutionPlanV1,
	JOB_RESULT_VERSION_V1,
	type JobResultV1,
	type ModelSelection,
	type DaemonModelConfig,
	type NormalizedJobSpecV1,
} from "./types";

export interface RunJobOptions {
	resultsDir?: string;
	executor?: PreparedJobExecutor;
	now?: () => Date;
	dockerImageVerifier?: () => Promise<string>;
	/** Model override from daemon config — passed to resolveExecutionModel. */
	configModel?: DaemonModelConfig;
}

function logProgress(message: string): void {
	process.stderr.write(`[fixbot] ${message}\n`);
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

export async function runJob(job: NormalizedJobSpecV1, options: RunJobOptions = {}): Promise<JobResultV1> {
	const now = options.now ?? (() => new Date());
	const startedAt = now();
	const resultsDir = options.resultsDir ?? join(process.cwd(), "results");
	const executor = options.executor ?? createDefaultPreparedJobExecutor();
	const dockerImageVerifier = options.dockerImageVerifier ?? (() => assertDockerImageReady());
	const paths = getArtifactPaths(resultsDir, job.jobId);

	logProgress(`starting job ${job.jobId} (${job.execution.mode})`);
	logProgress(`results will be written under ${paths.artifactDir}`);
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

	try {
		const hostConfig = resolveHostAgentConfig();
		const resolvedModel = await resolveExecutionModel(job, { configModel: options.configModel });
		selectedModel = {
			provider: resolvedModel.provider,
			modelId: resolvedModel.id,
		};
		logProgress(`preflight selected model ${resolvedModel.provider}/${resolvedModel.id}`);
		if (job.execution.mode === "docker") {
			assertDockerGithubAuth();
			await dockerImageVerifier();
		}
		logProgress(`cloning ${job.repo.url} @ ${job.repo.baseBranch}`);
		await cloneRepository(job.repo.url, job.repo.baseBranch, paths.workspaceDir);
		await configureLocalGitIdentity(paths.workspaceDir);
		baseCommit = await getHeadCommit(paths.workspaceDir);
		logProgress(`repository cloned at ${baseCommit}`);
		writeJson(paths.executionPlanFile, buildExecutionPlan(job, baseCommit, selectedModel));

		const context: PreparedJobContext = {
			job,
			paths,
			baseCommit,
			hostConfig,
			selectedModel,
		};
		logProgress("starting execution");
		executionOutput = await executor.execute(context);
		logProgress("execution finished");
	} catch (error) {
		timedOut = error instanceof ExecutionTimeoutError;
		executionError = error instanceof Error ? error.message : String(error);
		logProgress(`execution failed: ${executionError}`);
	} finally {
		if (existsSync(paths.workspaceDir)) {
			logProgress("capturing workspace artifacts");
			try {
				headCommit = await getHeadCommit(paths.workspaceDir);
			} catch {
				headCommit = undefined;
			}

			try {
				patchText = baseCommit ? await capturePatch(paths.workspaceDir, baseCommit, paths.patchFile) : "";
			} catch {
				patchText = safeReadFile(paths.patchFile);
			}

			try {
				gitStatusText = await captureGitStatus(paths.workspaceDir, paths.gitStatusFile);
			} catch {
				gitStatusText = safeReadFile(paths.gitStatusFile);
			}

			copyOptionalWorkspaceArtifact(paths.workspaceDir, "TODO.md", paths.todoFile);
			copyOptionalWorkspaceArtifact(paths.workspaceDir, "ci-log.txt", paths.ciLogFile);
			if (!existsSync(paths.ciLogFile)) {
				copyOptionalWorkspaceArtifact(paths.workspaceDir, ".fixbot/ci-log.txt", paths.ciLogFile);
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
	const changedFileCount = countChangedFilesFromStatus(gitStatusText);
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
			workspaceDir: paths.workspaceDir,
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
	logProgress(`job ${job.jobId} completed with status ${status}`);
	logProgress(`result JSON written to ${paths.resultFile}`);
	return result;
}
