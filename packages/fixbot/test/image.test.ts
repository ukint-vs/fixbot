import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMissingDockerImageError,
	buildStaleDockerImageError,
	getDockerBuildAssets,
	getDockerImageBuildCommand,
	getDockerImageName,
	getRunnerImageVersion,
	getRunnerImageVersionLabel,
	stageDockerBuildContext,
} from "../src/image";

const tempPaths: string[] = [];

function createRuntimeFixture(): string {
	const rootDir = join(tmpdir(), `fixbot-image-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	tempPaths.push(rootDir);

	for (const relativePath of getDockerBuildAssets()) {
		const absolutePath = join(rootDir, relativePath);
		if (relativePath.endsWith("/dist") || relativePath.endsWith("/docs")) {
			mkdirSync(absolutePath, { recursive: true });
			writeFileSync(join(absolutePath, "placeholder.txt"), `${relativePath}\n`, "utf-8");
			continue;
		}

		mkdirSync(join(absolutePath, ".."), { recursive: true });
		writeFileSync(absolutePath, `${relativePath}\n`, "utf-8");
	}

	return rootDir;
}

afterEach(() => {
	for (const path of tempPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("image helpers", () => {
	it("uses a stable default Docker image tag", () => {
		expect(getDockerImageName({})).toBe("fixbot-runner:local");
		expect(getDockerImageName({ FIXBOT_DOCKER_IMAGE: "custom:tag" })).toBe("custom:tag");
	});

	it("stages only the runtime build context", () => {
		const fixtureRoot = createRuntimeFixture();
		const buildContext = stageDockerBuildContext(fixtureRoot, {});
		tempPaths.push(buildContext.contextDir);

		expect(existsSync(join(buildContext.contextDir, ".dockerignore"))).toBe(false);
		expect(existsSync(join(buildContext.contextDir, "packages", "fixbot", "dist"))).toBe(true);
		expect(existsSync(join(buildContext.contextDir, "packages", "coding-agent", "docs"))).toBe(true);
		expect(readFileSync(join(buildContext.contextDir, "packages", "ai", "bedrock-provider.js"), "utf-8")).toContain(
			"packages/ai/bedrock-provider.js",
		);
		expect(buildContext.imageName).toBe("fixbot-runner:local");
	});

	it("fails clearly when required runtime artifacts are missing", () => {
		const fixtureRoot = createRuntimeFixture();
		rmSync(join(fixtureRoot, "packages", "fixbot", "dist"), { recursive: true, force: true });

		expect(() => stageDockerBuildContext(fixtureRoot, {})).toThrow("Missing runtime assets:");
		expect(() => stageDockerBuildContext(fixtureRoot, {})).toThrow("packages/fixbot/dist");
	});

	it("returns actionable guidance for a missing runner image", () => {
		const error = buildMissingDockerImageError("fixbot-runner:local");

		expect(error.message).toContain("Runner image fixbot-runner:local is not available.");
		expect(error.message).toContain(getDockerImageBuildCommand());
	});

	it("returns actionable guidance for a stale runner image", () => {
		const error = buildStaleDockerImageError("fixbot-runner:local", "old-version");

		expect(error.message).toContain("Runner image fixbot-runner:local is stale");
		expect(error.message).toContain("Current image version: old-version");
		expect(error.message).toContain(`Expected image version: ${getRunnerImageVersion()}`);
		expect(getRunnerImageVersionLabel()).toBe("io.pi.fixbot.runner-image-version");
	});
});
