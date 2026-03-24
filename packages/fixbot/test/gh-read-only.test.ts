import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGhReadOnlyWrapperScript, createGhReadOnlyEnvironment } from "../src/gh-read-only";

const tempPaths: string[] = [];

afterEach(() => {
	for (const path of tempPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("gh read-only wrapper", () => {
	it("generates a wrapper that allows read-only run inspection and blocks mutations", () => {
		const script = buildGhReadOnlyWrapperScript("/usr/bin/gh");

		expect(script).toContain("view|list|download|watch");
		expect(script).toContain('deny "$@"');
		expect(script).toContain("fixbot read-only gh wrapper blocked");
		expect(script).not.toContain("create|edit|delete");
	});

	it("creates a wrapper directory and PATH override when gh exists", () => {
		const rootDir = join(tmpdir(), `fixbot-gh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const realBinDir = join(rootDir, "real-bin");
		const wrapperDir = join(rootDir, "wrapper-bin");
		tempPaths.push(rootDir);
		mkdirSync(realBinDir, { recursive: true });
		mkdirSync(wrapperDir, { recursive: true });
		const realGhPath = join(realBinDir, "gh");
		writeFileSync(realGhPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

		const result = createGhReadOnlyEnvironment(wrapperDir, {
			PATH: realBinDir,
		});

		expect(result.realGhPath).toBe(realGhPath);
		expect(result.wrapperPath).toBe(join(wrapperDir, "gh"));
		expect(result.env.PATH?.startsWith(`${wrapperDir}:`)).toBe(true);
		expect(result.env.GH_PROMPT_DISABLED).toBe("1");
		expect(readFileSync(result.wrapperPath as string, "utf-8")).toContain(realGhPath);
	});
});
