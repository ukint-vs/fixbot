import {
	type FixCiContext,
	type FixCveContext,
	type FixLintContext,
	type FixTestsContext,
	JOB_SPEC_VERSION_V1,
	type JobSpecV1,
	type ModelOverride,
	type NormalizedJobSpecV1,
	type SolveIssueContext,
	TASK_CLASSES,
	type TaskClass,
} from "./types";

export const MIN_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const MIN_MEMORY_LIMIT_MB = 512;
export const MAX_MEMORY_LIMIT_MB = 32_768;

/**
 * jobId must start with an alphanumeric character and contain only
 * alphanumerics, dots, hyphens, and underscores.  Max 128 chars.
 * This prevents path-traversal attacks when jobId is used to build
 * filesystem paths (e.g. `results/job-${jobId}/`).
 */
export const JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

type UnknownRecord = Record<string, unknown>;

function assertObject(value: unknown, label: string): UnknownRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as UnknownRecord;
}

function assertNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function assertPositiveInteger(value: unknown, label: string): number {
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value as number;
}

function parseSandboxConfig(
	value: unknown,
	label: string,
): { mode: "workspace-write" | "read-only"; networkAccess: boolean } {
	if (value === undefined) {
		return { mode: "workspace-write", networkAccess: true };
	}
	const sandbox = assertObject(value, label);
	const mode = sandbox.mode;
	if (mode !== "workspace-write" && mode !== "read-only") {
		throw new Error(`${label}.mode must be "workspace-write" or "read-only"`);
	}
	const networkAccess =
		sandbox.networkAccess === undefined
			? true
			: typeof sandbox.networkAccess === "boolean"
				? sandbox.networkAccess
				: (() => {
						throw new Error(`${label}.networkAccess must be a boolean`);
					})();
	return { mode, networkAccess };
}

function parseModelOverride(value: unknown, label: string): ModelOverride | undefined {
	if (value === undefined) {
		return undefined;
	}
	const model = assertObject(value, label);
	return {
		provider: assertNonEmptyString(model.provider, `${label}.provider`),
		modelId: assertNonEmptyString(model.modelId, `${label}.modelId`),
	};
}

function parseJobSpec(value: unknown, label: string): JobSpecV1 {
	const root = assertObject(value, label);

	if (root.version !== JOB_SPEC_VERSION_V1) {
		throw new Error(`${label}.version must be "${JOB_SPEC_VERSION_V1}"`);
	}

	const taskClass = root.taskClass as string;
	if (!TASK_CLASSES.includes(taskClass as TaskClass)) {
		throw new Error(`${label}.taskClass must be one of: ${TASK_CLASSES.join(", ")} (got "${taskClass}")`);
	}

	const repo = assertObject(root.repo, `${label}.repo`);
	const execution = assertObject(root.execution, `${label}.execution`);

	// Per-task context parsing
	let fixCi: FixCiContext | undefined;
	let fixLint: FixLintContext | undefined;
	let fixTests: FixTestsContext | undefined;
	let solveIssue: SolveIssueContext | undefined;
	let fixCve: FixCveContext | undefined;

	if (taskClass === "fix_ci") {
		const fixCiObj = assertObject(root.fixCi, `${label}.fixCi`);
		fixCi = {
			githubActionsRunId: assertPositiveInteger(fixCiObj.githubActionsRunId, `${label}.fixCi.githubActionsRunId`),
		};
	} else if (taskClass === "fix_lint") {
		if (root.fixLint !== undefined) {
			const fixLintObj = assertObject(root.fixLint, `${label}.fixLint`);
			if (fixLintObj.lintCommand !== undefined) {
				fixLint = {
					lintCommand: assertNonEmptyString(fixLintObj.lintCommand, `${label}.fixLint.lintCommand`),
				};
			} else {
				fixLint = {};
			}
		}
	} else if (taskClass === "fix_tests") {
		if (root.fixTests !== undefined) {
			const fixTestsObj = assertObject(root.fixTests, `${label}.fixTests`);
			if (fixTestsObj.testCommand !== undefined) {
				fixTests = {
					testCommand: assertNonEmptyString(fixTestsObj.testCommand, `${label}.fixTests.testCommand`),
				};
			} else {
				fixTests = {};
			}
		}
	} else if (taskClass === "solve_issue") {
		const solveIssueObj = assertObject(root.solveIssue, `${label}.solveIssue`);
		solveIssue = {
			issueNumber: assertPositiveInteger(solveIssueObj.issueNumber, `${label}.solveIssue.issueNumber`),
		};
		if (solveIssueObj.issueTitle !== undefined) {
			solveIssue.issueTitle = assertNonEmptyString(solveIssueObj.issueTitle, `${label}.solveIssue.issueTitle`);
		}
		if (solveIssueObj.issueBody !== undefined) {
			solveIssue.issueBody = assertNonEmptyString(solveIssueObj.issueBody, `${label}.solveIssue.issueBody`);
		}
	} else if (taskClass === "fix_cve") {
		const fixCveObj = assertObject(root.fixCve, `${label}.fixCve`);
		fixCve = {
			cveId: assertNonEmptyString(fixCveObj.cveId, `${label}.fixCve.cveId`),
		};
		if (fixCveObj.vulnerablePackage !== undefined) {
			fixCve.vulnerablePackage = assertNonEmptyString(
				fixCveObj.vulnerablePackage,
				`${label}.fixCve.vulnerablePackage`,
			);
		}
		if (fixCveObj.targetVersion !== undefined) {
			fixCve.targetVersion = assertNonEmptyString(fixCveObj.targetVersion, `${label}.fixCve.targetVersion`);
		}
	}

	const timeoutMs = assertPositiveInteger(execution.timeoutMs, `${label}.execution.timeoutMs`);
	if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`${label}.execution.timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
	}

	const memoryLimitMb = assertPositiveInteger(execution.memoryLimitMb, `${label}.execution.memoryLimitMb`);
	if (memoryLimitMb < MIN_MEMORY_LIMIT_MB || memoryLimitMb > MAX_MEMORY_LIMIT_MB) {
		throw new Error(
			`${label}.execution.memoryLimitMb must be between ${MIN_MEMORY_LIMIT_MB} and ${MAX_MEMORY_LIMIT_MB}`,
		);
	}

	const mode = execution.mode;
	if (mode !== undefined && mode !== "process" && mode !== "docker") {
		throw new Error(`${label}.execution.mode must be "process" or "docker"`);
	}

	const parsedSandbox = parseSandboxConfig(execution.sandbox, `${label}.execution.sandbox`);

	const jobId = assertNonEmptyString(root.jobId, `${label}.jobId`);
	if (!JOB_ID_PATTERN.test(jobId)) {
		throw new Error(
			`${label}.jobId must match ${JOB_ID_PATTERN} (alphanumeric start, alphanumeric/dot/hyphen/underscore body, max 128 chars)`,
		);
	}

	return {
		version: JOB_SPEC_VERSION_V1,
		jobId,
		taskClass: taskClass as TaskClass,
		repo: {
			url: assertNonEmptyString(repo.url, `${label}.repo.url`),
			baseBranch: assertNonEmptyString(repo.baseBranch, `${label}.repo.baseBranch`),
		},
		fixCi,
		fixLint,
		fixTests,
		solveIssue,
		fixCve,
		execution: {
			mode,
			timeoutMs,
			memoryLimitMb,
			sandbox: parsedSandbox,
			model: parseModelOverride(execution.model, `${label}.execution.model`),
		},
	};
}

export function normalizeJobSpec(value: unknown, label: string = "job"): NormalizedJobSpecV1 {
	const parsed = parseJobSpec(value, label);
	const parsedSandbox = parsed.execution.sandbox ?? { mode: "workspace-write", networkAccess: true };
	return {
		...parsed,
		execution: {
			mode: parsed.execution.mode ?? "process",
			timeoutMs: parsed.execution.timeoutMs,
			memoryLimitMb: parsed.execution.memoryLimitMb,
			sandbox: {
				mode: parsedSandbox.mode,
				networkAccess: parsedSandbox.networkAccess ?? true,
			},
			model: parsed.execution.model,
		},
	};
}

export function parseJobSpecText(text: string, source: string): NormalizedJobSpecV1 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid JSON";
		throw new Error(`${source}: ${message}`);
	}
	return normalizeJobSpec(parsed, source);
}
