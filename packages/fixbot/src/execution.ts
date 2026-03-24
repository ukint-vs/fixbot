import { readFileSync } from "node:fs";
import { CommandTimeoutError, spawnCommandOrThrow } from "./command";
import type { HostAgentConfig } from "./host-agent";
import { getDockerImageName } from "./image";
import { runInternalExecutionFromPlan } from "./internal-runner";
import type { ExecutionOutputV1, JobArtifactPaths, ModelSelection, NormalizedJobSpecV1 } from "./types";

export interface PreparedJobContext {
	job: NormalizedJobSpecV1;
	paths: JobArtifactPaths;
	baseCommit: string;
	hostConfig: HostAgentConfig;
	selectedModel: ModelSelection;
}

export interface PreparedJobExecutor {
	execute(context: PreparedJobContext): Promise<ExecutionOutputV1>;
}

export class ExecutionTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionTimeoutError";
	}
}

function logProgress(message: string): void {
	process.stderr.write(`[fixbot] ${message}\n`);
}

function streamCommandOutput(chunk: string): void {
	process.stderr.write(chunk);
}

async function cleanupDockerContainer(containerName: string): Promise<void> {
	try {
		await spawnCommandOrThrow("docker", ["rm", "-f", containerName]);
	} catch {
		// Best effort cleanup only.
	}
}

function readExecutionOutput(filePath: string): ExecutionOutputV1 | undefined {
	try {
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content) as ExecutionOutputV1;
	} catch {
		return undefined;
	}
}

function getCliScriptPath(): string {
	if (!process.argv[1]) {
		throw new Error("Unable to determine the current fixbot CLI path");
	}
	return process.argv[1];
}

export function assertDockerGithubAuth(env: NodeJS.ProcessEnv = process.env): void {
	if (env.GH_TOKEN || env.GITHUB_TOKEN) {
		return;
	}

	throw new Error(
		[
			"Docker fixbot runs require GitHub CLI authentication for fix_ci.",
			"",
			"Set GH_TOKEN or GITHUB_TOKEN before running fixbot in docker mode.",
		].join("\n"),
	);
}

async function executeInChildProcess(context: PreparedJobContext): Promise<ExecutionOutputV1> {
	const cliScript = getCliScriptPath();
	logProgress(`starting local executor for job ${context.job.jobId}`);
	const nodeArgs = [
		...process.execArgv.filter(arg => !arg.startsWith("--max-old-space-size=")),
		`--max-old-space-size=${context.job.execution.memoryLimitMb}`,
		cliScript,
		"__internal-run",
		"--execution",
		context.paths.executionPlanFile,
	];

	try {
		await spawnCommandOrThrow(process.execPath, nodeArgs, {
			cwd: context.paths.workspaceDir,
			timeoutMs: context.job.execution.timeoutMs,
			env: process.env,
			onStdout: streamCommandOutput,
			onStderr: streamCommandOutput,
		});
	} catch (error) {
		if (error instanceof CommandTimeoutError) {
			throw new ExecutionTimeoutError(`Process execution timed out after ${context.job.execution.timeoutMs}ms`);
		}
		const output = readExecutionOutput(context.paths.executionOutputFile);
		if (output) {
			return output;
		}
		throw error;
	}

	const output = readExecutionOutput(context.paths.executionOutputFile);
	if (!output) {
		throw new Error(`Missing execution output: ${context.paths.executionOutputFile}`);
	}
	return output;
}

const DOCKER_ENV_PASSTHROUGH = [
	"FIXBOT_AGENT_DIR",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_PROJECT_ID",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"HF_TOKEN",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"AWS_BEDROCK_SKIP_AUTH",
	"AWS_BEDROCK_FORCE_HTTP1",
	"GH_TOKEN",
	"GITHUB_TOKEN",
] as const;

export function buildDockerEnvArgs(hostConfig: HostAgentConfig, env: NodeJS.ProcessEnv = process.env): string[] {
	const args: string[] = [];

	// Mount the host agent directory (contains agent.db with auth)
	if (hostConfig.hostAgentDirExists) {
		args.push("-v", `${hostConfig.hostAgentDir}:/fixbot-host-agent:ro`, "-e", "FIXBOT_AGENT_DIR=/fixbot-host-agent");
	}

	// Pass through provider API key env vars
	for (const name of DOCKER_ENV_PASSTHROUGH) {
		if (env[name]) {
			args.push("-e", name);
		}
	}
	return args;
}

async function executeInDocker(context: PreparedJobContext): Promise<ExecutionOutputV1> {
	/*
	process/docker branch
	    |
	    `- docker mounts host auth/settings/models into /fixbot-host-agent
	       passes provider + GitHub env
	       re-enters __internal-run with the preselected model from the plan
	*/
	assertDockerGithubAuth();
	const image = getDockerImageName();
	const containerName = `fixbot-${context.job.jobId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
	await cleanupDockerContainer(containerName);
	logProgress(`starting Docker executor ${containerName}`);
	const runArgs = [
		"run",
		"--rm",
		"--name",
		containerName,
		"--memory",
		`${context.job.execution.memoryLimitMb}m`,
		"-v",
		`${context.paths.artifactDir}:/job`,
		"-w",
		"/job/workspace",
		...buildDockerEnvArgs(context.hostConfig),
	];

	if (!context.job.execution.sandbox.networkAccess) {
		runArgs.push("--network", "none");
	}

	runArgs.push(image, "__internal-run", "--execution", "/job/execution-plan.json");

	try {
		await spawnCommandOrThrow("docker", runArgs, {
			timeoutMs: context.job.execution.timeoutMs,
			env: process.env,
			onStdout: streamCommandOutput,
			onStderr: streamCommandOutput,
		});
	} catch (error) {
		if (error instanceof CommandTimeoutError) {
			logProgress(`forcing cleanup of timed out container ${containerName}`);
			await cleanupDockerContainer(containerName);
			throw new ExecutionTimeoutError(`Docker execution timed out after ${context.job.execution.timeoutMs}ms`);
		}
		const output = readExecutionOutput(context.paths.executionOutputFile);
		if (output) {
			return output;
		}
		throw error;
	}

	const output = readExecutionOutput(context.paths.executionOutputFile);
	if (!output) {
		throw new Error(`Missing execution output: ${context.paths.executionOutputFile}`);
	}
	return output;
}

class DefaultPreparedJobExecutor implements PreparedJobExecutor {
	async execute(context: PreparedJobContext): Promise<ExecutionOutputV1> {
		if (context.job.execution.mode === "docker") {
			return executeInDocker(context);
		}
		return executeInChildProcess(context);
	}
}

export function createDefaultPreparedJobExecutor(): PreparedJobExecutor {
	return new DefaultPreparedJobExecutor();
}

export async function executeInlinePlan(planFile: string): Promise<ExecutionOutputV1> {
	return runInternalExecutionFromPlan(planFile);
}
