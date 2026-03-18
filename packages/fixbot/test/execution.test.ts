import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { assertDockerGithubAuth, buildDockerEnvArgs } from "../src/execution";
import { deriveResultStatus } from "../src/markers";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("execution helpers", () => {
	it("builds Docker args for host auth, settings, models, and GitHub auth", () => {
		const args = buildDockerEnvArgs(
			{
				hostAgentDir: "/host-agent",
				hostAgentDirExists: true,
				authFilePath: "/host-agent/auth.json",
				authFileExists: true,
				settingsFilePath: "/host-agent/settings.json",
				settingsFileExists: true,
				modelsFilePath: "/host-agent/models.json",
				modelsFileExists: true,
				defaultProvider: "anthropic",
				defaultModel: "claude-sonnet-4-5",
			},
			{
				GH_TOKEN: "gh-token",
				OPENAI_API_KEY: "openai-key",
			},
		);

		expect(args).toContain("FIXBOT_AGENT_DIR=/fixbot-host-agent");
		expect(args).toContain("FIXBOT_AUTH_FILE=/fixbot-host-agent/auth.json");
		expect(args).toContain("/host-agent/settings.json:/fixbot-host-agent/settings.json:ro");
		expect(args).toContain("/host-agent/models.json:/fixbot-host-agent/models.json:ro");
		expect(args).toContain("GH_TOKEN");
		expect(args).toContain("OPENAI_API_KEY");
	});

	it("fails fast when Docker GitHub auth is missing", () => {
		expect(() => assertDockerGithubAuth({})).toThrow("Docker fixbot runs require GitHub CLI authentication");
	});

	it("surfaces assistant/provider errors before empty patch fallback", () => {
		const result = deriveResultStatus({
			assistantFinalText: "",
			patchText: "",
			parsedMarkers: {
				hasFailureReason: false,
				hasResult: false,
				hasSummary: false,
			},
			assistantError: "Cloud Code Assist API error (404): Requested entity was not found.",
		});

		expect(result.status).toBe("failed");
		expect(result.summary).toContain("Requested entity was not found");
		expect(result.failureReason).toContain("Requested entity was not found");
	});

	it("keeps explicit markers above execution errors", () => {
		const result = deriveResultStatus({
			assistantFinalText: "FIXBOT_RESULT: success\nFIXBOT_SUMMARY: Fixed the issue.\nFIXBOT_FAILURE_REASON: none\n",
			patchText: "",
			parsedMarkers: {
				result: "success",
				summary: "Fixed the issue.",
				failureReason: "none",
				hasFailureReason: true,
				hasResult: true,
				hasSummary: true,
			},
			assistantError: "Provider failed",
		});

		expect(result.status).toBe("success");
		expect(result.summary).toBe("Fixed the issue.");
	});

	it("keeps the Docker image contract explicit about ca certificates, gh, and git", () => {
		const dockerfile = readFileSync(join(packageRoot, "Dockerfile"), "utf-8");

		expect(dockerfile).toContain("FROM mcr.microsoft.com/devcontainers/base:2-noble");
		expect(dockerfile).toContain("apt-get install -y --no-install-recommends ca-certificates gh git curl xz-utils");
		expect(dockerfile).toContain('curl -fsSL "https://nodejs.org/dist/v${' + "NODE_VERSION}");
		expect(dockerfile).toContain("node --version");
		expect(dockerfile).toContain("npm --version");
		expect(dockerfile).toContain("mkdir -p /fixbot-host-agent");
		expect(dockerfile).toContain("COPY package.json package-lock.json ./");
		expect(dockerfile).toContain("COPY packages/fixbot/dist ./packages/fixbot/dist");
		expect(dockerfile).not.toContain("npm --prefix packages/fixbot run build");
	});
});
