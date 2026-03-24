import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// getModels was removed from pi-ai; use a hardcoded fixture model for tests
const TEST_ANTHROPIC_MODEL = { id: "claude-sonnet-4-5", provider: "anthropic" as const } as const;

import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "bun:test";
import { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { resolveExecutionModel, resolveHostAgentConfig } from "../src/host-agent";
import {
	buildGitFixPrompt,
	buildInjectedContext,
	resolveSkillPath,
	runInternalExecutionFromPlan,
	type SessionDriver,
} from "../src/internal-runner";
import type { ExecutionPlanV1, NormalizedJobSpecV1 } from "../src/types";

describe("internal runner", () => {
	it("resolves an explicit model override when provider auth is available", async () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "api_key",
				key: "test-key",
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, undefined);
		const knownAnthropicModel = TEST_ANTHROPIC_MODEL;

		const model = await resolveExecutionModel(
			{
				version: "fixbot.job/v1",
				jobId: "internal-model",
				taskClass: "fix_ci",
				repo: {
					url: "https://example.com/repo.git",
					baseBranch: "main",
				},
				fixCi: {
					githubActionsRunId: 12345,
				},
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					sandbox: {
						mode: "workspace-write",
						networkAccess: true,
					},
					model: {
						provider: "anthropic",
						modelId: knownAnthropicModel.id,
					},
				},
			},
			{ modelRegistry },
		);

		expect(model.provider).toBe("anthropic");
		expect(model.id).toBe(knownAnthropicModel.id);
	});

	it("uses the provider default model when no job override is provided", async () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "api_key",
				key: "test-key",
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, undefined);

		const model = await resolveExecutionModel(
			{
				version: "fixbot.job/v1",
				jobId: "internal-host-default",
				taskClass: "fix_ci",
				repo: {
					url: "https://example.com/repo.git",
					baseBranch: "main",
				},
				fixCi: {
					githubActionsRunId: 12345,
				},
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					sandbox: {
						mode: "workspace-write",
						networkAccess: true,
					},
				},
			},
			{
				authStorage,
				modelRegistry,
			},
		);

		expect(model.provider).toBe("anthropic");
		expect(model.id).toBe(DEFAULT_MODEL_PER_PROVIDER.anthropic);
	});

	it("falls back to provider default when no job model override", async () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "api_key",
				key: "test-key",
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, undefined);

		const model = await resolveExecutionModel(
			{
				version: "fixbot.job/v1",
				jobId: "internal-bad-host-default",
				taskClass: "fix_ci",
				repo: {
					url: "https://example.com/repo.git",
					baseBranch: "main",
				},
				fixCi: {
					githubActionsRunId: 12345,
				},
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					sandbox: {
						mode: "workspace-write",
						networkAccess: true,
					},
				},
			},
			{
				authStorage,
				modelRegistry,
			},
		);

		expect(model.provider).toBe("anthropic");
		expect(model.id).toBe(DEFAULT_MODEL_PER_PROVIDER.anthropic);
	});

	it("fails fast when no authenticated models are available", async () => {
		// Clear all env vars that getEnvApiKey() would pick up so the in-memory
		// auth storage actually has no available models regardless of the host env.
		const envKeys = [
			"GITHUB_TOKEN",
			"GH_TOKEN",
			"COPILOT_GITHUB_TOKEN",
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"OPENAI_API_KEY",
			"GOOGLE_CLOUD_API_KEY",
		] as const;
		const savedEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
		for (const k of envKeys) process.env[k] = "";

		try {
			const authStorage = AuthStorage.inMemory();
			const modelRegistry = new ModelRegistry(authStorage, undefined);

			await expect(
				resolveExecutionModel(
					{
						version: "fixbot.job/v1",
						jobId: "internal-no-model",
						taskClass: "fix_ci",
						repo: {
							url: "https://example.com/repo.git",
							baseBranch: "main",
						},
						fixCi: {
							githubActionsRunId: 12345,
						},
						execution: {
							mode: "process",
							timeoutMs: 300000,
							memoryLimitMb: 4096,
							sandbox: {
								mode: "workspace-write",
								networkAccess: true,
							},
						},
					},
					{ modelRegistry },
				),
			).rejects.toThrow("No authenticated models are available for this fixbot run.");
		} finally {
			for (const [k, v] of Object.entries(savedEnv)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("resolves host agent dir from FIXBOT_AGENT_DIR env var", () => {
		const hostDir = join(tmpdir(), `fixbot-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(hostDir, { recursive: true });

		const original = process.env.FIXBOT_AGENT_DIR;
		process.env.FIXBOT_AGENT_DIR = hostDir;
		try {
			const config = resolveHostAgentConfig();
			expect(config.hostAgentDir).toBe(hostDir);
			expect(config.hostAgentDirExists).toBe(true);
		} finally {
			if (original === undefined) {
				delete process.env.FIXBOT_AGENT_DIR;
			} else {
				process.env.FIXBOT_AGENT_DIR = original;
			}
			rmSync(hostDir, { recursive: true, force: true });
		}
	});

	it("throws when FIXBOT_AGENT_DIR points to non-existent directory", () => {
		const original = process.env.FIXBOT_AGENT_DIR;
		process.env.FIXBOT_AGENT_DIR = "/tmp/does-not-exist-fixbot-test";
		try {
			expect(() => resolveHostAgentConfig()).toThrow("does not exist");
		} finally {
			if (original === undefined) {
				delete process.env.FIXBOT_AGENT_DIR;
			} else {
				process.env.FIXBOT_AGENT_DIR = original;
			}
		}
	});

	it("injects the bundled skill via /skill:fix-ci", async () => {
		const artifactDir = join(tmpdir(), `fixbot-internal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(artifactDir, "workspace"), { recursive: true });

		const plan: ExecutionPlanV1 = {
			version: "fixbot.execution/v1",
			baseCommit: "abc123",
			job: {
				version: "fixbot.job/v1",
				jobId: "internal-1",
				taskClass: "fix_ci",
				repo: {
					url: "https://example.com/repo.git",
					baseBranch: "main",
				},
				fixCi: {
					githubActionsRunId: 12345,
				},
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					sandbox: {
						mode: "workspace-write",
						networkAccess: true,
					},
				},
			},
			selectedModel: {
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			},
		};

		const planFile = join(artifactDir, "execution-plan.json");
		writeFileSync(planFile, JSON.stringify(plan, null, 2), "utf-8");

		let capturedPrompt = "";
		let capturedInjectedContext = "";
		const fakeDriver: SessionDriver = {
			async run(input) {
				capturedPrompt = input.prompt;
				capturedInjectedContext = readFileSync(input.injectedContextFile, "utf-8");
				writeFileSync(
					input.assistantFinalFile,
					"FIXBOT_RESULT: failed\nFIXBOT_SUMMARY: no-op\nFIXBOT_FAILURE_REASON: none\n",
				);
				return {
					assistantFinalText: "FIXBOT_RESULT: failed\nFIXBOT_SUMMARY: no-op\nFIXBOT_FAILURE_REASON: none\n",
					model: input.selectedModel,
				};
			},
		};

		try {
			await runInternalExecutionFromPlan(planFile, { sessionDriver: fakeDriver });
			expect(capturedPrompt.startsWith("/skill:fix-ci ")).toBe(true);
			expect(capturedPrompt).toContain("GitHub access as read-only");
			expect(capturedInjectedContext).toContain(
				"Do not push branches, create pull requests, or mutate GitHub state.",
			);
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("resolveSkillPath returns correct path for fix_lint", () => {
		const path = resolveSkillPath("fix_lint");
		expect(path).toMatch(/skills\/fix-lint\/SKILL\.md$/);
	});

	it("resolveSkillPath returns correct path for fix_tests", () => {
		const path = resolveSkillPath("fix_tests");
		expect(path).toMatch(/skills\/fix-tests\/SKILL\.md$/);
	});

	it("buildGitFixPrompt for fix_lint contains /skill:fix-lint", () => {
		const job: NormalizedJobSpecV1 = {
			version: "fixbot.job/v1",
			jobId: "lint-1",
			taskClass: "fix_lint",
			repo: { url: "https://example.com/repo.git", baseBranch: "main" },
			fixLint: { lintCommand: "npm run lint" },
			execution: {
				mode: "process",
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: true },
			},
		};
		const prompt = buildGitFixPrompt(job);
		expect(prompt).toContain("/skill:fix-lint");
		expect(prompt).toContain("npm run lint");
		expect(prompt).not.toContain("/skill:fix-ci");
	});

	it("buildGitFixPrompt for fix_tests contains /skill:fix-tests", () => {
		const job: NormalizedJobSpecV1 = {
			version: "fixbot.job/v1",
			jobId: "tests-1",
			taskClass: "fix_tests",
			repo: { url: "https://example.com/repo.git", baseBranch: "main" },
			fixTests: { testCommand: "npm test" },
			execution: {
				mode: "process",
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: true },
			},
		};
		const prompt = buildGitFixPrompt(job);
		expect(prompt).toContain("/skill:fix-tests");
		expect(prompt).toContain("npm test");
		expect(prompt).not.toContain("/skill:fix-ci");
	});

	it("buildInjectedContext for fix_lint does not contain GitHub Actions Run ID", () => {
		const job: NormalizedJobSpecV1 = {
			version: "fixbot.job/v1",
			jobId: "lint-ctx-1",
			taskClass: "fix_lint",
			repo: { url: "https://example.com/repo.git", baseBranch: "main" },
			fixLint: { lintCommand: "eslint ." },
			execution: {
				mode: "process",
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: true },
			},
		};
		const ctx = buildInjectedContext(job, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(ctx).not.toContain("GitHub Actions Run ID");
		expect(ctx).toContain("Lint Command: eslint .");
	});

	it("buildInjectedContext for fix_tests contains Test Command", () => {
		const job: NormalizedJobSpecV1 = {
			version: "fixbot.job/v1",
			jobId: "tests-ctx-1",
			taskClass: "fix_tests",
			repo: { url: "https://example.com/repo.git", baseBranch: "main" },
			fixTests: { testCommand: "vitest --run" },
			execution: {
				mode: "process",
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: true },
			},
		};
		const ctx = buildInjectedContext(job, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(ctx).not.toContain("GitHub Actions Run ID");
		expect(ctx).toContain("Test Command: vitest --run");
	});

	it("buildGitFixPrompt for solve_issue contains /skill:solve-issue", () => {
		const job: NormalizedJobSpecV1 = {
			version: "fixbot.job/v1",
			jobId: "solve-1",
			taskClass: "solve_issue",
			repo: { url: "https://example.com/repo.git", baseBranch: "main" },
			solveIssue: { issueNumber: 10 },
			execution: {
				mode: "process",
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: true },
			},
		};
		const prompt = buildGitFixPrompt(job);
		expect(prompt.startsWith("/skill:solve-issue")).toBe(true);
		expect(prompt).toContain("Issue number: 10");
		expect(prompt).not.toContain("/skill:fix-ci");
	});

	it("buildGitFixPrompt for fix_cve contains /skill:fix-cve", () => {
		const job: NormalizedJobSpecV1 = {
			version: "fixbot.job/v1",
			jobId: "cve-1",
			taskClass: "fix_cve",
			repo: { url: "https://example.com/repo.git", baseBranch: "main" },
			fixCve: { cveId: "CVE-2024-5678" },
			execution: {
				mode: "process",
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: true },
			},
		};
		const prompt = buildGitFixPrompt(job);
		expect(prompt.startsWith("/skill:fix-cve")).toBe(true);
		expect(prompt).toContain("CVE-2024-5678");
		expect(prompt).not.toContain("/skill:fix-ci");
	});

	it("buildInjectedContext for solve_issue contains Issue Number", () => {
		const job: NormalizedJobSpecV1 = {
			version: "fixbot.job/v1",
			jobId: "solve-ctx-1",
			taskClass: "solve_issue",
			repo: { url: "https://example.com/repo.git", baseBranch: "main" },
			solveIssue: { issueNumber: 10, issueTitle: "Fix parsing bug", issueBody: "Details here" },
			execution: {
				mode: "process",
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: true },
			},
		};
		const ctx = buildInjectedContext(job, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(ctx).toContain("Issue Number: 10");
		expect(ctx).toContain("Issue Title: Fix parsing bug");
		expect(ctx).toContain("Issue Body: Details here");
		expect(ctx).not.toContain("GitHub Actions Run ID");
	});

	it("buildInjectedContext for fix_cve contains CVE ID", () => {
		const job: NormalizedJobSpecV1 = {
			version: "fixbot.job/v1",
			jobId: "cve-ctx-1",
			taskClass: "fix_cve",
			repo: { url: "https://example.com/repo.git", baseBranch: "main" },
			fixCve: { cveId: "CVE-2024-5678", vulnerablePackage: "express", targetVersion: "4.19.0" },
			execution: {
				mode: "process",
				timeoutMs: 300000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: true },
			},
		};
		const ctx = buildInjectedContext(job, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(ctx).toContain("CVE ID: CVE-2024-5678");
		expect(ctx).toContain("Vulnerable Package: express");
		expect(ctx).toContain("Target Version: 4.19.0");
		expect(ctx).not.toContain("GitHub Actions Run ID");
	});

	it("mock session driver receives correct prompt for fix_lint plan", async () => {
		const artifactDir = join(tmpdir(), `fixbot-lint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(artifactDir, "workspace"), { recursive: true });

		const plan: ExecutionPlanV1 = {
			version: "fixbot.execution/v1",
			baseCommit: "abc123",
			job: {
				version: "fixbot.job/v1",
				jobId: "lint-plan-1",
				taskClass: "fix_lint",
				repo: { url: "https://example.com/repo.git", baseBranch: "main" },
				fixLint: { lintCommand: "npm run lint" },
				execution: {
					mode: "process",
					timeoutMs: 300000,
					memoryLimitMb: 4096,
					sandbox: { mode: "workspace-write", networkAccess: true },
				},
			},
			selectedModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		};

		const planFile = join(artifactDir, "execution-plan.json");
		writeFileSync(planFile, JSON.stringify(plan, null, 2), "utf-8");

		let capturedPrompt = "";
		let capturedInjectedContext = "";
		const fakeDriver: SessionDriver = {
			async run(input) {
				capturedPrompt = input.prompt;
				capturedInjectedContext = readFileSync(input.injectedContextFile, "utf-8");
				writeFileSync(
					input.assistantFinalFile,
					"FIXBOT_RESULT: failed\nFIXBOT_SUMMARY: no-op\nFIXBOT_FAILURE_REASON: none\n",
				);
				return {
					assistantFinalText: "FIXBOT_RESULT: failed\nFIXBOT_SUMMARY: no-op\nFIXBOT_FAILURE_REASON: none\n",
					model: input.selectedModel,
				};
			},
		};

		try {
			await runInternalExecutionFromPlan(planFile, { sessionDriver: fakeDriver });
			expect(capturedPrompt).toContain("/skill:fix-lint");
			expect(capturedPrompt).not.toContain("/skill:fix-ci");
			expect(capturedInjectedContext).toContain("Lint Command: npm run lint");
			expect(capturedInjectedContext).not.toContain("GitHub Actions Run ID");
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});
});
