import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@fixbot/pi-ai";
import { AuthStorage, ModelRegistry } from "@fixbot/pi-coding-agent";
import { afterEach, describe, expect, it } from "bun:test";
import { resolveExecutionModel, resolveHostAgentConfig } from "../src/host-agent";
import {
	buildGitFixPrompt,
	buildInjectedContext,
	getConfiguredAuthFilePath,
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
		const knownAnthropicModel = getModels("anthropic")[0];
		if (!knownAnthropicModel) {
			throw new Error("Expected at least one anthropic model in the registry");
		}

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

	it("uses the host default provider/model when no job override is provided", async () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "api_key",
				key: "test-key",
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, undefined);
		const knownAnthropicModel = getModels("anthropic")[0];
		if (!knownAnthropicModel) {
			throw new Error("Expected at least one anthropic model in the registry");
		}

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
				hostConfig: {
					hostAgentDir: "/tmp/host-agent",
					hostAgentDirExists: true,
					authFilePath: "/tmp/host-agent/auth.json",
					authFileExists: true,
					settingsFilePath: "/tmp/host-agent/settings.json",
					settingsFileExists: true,
					modelsFilePath: "/tmp/host-agent/models.json",
					modelsFileExists: false,
					defaultProvider: "anthropic",
					defaultModel: knownAnthropicModel.id,
				},
				authStorage,
				modelRegistry,
			},
		);

		expect(model.provider).toBe("anthropic");
		expect(model.id).toBe(knownAnthropicModel.id);
	});

	it("falls back when the host default model is unavailable", async () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "api_key",
				key: "test-key",
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, undefined);
		const fallbackModel = getModels("anthropic")[0];
		if (!fallbackModel) {
			throw new Error("Expected at least one anthropic model in the registry");
		}

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
				hostConfig: {
					hostAgentDir: "/tmp/host-agent",
					hostAgentDirExists: true,
					authFilePath: "/tmp/host-agent/auth.json",
					authFileExists: true,
					settingsFilePath: "/tmp/host-agent/settings.json",
					settingsFileExists: true,
					modelsFilePath: "/tmp/host-agent/models.json",
					modelsFileExists: false,
					defaultProvider: "anthropic",
					defaultModel: "does-not-exist",
				},
				authStorage,
				modelRegistry,
			},
		);

		expect(model.provider).toBe("anthropic");
		expect(model.id).toBe(fallbackModel.id);
	});

	it("fails fast when no authenticated models are available", async () => {
		// Clear all env vars that getEnvApiKey() would pick up so the in-memory
		// auth storage actually has no available models regardless of the host env.
		const envKeys = [
			"GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN",
			"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN",
			"OPENAI_API_KEY", "GOOGLE_CLOUD_API_KEY",
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

	it("resolves host auth paths with override precedence", () => {
		const hostDir = join(tmpdir(), `fixbot-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const authFile = join(tmpdir(), `fixbot-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
		mkdirSync(hostDir, { recursive: true });
		writeFileSync(authFile, "{}", "utf-8");
		writeFileSync(join(hostDir, "settings.json"), '{ "defaultProvider": "anthropic", "defaultModel": "x" }', "utf-8");

		try {
			const config = resolveHostAgentConfig({
				...process.env,
				FIXBOT_AGENT_DIR: hostDir,
				FIXBOT_AUTH_FILE: authFile,
			});
			expect(config.hostAgentDir).toBe(hostDir);
			expect(config.authFilePath).toBe(authFile);
			expect(config.settingsFilePath).toBe(join(hostDir, "settings.json"));
		} finally {
			rmSync(hostDir, { recursive: true, force: true });
			rmSync(authFile, { force: true });
		}
	});

	it("accepts an external auth file path from FIXBOT_AUTH_FILE", () => {
		const authFile = join(tmpdir(), `fixbot-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
		const originalAuthFile = process.env.FIXBOT_AUTH_FILE;
		writeFileSync(
			authFile,
			'{\n  "openai-codex": { "type": "oauth", "access": "x", "refresh": "y", "expires": 9999999999999, "accountId": "acct" }\n}\n',
			"utf-8",
		);
		process.env.FIXBOT_AUTH_FILE = authFile;

		try {
			expect(getConfiguredAuthFilePath()).toBe(authFile);
		} finally {
			if (originalAuthFile === undefined) {
				delete process.env.FIXBOT_AUTH_FILE;
			} else {
				process.env.FIXBOT_AUTH_FILE = originalAuthFile;
			}
			rmSync(authFile, { force: true });
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
