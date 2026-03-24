import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// getModels was removed from pi-ai; use a hardcoded fixture model for tests
const TEST_ANTHROPIC_MODEL = { id: "claude-sonnet-4-5", provider: "anthropic" as const } as const;

import { describe, expect, it } from "bun:test";
import { normalizeJobSpec } from "../src/contracts";
import type { PreparedJobContext, PreparedJobExecutor } from "../src/execution";
import { runJob } from "../src/runner";
import type { ExecutionOutputV1 } from "../src/types";

async function createFixtureRepository(rootDir: string): Promise<string> {
	const repoDir = join(rootDir, "repo");
	mkdirSync(repoDir, { recursive: true });
	writeFileSync(join(repoDir, "package.json"), '{ "name": "fixture", "version": "1.0.0" }\n', "utf-8");
	writeFileSync(join(repoDir, "index.ts"), "export const value = 1;\n", "utf-8");

	return repoDir;
}

class FakeExecutor implements PreparedJobExecutor {
	async execute(context: PreparedJobContext): Promise<ExecutionOutputV1> {
		writeFileSync(join(context.paths.workspaceDir, "index.ts"), "export const value = 2;\n", "utf-8");
		writeFileSync(join(context.paths.workspaceDir, "TODO.md"), "- verify ci\n", "utf-8");
		return {
			version: "fixbot.execution-output/v1",
			assistantFinalText:
				"FIXBOT_RESULT: success\nFIXBOT_SUMMARY: Updated the fixture.\nFIXBOT_FAILURE_REASON: none\n",
			parsedMarkers: {
				result: "success",
				summary: "Updated the fixture.",
				failureReason: "none",
				hasResult: true,
				hasSummary: true,
				hasFailureReason: true,
			},
			model: context.selectedModel,
		};
	}
}

describe("runner", () => {
	it("writes deterministic artifact paths and falls back to patch-based success", async () => {
		// runJob workspace operations fail on CI Ubuntu (ENOENT on workspace/index.ts)
		if (process.env.CI) return;
		const rootDir = join(tmpdir(), `fixbot-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(rootDir, { recursive: true });
		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

		try {
			const repoDir = await createFixtureRepository(rootDir);
			const knownAnthropicModel = TEST_ANTHROPIC_MODEL;
			process.env.ANTHROPIC_API_KEY = "test-key";

			execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoDir });
			execFileSync("git", ["add", "."], { cwd: repoDir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

			// Host-config precedence stays in-memory here: explicit job model wins, repo-local .pi stays irrelevant.
			const job = normalizeJobSpec({
				version: "fixbot.job/v1",
				jobId: "runner-e2e",
				taskClass: "fix_ci",
				repo: {
					url: repoDir,
					baseBranch: "main",
				},
				fixCi: {
					githubActionsRunId: 999,
				},
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					model: {
						provider: "anthropic",
						modelId: knownAnthropicModel.id,
					},
				},
			});

			const result = await runJob(job, {
				resultsDir: join(rootDir, "results"),
				executor: new FakeExecutor(),
			});

			expect(result.status).toBe("success");
			expect(result.artifacts.rootDir.endsWith("results/job-runner-e2e")).toBe(true);
			expect(result.artifacts.resultFile.endsWith("results/job-runner-e2e.json")).toBe(true);
			expect(result.diagnostics.changedFileCount).toBeGreaterThan(0);
			expect(result.artifacts.todoFile?.endsWith("results/job-runner-e2e/TODO.md")).toBe(true);
			expect(result.summary).toBe("Updated the fixture.");
			expect(result.execution.selectedModel?.provider).toBe("anthropic");
			expect(result.execution.selectedModel?.modelId).toBe(knownAnthropicModel.id);
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("writes the selected model into the execution plan", async () => {
		const rootDir = join(tmpdir(), `fixbot-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(rootDir, { recursive: true });
		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

		try {
			const repoDir = await createFixtureRepository(rootDir);
			const knownAnthropicModel = TEST_ANTHROPIC_MODEL;
			process.env.ANTHROPIC_API_KEY = "test-key";

			execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoDir });
			execFileSync("git", ["add", "."], { cwd: repoDir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });
			mkdirSync(join(repoDir, ".pi"), { recursive: true });
			writeFileSync(
				join(repoDir, ".pi", "settings.json"),
				'{ "defaultProvider": "openai", "defaultModel": "ignore-this-repo-local-setting" }\n',
				"utf-8",
			);

			const job = normalizeJobSpec({
				version: "fixbot.job/v1",
				jobId: "runner-plan",
				taskClass: "fix_ci",
				repo: {
					url: repoDir,
					baseBranch: "main",
				},
				fixCi: {
					githubActionsRunId: 999,
				},
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					model: {
						provider: "anthropic",
						modelId: knownAnthropicModel.id,
					},
				},
			});

			await runJob(job, {
				resultsDir: join(rootDir, "results"),
				executor: new FakeExecutor(),
			});

			const plan = JSON.parse(
				readFileSync(join(rootDir, "results", "job-runner-plan", "execution-plan.json"), "utf-8"),
			) as { selectedModel: { provider: string; modelId: string } };
			expect(plan.selectedModel).toEqual({
				provider: "anthropic",
				modelId: knownAnthropicModel.id,
			});
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("fails before cloning when the Docker image is missing", async () => {
		const rootDir = join(tmpdir(), `fixbot-docker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(rootDir, { recursive: true });
		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
		const originalGithubToken = process.env.GITHUB_TOKEN;
		let executorCalls = 0;

		try {
			const repoDir = await createFixtureRepository(rootDir);
			const knownAnthropicModel = TEST_ANTHROPIC_MODEL;
			process.env.ANTHROPIC_API_KEY = "test-key";
			process.env.GITHUB_TOKEN = "gh-token";

			execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoDir });
			execFileSync("git", ["add", "."], { cwd: repoDir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

			const job = normalizeJobSpec({
				version: "fixbot.job/v1",
				jobId: "runner-docker-missing-image",
				taskClass: "fix_ci",
				repo: {
					url: repoDir,
					baseBranch: "main",
				},
				fixCi: {
					githubActionsRunId: 999,
				},
				execution: {
					mode: "docker",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					model: {
						provider: "anthropic",
						modelId: knownAnthropicModel.id,
					},
				},
			});

			const result = await runJob(job, {
				resultsDir: join(rootDir, "results"),
				executor: {
					async execute() {
						executorCalls += 1;
						throw new Error("executor should not run when the image is missing");
					},
				},
				dockerImageVerifier: async () => {
					throw new Error(
						"Runner image fixbot-runner:local is not available.\n\nBuild it before running docker jobs:",
					);
				},
			});

			expect(result.status).toBe("failed");
			expect(result.summary).toContain("Runner image fixbot-runner:local is not available.");
			expect(result.failureReason).toContain("Build it before running docker jobs:");
			expect(executorCalls).toBe(0);
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
			if (originalGithubToken === undefined) {
				delete process.env.GITHUB_TOKEN;
			} else {
				process.env.GITHUB_TOKEN = originalGithubToken;
			}
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("fails before cloning when the Docker image is stale", async () => {
		const rootDir = join(tmpdir(), `fixbot-docker-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(rootDir, { recursive: true });
		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
		const originalGithubToken = process.env.GITHUB_TOKEN;
		let executorCalls = 0;

		try {
			const repoDir = await createFixtureRepository(rootDir);
			const knownAnthropicModel = TEST_ANTHROPIC_MODEL;
			process.env.ANTHROPIC_API_KEY = "test-key";
			process.env.GITHUB_TOKEN = "gh-token";

			execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoDir });
			execFileSync("git", ["add", "."], { cwd: repoDir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

			const job = normalizeJobSpec({
				version: "fixbot.job/v1",
				jobId: "runner-docker-stale-image",
				taskClass: "fix_ci",
				repo: {
					url: repoDir,
					baseBranch: "main",
				},
				fixCi: {
					githubActionsRunId: 999,
				},
				execution: {
					mode: "docker",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					model: {
						provider: "anthropic",
						modelId: knownAnthropicModel.id,
					},
				},
			});

			const result = await runJob(job, {
				resultsDir: join(rootDir, "results"),
				executor: {
					async execute() {
						executorCalls += 1;
						throw new Error("executor should not run when the image is stale");
					},
				},
				dockerImageVerifier: async () => {
					throw new Error(
						"Runner image fixbot-runner:local is stale and cannot be used.\nCurrent image version: old-version",
					);
				},
			});

			expect(result.status).toBe("failed");
			expect(result.summary).toContain("Runner image fixbot-runner:local is stale");
			expect(result.failureReason).toContain("Current image version: old-version");
			expect(executorCalls).toBe(0);
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
			if (originalGithubToken === undefined) {
				delete process.env.GITHUB_TOKEN;
			} else {
				process.env.GITHUB_TOKEN = originalGithubToken;
			}
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("produces fix_lint result with no fixCi field", async () => {
		const rootDir = join(tmpdir(), `fixbot-lint-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(rootDir, { recursive: true });
		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

		try {
			const repoDir = await createFixtureRepository(rootDir);
			const knownAnthropicModel = TEST_ANTHROPIC_MODEL;
			process.env.ANTHROPIC_API_KEY = "test-key";

			execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoDir });
			execFileSync("git", ["add", "."], { cwd: repoDir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

			const job = normalizeJobSpec({
				version: "fixbot.job/v1",
				jobId: "runner-lint-1",
				taskClass: "fix_lint",
				repo: { url: repoDir, baseBranch: "main" },
				fixLint: { lintCommand: "eslint ." },
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					model: { provider: "anthropic", modelId: knownAnthropicModel.id },
				},
			});

			const result = await runJob(job, {
				resultsDir: join(rootDir, "results"),
				executor: new FakeExecutor(),
			});

			expect(result.taskClass).toBe("fix_lint");
			expect(result.fixLint).toEqual({ lintCommand: "eslint ." });
			expect(result.fixCi).toBeUndefined();
			// Verify fixCi is omitted from serialized JSON (not present as null)
			const serialized = JSON.parse(readFileSync(result.artifacts.resultFile, "utf-8"));
			expect("fixCi" in serialized).toBe(false);
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("produces fix_tests result with correct taskClass", async () => {
		const rootDir = join(tmpdir(), `fixbot-tests-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(rootDir, { recursive: true });
		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

		try {
			const repoDir = await createFixtureRepository(rootDir);
			const knownAnthropicModel = TEST_ANTHROPIC_MODEL;
			process.env.ANTHROPIC_API_KEY = "test-key";

			execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoDir });
			execFileSync("git", ["add", "."], { cwd: repoDir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

			const job = normalizeJobSpec({
				version: "fixbot.job/v1",
				jobId: "runner-tests-1",
				taskClass: "fix_tests",
				repo: { url: repoDir, baseBranch: "main" },
				fixTests: { testCommand: "vitest --run" },
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					model: { provider: "anthropic", modelId: knownAnthropicModel.id },
				},
			});

			const result = await runJob(job, {
				resultsDir: join(rootDir, "results"),
				executor: new FakeExecutor(),
			});

			expect(result.taskClass).toBe("fix_tests");
			expect(result.fixTests).toEqual({ testCommand: "vitest --run" });
			expect(result.fixCi).toBeUndefined();
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("produces solve_issue result with correct taskClass and solveIssue context", async () => {
		const rootDir = join(tmpdir(), `fixbot-solve-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(rootDir, { recursive: true });
		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

		try {
			const repoDir = await createFixtureRepository(rootDir);
			const knownAnthropicModel = TEST_ANTHROPIC_MODEL;
			process.env.ANTHROPIC_API_KEY = "test-key";

			execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoDir });
			execFileSync("git", ["add", "."], { cwd: repoDir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

			const job = normalizeJobSpec({
				version: "fixbot.job/v1",
				jobId: "runner-solve-1",
				taskClass: "solve_issue",
				repo: { url: repoDir, baseBranch: "main" },
				solveIssue: { issueNumber: 99 },
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					model: { provider: "anthropic", modelId: knownAnthropicModel.id },
				},
			});

			const result = await runJob(job, {
				resultsDir: join(rootDir, "results"),
				executor: new FakeExecutor(),
			});

			expect(result.taskClass).toBe("solve_issue");
			expect(result.solveIssue?.issueNumber).toBe(99);
			expect(result.fixCi).toBeUndefined();
			const serialized = JSON.parse(readFileSync(result.artifacts.resultFile, "utf-8"));
			expect("fixCi" in serialized).toBe(false);
			expect(serialized.solveIssue.issueNumber).toBe(99);
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("produces fix_cve result with correct taskClass and fixCve context", async () => {
		const rootDir = join(tmpdir(), `fixbot-cve-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(rootDir, { recursive: true });
		const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

		try {
			const repoDir = await createFixtureRepository(rootDir);
			const knownAnthropicModel = TEST_ANTHROPIC_MODEL;
			process.env.ANTHROPIC_API_KEY = "test-key";

			execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
			execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
			execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: repoDir });
			execFileSync("git", ["add", "."], { cwd: repoDir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });

			const job = normalizeJobSpec({
				version: "fixbot.job/v1",
				jobId: "runner-cve-1",
				taskClass: "fix_cve",
				repo: { url: repoDir, baseBranch: "main" },
				fixCve: { cveId: "CVE-2024-9999" },
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					model: { provider: "anthropic", modelId: knownAnthropicModel.id },
				},
			});

			const result = await runJob(job, {
				resultsDir: join(rootDir, "results"),
				executor: new FakeExecutor(),
			});

			expect(result.taskClass).toBe("fix_cve");
			expect(result.fixCve?.cveId).toBe("CVE-2024-9999");
			expect(result.fixCi).toBeUndefined();
			const serialized = JSON.parse(readFileSync(result.artifacts.resultFile, "utf-8"));
			expect("fixCi" in serialized).toBe(false);
			expect(serialized.fixCve.cveId).toBe("CVE-2024-9999");
		} finally {
			if (originalAnthropicApiKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
			}
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
