import { describe, expect, it } from "bun:test";
import { parseJobSpecText } from "../src/contracts";

function createValidJob(): string {
	return JSON.stringify({
		version: "fixbot.job/v1",
		jobId: "demo-1",
		taskClass: "fix_ci",
		repo: {
			url: "https://example.com/repo.git",
			baseBranch: "main",
		},
		fixCi: {
			githubActionsRunId: 12345,
		},
		execution: {
			timeoutMs: 300000,
			memoryLimitMb: 4096,
		},
	});
}

function createJobWithTaskClass(taskClass: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: "fixbot.job/v1",
		jobId: "demo-1",
		taskClass,
		repo: {
			url: "https://example.com/repo.git",
			baseBranch: "main",
		},
		...extra,
		execution: {
			timeoutMs: 300000,
			memoryLimitMb: 4096,
		},
	});
}

describe("job contract", () => {
	it("accepts a valid fix_ci job spec and applies defaults", () => {
		const job = parseJobSpecText(createValidJob(), "job.json");
		expect(job.execution.mode).toBe("process");
		expect(job.execution.sandbox).toEqual({
			mode: "workspace-write",
			networkAccess: true,
		});
	});

	it("rejects a missing GitHub Actions run ID", () => {
		const invalid = JSON.stringify({
			version: "fixbot.job/v1",
			jobId: "demo-1",
			taskClass: "fix_ci",
			repo: {
				url: "https://example.com/repo.git",
				baseBranch: "main",
			},
			fixCi: {},
			execution: {
				timeoutMs: 300000,
				memoryLimitMb: 4096,
			},
		});

		expect(() => parseJobSpecText(invalid, "job.json")).toThrow(
			"job.json.fixCi.githubActionsRunId must be a positive integer",
		);
	});

	it("rejects invalid timeout and memory bounds", () => {
		const invalid = JSON.stringify({
			version: "fixbot.job/v1",
			jobId: "demo-1",
			taskClass: "fix_ci",
			repo: {
				url: "https://example.com/repo.git",
				baseBranch: "main",
			},
			fixCi: {
				githubActionsRunId: 12345,
			},
			execution: {
				timeoutMs: 1000,
				memoryLimitMb: 128,
			},
		});

		expect(() => parseJobSpecText(invalid, "job.json")).toThrow(
			"job.json.execution.timeoutMs must be between 60000 and 3600000",
		);
	});

	it("rejects invalid sandbox mode", () => {
		const invalid = JSON.stringify({
			version: "fixbot.job/v1",
			jobId: "demo-1",
			taskClass: "fix_ci",
			repo: {
				url: "https://example.com/repo.git",
				baseBranch: "main",
			},
			fixCi: {
				githubActionsRunId: 12345,
			},
			execution: {
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				sandbox: {
					mode: "full-access",
				},
			},
		});

		expect(() => parseJobSpecText(invalid, "job.json")).toThrow(
			'job.json.execution.sandbox.mode must be "workspace-write" or "read-only"',
		);
	});

	it("rejects invalid model override shape", () => {
		const invalid = JSON.stringify({
			version: "fixbot.job/v1",
			jobId: "demo-1",
			taskClass: "fix_ci",
			repo: {
				url: "https://example.com/repo.git",
				baseBranch: "main",
			},
			fixCi: {
				githubActionsRunId: 12345,
			},
			execution: {
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				model: {
					provider: "anthropic",
				},
			},
		});

		expect(() => parseJobSpecText(invalid, "job.json")).toThrow(
			"job.json.execution.model.modelId must be a non-empty string",
		);
	});

	// --- Multi-task class tests ---

	it("parses fix_lint job spec without fixCi", () => {
		const job = parseJobSpecText(createJobWithTaskClass("fix_lint"), "job.json");
		expect(job.taskClass).toBe("fix_lint");
		expect(job.fixCi).toBeUndefined();
		expect(job.fixLint).toBeUndefined();
	});

	it("parses fix_lint job spec with optional lintCommand", () => {
		const job = parseJobSpecText(
			createJobWithTaskClass("fix_lint", { fixLint: { lintCommand: "npm run lint" } }),
			"job.json",
		);
		expect(job.taskClass).toBe("fix_lint");
		expect(job.fixLint).toEqual({ lintCommand: "npm run lint" });
	});

	it("parses fix_tests job spec without fixCi", () => {
		const job = parseJobSpecText(createJobWithTaskClass("fix_tests"), "job.json");
		expect(job.taskClass).toBe("fix_tests");
		expect(job.fixCi).toBeUndefined();
		expect(job.fixTests).toBeUndefined();
	});

	it("parses fix_tests job spec with optional testCommand", () => {
		const job = parseJobSpecText(
			createJobWithTaskClass("fix_tests", { fixTests: { testCommand: "npm test" } }),
			"job.json",
		);
		expect(job.taskClass).toBe("fix_tests");
		expect(job.fixTests).toEqual({ testCommand: "npm test" });
	});

	it("parses solve_issue job spec with required issueNumber", () => {
		const job = parseJobSpecText(
			createJobWithTaskClass("solve_issue", { solveIssue: { issueNumber: 42 } }),
			"job.json",
		);
		expect(job.taskClass).toBe("solve_issue");
		expect(job.solveIssue?.issueNumber).toBe(42);
	});

	it("rejects solve_issue without solveIssue object", () => {
		expect(() => parseJobSpecText(createJobWithTaskClass("solve_issue"), "job.json")).toThrow(
			"job.json.solveIssue must be an object",
		);
	});

	it("parses optional fields on solve_issue", () => {
		const job = parseJobSpecText(
			createJobWithTaskClass("solve_issue", {
				solveIssue: { issueNumber: 42, issueTitle: "Bug in parser", issueBody: "Steps to reproduce..." },
			}),
			"job.json",
		);
		expect(job.solveIssue?.issueNumber).toBe(42);
		expect(job.solveIssue?.issueTitle).toBe("Bug in parser");
		expect(job.solveIssue?.issueBody).toBe("Steps to reproduce...");
	});

	it("parses fix_cve job spec with required cveId", () => {
		const job = parseJobSpecText(
			createJobWithTaskClass("fix_cve", { fixCve: { cveId: "CVE-2024-1234" } }),
			"job.json",
		);
		expect(job.taskClass).toBe("fix_cve");
		expect(job.fixCve?.cveId).toBe("CVE-2024-1234");
	});

	it("rejects fix_cve without fixCve object", () => {
		expect(() => parseJobSpecText(createJobWithTaskClass("fix_cve"), "job.json")).toThrow(
			"job.json.fixCve must be an object",
		);
	});

	it("parses optional fields on fix_cve", () => {
		const job = parseJobSpecText(
			createJobWithTaskClass("fix_cve", {
				fixCve: { cveId: "CVE-2024-1234", vulnerablePackage: "lodash", targetVersion: "4.17.21" },
			}),
			"job.json",
		);
		expect(job.fixCve?.cveId).toBe("CVE-2024-1234");
		expect(job.fixCve?.vulnerablePackage).toBe("lodash");
		expect(job.fixCve?.targetVersion).toBe("4.17.21");
	});

	it("rejects unknown taskClass with descriptive error", () => {
		expect(() => parseJobSpecText(createJobWithTaskClass("fix_build"), "job.json")).toThrow(
			'job.json.taskClass must be one of: fix_ci, fix_lint, fix_tests, solve_issue, fix_cve (got "fix_build")',
		);
	});

	it("rejects fix_ci without fixCi field (backward-compat gate)", () => {
		expect(() => parseJobSpecText(createJobWithTaskClass("fix_ci"), "job.json")).toThrow(
			"job.json.fixCi must be an object",
		);
	});
});
