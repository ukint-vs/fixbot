import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	discoverAuthStorage,
	discoverSkills,
	loadSkillsFromDir,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@fixbot/pi-coding-agent";
import { createGhReadOnlyEnvironment } from "./gh-read-only";
import { resolveHostAgentConfig } from "./host-agent";
import { parseResultMarkers } from "./markers";
import {
	EXECUTION_OUTPUT_VERSION_V1,
	EXECUTION_PLAN_VERSION_V1,
	type ExecutionOutputV1,
	type ExecutionPlanV1,
	type ModelSelection,
	type NormalizedJobSpecV1,
} from "./types";

export interface SessionDriverInput {
	job: NormalizedJobSpecV1;
	workspaceDir: string;
	traceFile: string;
	assistantFinalFile: string;
	injectedContextFile: string;
	isolatedAgentDir: string;
	prompt: string;
	selectedModel: ModelSelection;
}

export interface SessionDriverResult {
	assistantFinalText: string;
	model?: ModelSelection;
	assistantError?: string;
}

export interface SessionDriver {
	run(input: SessionDriverInput): Promise<SessionDriverResult>;
}

function logProgress(message: string): void {
	process.stderr.write(`[fixbot] ${message}\n`);
}

function appendChunkAndExtractLines(buffer: string, chunk: string): { nextBuffer: string; lines: string[] } {
	const combined = `${buffer}${chunk}`;
	const lines = combined.split(/\r?\n/);
	const nextBuffer = lines.pop() ?? "";
	return {
		nextBuffer,
		lines: lines.filter((line) => line.trim() !== ""),
	};
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateForLog(text: string, maxLength = 160): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function summarizeUnknownForLog(value: unknown, maxLength = 160): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "string") {
		const summary = compactWhitespace(value);
		return summary === "" ? undefined : truncateForLog(summary, maxLength);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	const summary = compactWhitespace(safeJsonStringify(value));
	return summary === "" ? undefined : truncateForLog(summary, maxLength);
}

function summarizeToolArgs(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") {
		return summarizeUnknownForLog(args);
	}

	const record = args as Record<string, unknown>;
	if (toolName === "bash") {
		return summarizeUnknownForLog(record.command ?? record.cmd ?? args);
	}
	if (toolName === "read") {
		return summarizeUnknownForLog(record.filePath ?? record.path ?? args);
	}
	if (toolName === "edit" || toolName === "write") {
		return summarizeUnknownForLog(record.filePath ?? record.path ?? args);
	}

	return summarizeUnknownForLog(args);
}

function summarizeToolResult(toolName: string, value: unknown): string | undefined {
	if (!value || typeof value !== "object") {
		return summarizeUnknownForLog(value);
	}

	const record = value as Record<string, unknown>;
	if (toolName === "bash") {
		return summarizeUnknownForLog(record.stdout ?? record.stderr ?? record.output ?? value);
	}
	if (toolName === "read" || toolName === "edit" || toolName === "write") {
		return summarizeUnknownForLog(record.result ?? record.output ?? record.message ?? value);
	}

	return summarizeUnknownForLog(value);
}

export function resolveSkillPath(taskClass: string): string {
	const skillDirName = taskClass.replace(/_/g, "-");
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const skillPath = join(currentDir, "skills", skillDirName, "SKILL.md");
	if (!existsSync(skillPath)) {
		throw new Error(`Skill file not found for task class "${taskClass}": ${skillPath}`);
	}
	return skillPath;
}

export function getConfiguredAuthFilePath(): string | undefined {
	const hostConfig = resolveHostAgentConfig();
	return hostConfig.authFileExists ? hostConfig.authFilePath : undefined;
}

export function buildInjectedContext(job: NormalizedJobSpecV1, selectedModel: ModelSelection): string {
	const modelLine = job.execution.model
		? `${job.execution.model.provider}/${job.execution.model.modelId}`
		: "default model selection";

	const sharedLines = [
		"# Fixbot Run Context",
		"",
		`- Job ID: ${job.jobId}`,
		`- Task Class: ${job.taskClass}`,
		`- Repository URL: ${job.repo.url}`,
		`- Base Branch: ${job.repo.baseBranch}`,
	];

	switch (job.taskClass) {
		case "fix_ci":
			sharedLines.push(`- GitHub Actions Run ID: ${job.fixCi!.githubActionsRunId}`);
			break;
		case "fix_lint":
			sharedLines.push(`- Lint Command: ${job.fixLint?.lintCommand ?? "auto-detect from project config"}`);
			break;
		case "fix_tests":
			sharedLines.push(`- Test Command: ${job.fixTests?.testCommand ?? "auto-detect from project config"}`);
			break;
		case "solve_issue":
			sharedLines.push(`- Issue Number: ${job.solveIssue!.issueNumber}`);
			if (job.solveIssue?.issueTitle) {
				sharedLines.push(`- Issue Title: ${job.solveIssue.issueTitle}`);
			}
			if (job.solveIssue?.issueBody) {
				sharedLines.push(`- Issue Body: ${job.solveIssue.issueBody}`);
			}
			break;
		case "fix_cve":
			sharedLines.push(`- CVE ID: ${job.fixCve!.cveId}`);
			if (job.fixCve?.vulnerablePackage) {
				sharedLines.push(`- Vulnerable Package: ${job.fixCve.vulnerablePackage}`);
			}
			if (job.fixCve?.targetVersion) {
				sharedLines.push(`- Target Version: ${job.fixCve.targetVersion}`);
			}
			break;
	}

	sharedLines.push(
		`- Execution Mode: ${job.execution.mode}`,
		`- Timeout (ms): ${job.execution.timeoutMs}`,
		`- Memory Limit (MB): ${job.execution.memoryLimitMb}`,
		`- Sandbox Mode: ${job.execution.sandbox.mode}`,
		`- Network Access: ${job.execution.sandbox.networkAccess}`,
		`- Model Override: ${modelLine}`,
		`- Selected Model: ${selectedModel.provider}/${selectedModel.modelId}`,
		"",
		"## Final Response Requirements",
		"",
		"End the final response with exactly one line for each marker:",
		"- `FIXBOT_RESULT: success` or `FIXBOT_RESULT: failed`",
		"- `FIXBOT_SUMMARY: <single-line summary>`",
		"- `FIXBOT_FAILURE_REASON: <reason or none>`",
		"",
		"## Constraints",
		"",
		"- Work only inside the current repository checkout.",
		"- Do not push branches, create pull requests, or mutate GitHub state.",
		"- Do not ask the user for follow-up input.",
		"- If blocked, return `FIXBOT_RESULT: failed` with a precise reason.",
	);

	return sharedLines.join("\n");
}

export function buildGitFixPrompt(job: NormalizedJobSpecV1): string {
	const commonSuffix = [
		"Use the injected run context for final response markers and execution constraints.",
		"Treat GitHub access as read-only. Inspect runs and logs, but do not push or mutate remote state.",
	];

	switch (job.taskClass) {
		case "fix_ci":
			return [
				`/skill:fix-ci Fix the failing GitHub Actions run in this repository clone.`,
				`Job ID: ${job.jobId}`,
				`Run ID: ${job.fixCi!.githubActionsRunId}`,
				`Base branch: ${job.repo.baseBranch}`,
				...commonSuffix,
				"Inspect the failing run, fix the underlying issue, and leave the repository in a reviewable state.",
			].join("\n");
		case "fix_lint":
			return [
				`/skill:fix-lint Find and fix all lint violations in this repository clone.`,
				`Job ID: ${job.jobId}`,
				`Base branch: ${job.repo.baseBranch}`,
				...(job.fixLint?.lintCommand ? [`Lint command: ${job.fixLint.lintCommand}`] : []),
				...commonSuffix,
				"Run the linter, fix all violations, and leave the repository in a reviewable state.",
			].join("\n");
		case "fix_tests":
			return [
				`/skill:fix-tests Diagnose and repair failing tests in this repository clone.`,
				`Job ID: ${job.jobId}`,
				`Base branch: ${job.repo.baseBranch}`,
				...(job.fixTests?.testCommand ? [`Test command: ${job.fixTests.testCommand}`] : []),
				...commonSuffix,
				"Run the tests, diagnose failures, fix the underlying issues, and leave the repository in a reviewable state.",
			].join("\n");
		case "solve_issue":
			return [
				`/skill:solve-issue Address the GitHub issue in this repository clone.`,
				`Job ID: ${job.jobId}`,
				`Base branch: ${job.repo.baseBranch}`,
				`Issue number: ${job.solveIssue!.issueNumber}`,
				...(job.solveIssue?.issueTitle ? [`Issue title: ${job.solveIssue.issueTitle}`] : []),
				...commonSuffix,
				"Read the issue context, implement the smallest correct fix, and leave the repository in a reviewable state.",
			].join("\n");
		case "fix_cve":
			return [
				`/skill:fix-cve Remediate the CVE in this repository clone.`,
				`Job ID: ${job.jobId}`,
				`Base branch: ${job.repo.baseBranch}`,
				`CVE ID: ${job.fixCve!.cveId}`,
				...(job.fixCve?.vulnerablePackage ? [`Vulnerable package: ${job.fixCve.vulnerablePackage}`] : []),
				...(job.fixCve?.targetVersion ? [`Target version: ${job.fixCve.targetVersion}`] : []),
				...commonSuffix,
				"Update the vulnerable dependency, verify the fix, run the test suite, and leave the repository in a reviewable state.",
			].join("\n");
	}
}

function serializeTraceEvent(event: AgentSessionEvent): Record<string, unknown> {
	const record: Record<string, unknown> = { type: event.type };

	if ("toolName" in event) {
		record.toolName = event.toolName;
	}
	if ("toolCallId" in event) {
		record.toolCallId = event.toolCallId;
	}
	if ("message" in event && typeof event.message === "object" && event.message !== null && "role" in event.message) {
		record.role = event.message.role;
		if (event.message.role === "assistant" && "stopReason" in event.message) {
			record.stopReason = event.message.stopReason;
		}
	}
	if (
		"assistantMessageEvent" in event &&
		typeof event.assistantMessageEvent === "object" &&
		event.assistantMessageEvent
	) {
		record.assistantEventType = event.assistantMessageEvent.type;
		if (event.assistantMessageEvent.type === "text_delta") {
			record.delta = event.assistantMessageEvent.delta;
		}
	}
	if ("errorMessage" in event && typeof event.errorMessage === "string") {
		record.errorMessage = event.errorMessage;
	}
	if ("args" in event) {
		record.argsSummary = summarizeToolArgs("toolName" in event ? event.toolName : "tool", event.args);
	}
	if ("partialResult" in event) {
		record.partialSummary = summarizeToolResult("toolName" in event ? event.toolName : "tool", event.partialResult);
	}
	if ("result" in event) {
		record.resultSummary = summarizeToolResult("toolName" in event ? event.toolName : "tool", event.result);
	}

	return record;
}

/**
 * Drives a single fixbot job by creating an oh-my-pi coding agent session.
 *
 * Each job gets an isolated agent session with:
 * - All discovered oh-my-pi skills (from host and project)
 * - A bundled fixbot task skill (fix-ci, fix-lint, solve-issue, etc.)
 * - Injected job context as a context file
 * - The full oh-my-pi tool suite (bash, read, edit, write, grep, find)
 * - Read-only GitHub access via a gh wrapper
 * - No extensions, MCP, LSP, or persistent state
 *
 * Integration point: createAgentSession() from @fixbot/pi-coding-agent SDK.
 * This is intentionally the ONLY coupling to the oh-my-pi codebase, keeping
 * upstream syncs clean. All job-specific logic lives in this package.
 *
 *   ┌──────────────┐     ┌─────────────────────────┐
 *   │ fixbot daemon │────▶│ createAgentSession()    │
 *   │              │     │ (oh-my-pi SDK)           │
 *   │ • job spec   │     │                          │
 *   │ • skill path │     │ • session.prompt(skill)  │
 *   │ • model      │     │ • session.subscribe()    │
 *   │ • context    │     │ • session.dispose()      │
 *   └──────────────┘     └─────────────────────────┘
 */
export class CodingAgentSessionDriver implements SessionDriver {
	async run(input: SessionDriverInput): Promise<SessionDriverResult> {
		/*
		host config -> selected model -> isolated session
		     |               |                  |
		     |               |                  `- bundled skill only
		     |               `- locked by parent plan, no re-selection
		     `- host auth/models reused, repo-local config ignored
		*/
		logProgress(`preparing isolated agent state in ${input.isolatedAgentDir}`);
		mkdirSync(input.isolatedAgentDir, { recursive: true });
		logProgress(`streaming detailed agent trace to ${input.traceFile}`);

		const expectedSkillName = input.job.taskClass.replace(/_/g, "-");
		const skillPath = resolveSkillPath(input.job.taskClass);
		// Load the fixbot task-class skill from the bundled skills directory.
		// loadSkillsFromDir scans a directory for subdirs containing SKILL.md.
		const skillsDir = dirname(dirname(skillPath));
		const { skills: fixbotSkills } = await loadSkillsFromDir({
			dir: skillsDir,
			source: "fixbot:daemon",
		});
		const taskSkill = fixbotSkills.filter((s) => s.name === expectedSkillName);
		if (taskSkill.length !== 1) {
			throw new Error(`Expected exactly one bundled ${expectedSkillName} skill, found ${taskSkill.length}`);
		}
		// Discover oh-my-pi skills from standard locations (host agent dir, project).
		// This gives the worker the full oh-my-pi skill catalog alongside the fixbot task skill.
		const { skills: discoveredSkills } = await discoverSkills(input.workspaceDir, input.isolatedAgentDir);
		const skills = [...discoveredSkills, ...taskSkill];

		const contextFiles = [
			{
				path: input.injectedContextFile,
				content: readFileSync(input.injectedContextFile, "utf-8"),
			},
		];

		const authStorage = await discoverAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		await modelRegistry.refresh();
		const model = modelRegistry.getAvailable().find(
			(m) => m.provider === input.selectedModel.provider && m.id === input.selectedModel.modelId,
		);
		if (!model) {
			throw new Error(`Model ${input.selectedModel.provider}/${input.selectedModel.modelId} not available. Run 'fixbot auth' to configure API keys.`);
		}
		logProgress(`selected model ${model.provider}/${model.id}`);
		const toolBinDir = join(input.isolatedAgentDir, "bin");
		const ghEnvironment = createGhReadOnlyEnvironment(toolBinDir);
		if (ghEnvironment.wrapperPath) {
			logProgress(`configured read-only gh wrapper at ${ghEnvironment.wrapperPath}`);
		} else {
			logProgress("gh not found in PATH; continuing without read-only gh wrapper");
		}
		logProgress(`creating coding-agent session for ${input.job.repo.url}`);
		const traceStream = createWriteStream(input.traceFile, { flags: "w" });
		const originalEnv = {
			PATH: process.env.PATH,
			GH_PAGER: process.env.GH_PAGER,
			GH_NO_UPDATE_NOTIFIER: process.env.GH_NO_UPDATE_NOTIFIER,
			GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED,
		};
		process.env.PATH = ghEnvironment.env.PATH;
		process.env.GH_PAGER = ghEnvironment.env.GH_PAGER;
		process.env.GH_NO_UPDATE_NOTIFIER = ghEnvironment.env.GH_NO_UPDATE_NOTIFIER;
		process.env.GH_PROMPT_DISABLED = ghEnvironment.env.GH_PROMPT_DISABLED;
		let session: AgentSession | undefined;
		let assistantError: string | undefined;
		let assistantLineBuffer = "";
		let unsubscribe = () => {};

		try {
			session = (
				await createAgentSession({
					cwd: input.workspaceDir,
					agentDir: input.isolatedAgentDir,
					authStorage,
					modelRegistry,
					model,
					sessionManager: SessionManager.inMemory(),
					skills,
					contextFiles,
					promptTemplates: [],
					slashCommands: [],
					rules: [],
					disableExtensionDiscovery: true,
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					settings: Settings.isolated(),
				})
			).session;
			unsubscribe = session.subscribe((event) => {
				traceStream.write(`${JSON.stringify(serializeTraceEvent(event))}\n`);
				if ("errorMessage" in event && typeof event.errorMessage === "string" && event.errorMessage.trim() !== "") {
					assistantError = event.errorMessage;
				}
				if (
					event.type === "message_update" &&
					event.message.role === "assistant" &&
					event.assistantMessageEvent.type === "text_delta"
				) {
					const extracted = appendChunkAndExtractLines(assistantLineBuffer, event.assistantMessageEvent.delta);
					assistantLineBuffer = extracted.nextBuffer;
					for (const line of extracted.lines) {
						logProgress(`assistant: ${truncateForLog(line, 220)}`);
					}
				} else if (event.type === "message_end" && event.message.role === "assistant") {
					const remaining = compactWhitespace(assistantLineBuffer);
					if (remaining !== "") {
						logProgress(`assistant: ${truncateForLog(remaining, 220)}`);
					}
					assistantLineBuffer = "";
					logProgress(
						`assistant message completed${"stopReason" in event.message ? ` (${event.message.stopReason ?? "unknown"})` : ""}`,
					);
				} else if (event.type === "turn_start") {
					logProgress("agent turn started");
				} else if (event.type === "turn_end") {
					logProgress(`agent turn completed with ${event.toolResults.length} tool result(s)`);
				} else if (event.type === "tool_execution_start") {
					const argsSummary = summarizeToolArgs(event.toolName, event.args);
					logProgress(`tool start: ${event.toolName}${argsSummary ? ` ${argsSummary}` : ""}`);
				} else if (event.type === "tool_execution_update") {
					const partialSummary = summarizeToolResult(event.toolName, event.partialResult);
					if (partialSummary) {
						logProgress(`tool update: ${event.toolName} ${partialSummary}`);
					}
				} else if (event.type === "tool_execution_end") {
					const resultSummary = summarizeToolResult(event.toolName, event.result);
					logProgress(
						`tool end: ${event.toolName}${event.isError ? " (error)" : ""}${resultSummary ? ` ${resultSummary}` : ""}`,
					);
				} else if (event.type === "auto_retry_start") {
					logProgress(`auto retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				} else if (event.type === "auto_compaction_start") {
					logProgress(`auto compaction started (${event.reason})`);
				} else if (event.type === "auto_compaction_end") {
					logProgress(
						event.errorMessage
							? `auto compaction failed: ${event.errorMessage}`
							: `auto compaction finished${event.willRetry ? " (will retry)" : ""}`,
					);
				}
			});
			logProgress(`prompting coding agent for ${input.job.taskClass} task`);
			await session.prompt(input.prompt);
			const assistantFinalText = session.getLastAssistantText() ?? "";
			writeFileSync(input.assistantFinalFile, assistantFinalText, "utf-8");
			logProgress("coding agent run completed");
			return {
				assistantFinalText,
				assistantError,
				model: session.model
					? {
							provider: session.model.provider,
							modelId: session.model.id,
						}
					: undefined,
			};
		} finally {
			unsubscribe();
			traceStream.end();
			session?.dispose();
			process.env.PATH = originalEnv.PATH;
			process.env.GH_PAGER = originalEnv.GH_PAGER;
			process.env.GH_NO_UPDATE_NOTIFIER = originalEnv.GH_NO_UPDATE_NOTIFIER;
			process.env.GH_PROMPT_DISABLED = originalEnv.GH_PROMPT_DISABLED;
		}
	}
}

function readExecutionPlan(planFile: string): ExecutionPlanV1 {
	const content = readFileSync(planFile, "utf-8");
	const parsed = JSON.parse(content) as ExecutionPlanV1;
	if (parsed.version !== EXECUTION_PLAN_VERSION_V1) {
		throw new Error(`Unsupported execution plan version: ${parsed.version}`);
	}
	return parsed;
}

export async function runInternalExecutionFromPlan(
	planFile: string,
	options: { sessionDriver?: SessionDriver } = {},
): Promise<ExecutionOutputV1> {
	const plan = readExecutionPlan(planFile);
	logProgress(`loaded execution plan for job ${plan.job.jobId}`);
	const artifactDir = dirname(planFile);
	const workspaceDir = join(artifactDir, "workspace");
	const traceFile = join(artifactDir, "trace.jsonl");
	const assistantFinalFile = join(artifactDir, "assistant-final.txt");
	const injectedContextFile = join(artifactDir, "injected-context.md");
	const isolatedAgentDir = join(artifactDir, "agent");
	const executionOutputFile = join(artifactDir, "execution-output.json");
	const sessionDriver = options.sessionDriver ?? new CodingAgentSessionDriver();

	// Ensure fixed artifact files exist even on early failure.
	if (!existsSync(traceFile)) {
		writeFileSync(traceFile, "", "utf-8");
	}
	if (!existsSync(assistantFinalFile)) {
		writeFileSync(assistantFinalFile, "", "utf-8");
	}
	writeFileSync(injectedContextFile, buildInjectedContext(plan.job, plan.selectedModel), "utf-8");

	try {
		const prompt = buildGitFixPrompt(plan.job);
		const result = await sessionDriver.run({
			job: plan.job,
			workspaceDir,
			traceFile,
			assistantFinalFile,
			injectedContextFile,
			isolatedAgentDir,
			prompt,
			selectedModel: plan.selectedModel,
		});
		const output: ExecutionOutputV1 = {
			version: EXECUTION_OUTPUT_VERSION_V1,
			assistantFinalText: result.assistantFinalText,
			parsedMarkers: parseResultMarkers(result.assistantFinalText),
			model: result.model ?? plan.selectedModel,
			assistantError: result.assistantError,
		};
		writeFileSync(executionOutputFile, JSON.stringify(output, null, 2), "utf-8");
		logProgress(`execution output written to ${executionOutputFile}`);
		return output;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const assistantFinalText = existsSync(assistantFinalFile) ? readFileSync(assistantFinalFile, "utf-8") : "";
		const output: ExecutionOutputV1 = {
			version: EXECUTION_OUTPUT_VERSION_V1,
			assistantFinalText,
			parsedMarkers: parseResultMarkers(assistantFinalText),
			model: plan.selectedModel,
			internalError: message,
		};
		writeFileSync(executionOutputFile, JSON.stringify(output, null, 2), "utf-8");
		logProgress(`execution failed: ${message}`);
		throw error;
	}
}
