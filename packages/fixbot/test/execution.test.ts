import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { assertDockerGithubAuth, buildDockerEnvArgs } from "../src/execution";
import { deriveResultStatus } from "../src/markers";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("execution helpers", () => {
	it("builds Docker args for host agent dir mount and env passthrough", () => {
		const args = buildDockerEnvArgs(
			{
				hostAgentDir: "/host-agent",
				hostAgentDirExists: true,
				authFilePath: "/host-agent/auth.json",
				authFileExists: true,
			},
			{
				GH_TOKEN: "gh-token",
				OPENAI_API_KEY: "openai-key",
			} as unknown as NodeJS.ProcessEnv,
		);

		expect(args).toContain("FIXBOT_AGENT_DIR=/fixbot-host-agent");
		expect(args).toContain("/host-agent:/fixbot-host-agent:ro");
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

	it("keeps the Docker image contract explicit about bun base and workspace copy", () => {
		const dockerfile = readFileSync(join(packageRoot, "Dockerfile"), "utf-8");

		expect(dockerfile).toContain("FROM oven/bun:latest");
		expect(dockerfile).toContain("COPY package.json bun.lock ./");
		expect(dockerfile).toContain("COPY packages/ packages/");
		expect(dockerfile).toContain("bun install --production --frozen-lockfile");
		// ENTRYPOINT uses JSON array format — verify the daemon foreground command
		expect(dockerfile).toContain('"daemon"');
		expect(dockerfile).toContain('"start"');
		expect(dockerfile).toContain('"--foreground"');
	});
});
