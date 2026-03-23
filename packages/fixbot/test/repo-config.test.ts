import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createCapturingLogger } from "../src/logger";
import {
	loadRepoConfig,
	mergeConfigs,
	parseModelString,
	parseRepoConfig,
	REPO_CONFIG_PATH,
} from "../src/repo-config";
import type { DaemonModelConfig, RepoConfig } from "../src/types";

// ---------------------------------------------------------------------------
// parseModelString
// ---------------------------------------------------------------------------

describe("parseModelString", () => {
	it("parses a valid provider/modelId string", () => {
		expect(parseModelString("anthropic/claude-sonnet-4-6")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
	});

	it("handles whitespace around the string", () => {
		expect(parseModelString("  openai/gpt-4o  ")).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
	});

	it("returns undefined for non-string input", () => {
		expect(parseModelString(123)).toBeUndefined();
		expect(parseModelString(null)).toBeUndefined();
		expect(parseModelString(undefined)).toBeUndefined();
	});

	it("returns undefined for string without slash", () => {
		expect(parseModelString("claude-sonnet-4-6")).toBeUndefined();
	});

	it("returns undefined for string with only leading slash", () => {
		expect(parseModelString("/claude-sonnet-4-6")).toBeUndefined();
	});

	it("returns undefined for string with only trailing slash", () => {
		expect(parseModelString("anthropic/")).toBeUndefined();
	});

	it("handles model IDs with multiple slashes", () => {
		expect(parseModelString("provider/org/model-name")).toEqual({
			provider: "provider",
			modelId: "org/model-name",
		});
	});
});

// ---------------------------------------------------------------------------
// parseRepoConfig
// ---------------------------------------------------------------------------

describe("parseRepoConfig", () => {
	it("parses a valid full config", () => {
		const yaml = `
model: anthropic/claude-sonnet-4-6
excludePaths:
  - "vendor/**"
  - "generated/**"
  - "*.lock"
`;
		const { config, warnings } = parseRepoConfig(yaml);
		expect(warnings).toEqual([]);
		expect(config.model).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
		expect(config.excludePaths).toEqual(["vendor/**", "generated/**", "*.lock"]);
	});

	it("returns empty config for empty YAML", () => {
		const { config, warnings } = parseRepoConfig("");
		expect(warnings).toEqual([]);
		expect(config).toEqual({});
	});

	it("returns empty config for null YAML document", () => {
		const { config, warnings } = parseRepoConfig("null");
		expect(warnings).toEqual([]);
		expect(config).toEqual({});
	});

	it("warns on invalid YAML syntax", () => {
		const { config, warnings } = parseRepoConfig("model:\n  - :\n  bad: [unterminated");
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("Invalid YAML");
		expect(config).toEqual({});
	});

	it("warns when config is an array instead of object", () => {
		const { config, warnings } = parseRepoConfig("- item1\n- item2");
		expect(warnings).toEqual(["Config must be a YAML mapping (object), got array"]);
		expect(config).toEqual({});
	});

	it("warns on unknown keys but still parses known keys", () => {
		const yaml = `
model: anthropic/claude-sonnet-4-6
unknownKey: value
anotherUnknown: 42
`;
		const { config, warnings } = parseRepoConfig(yaml);
		expect(warnings).toContainEqual('Unknown config key "unknownKey" — ignoring');
		expect(warnings).toContainEqual('Unknown config key "anotherUnknown" — ignoring');
		expect(config.model).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
	});

	it("warns on invalid model format", () => {
		const yaml = "model: just-a-model-name";
		const { config, warnings } = parseRepoConfig(yaml);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("Invalid model value");
		expect(config.model).toBeUndefined();
	});

	it("warns on non-array excludePaths", () => {
		const yaml = "excludePaths: vendor/**";
		const { config, warnings } = parseRepoConfig(yaml);
		expect(warnings).toEqual(["excludePaths must be an array of glob strings"]);
		expect(config.excludePaths).toBeUndefined();
	});

	it("filters invalid entries from excludePaths array", () => {
		const yaml = `
excludePaths:
  - "vendor/**"
  - 123
  - ""
  - "*.lock"
`;
		const { config, warnings } = parseRepoConfig(yaml);
		expect(config.excludePaths).toEqual(["vendor/**", "*.lock"]);
		expect(warnings.length).toBe(2);
	});

	it("parses config with only model", () => {
		const yaml = "model: openai/gpt-4o";
		const { config, warnings } = parseRepoConfig(yaml);
		expect(warnings).toEqual([]);
		expect(config.model).toEqual({ provider: "openai", modelId: "gpt-4o" });
		expect(config.excludePaths).toBeUndefined();
	});

	it("parses config with only excludePaths", () => {
		const yaml = 'excludePaths:\n  - "dist/**"';
		const { config, warnings } = parseRepoConfig(yaml);
		expect(warnings).toEqual([]);
		expect(config.model).toBeUndefined();
		expect(config.excludePaths).toEqual(["dist/**"]);
	});
});

// ---------------------------------------------------------------------------
// loadRepoConfig
// ---------------------------------------------------------------------------

describe("loadRepoConfig", () => {
	let tmpDir: string;

	function makeTmpDir(): string {
		const dir = join(tmpdir(), `fixbot-repo-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	afterEach(() => {
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	it("returns empty config when .fixbot/config.yml does not exist", () => {
		tmpDir = makeTmpDir();
		const { config, warnings } = loadRepoConfig(tmpDir);
		expect(config).toEqual({});
		expect(warnings).toEqual([]);
	});

	it("loads and parses a valid config file", () => {
		tmpDir = makeTmpDir();
		const configDir = join(tmpDir, ".fixbot");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.yml"),
			'model: anthropic/claude-sonnet-4-6\nexcludePaths:\n  - "vendor/**"\n',
			"utf-8",
		);

		const logger = createCapturingLogger();
		const { config, warnings } = loadRepoConfig(tmpDir, logger);
		expect(warnings).toEqual([]);
		expect(config.model).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
		expect(config.excludePaths).toEqual(["vendor/**"]);
		// Logger should have recorded the config values
		expect(logger.lines.some((l) => l.includes("repo config: model="))).toBe(true);
	});

	it("returns warnings for invalid YAML content", () => {
		tmpDir = makeTmpDir();
		const configDir = join(tmpDir, ".fixbot");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.yml"), ":::bad:::", "utf-8");

		const logger = createCapturingLogger();
		const { config, warnings } = loadRepoConfig(tmpDir, logger);
		expect(config).toEqual({});
		expect(warnings.length).toBeGreaterThan(0);
		expect(logger.lines.some((l) => l.includes("[WARN]"))).toBe(true);
	});

	it("returns empty config when config file is empty", () => {
		tmpDir = makeTmpDir();
		const configDir = join(tmpDir, ".fixbot");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.yml"), "", "utf-8");

		const { config, warnings } = loadRepoConfig(tmpDir);
		expect(config).toEqual({});
		expect(warnings).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// mergeConfigs
// ---------------------------------------------------------------------------

describe("mergeConfigs", () => {
	it("returns empty result when neither repo nor daemon has config", () => {
		const result = mergeConfigs({}, undefined);
		expect(result).toEqual({});
	});

	it("uses daemon model when repo has none", () => {
		const daemonModel: DaemonModelConfig = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
		const logger = createCapturingLogger();
		const result = mergeConfigs({}, daemonModel, logger);
		expect(result.model).toEqual(daemonModel);
		expect(result.modelSource).toBe("daemon");
		expect(logger.lines.some((l) => l.includes("daemon config"))).toBe(true);
	});

	it("uses repo model when daemon has none", () => {
		const repoConfig: RepoConfig = {
			model: { provider: "openai", modelId: "gpt-4o" },
		};
		const logger = createCapturingLogger();
		const result = mergeConfigs(repoConfig, undefined, logger);
		expect(result.model).toEqual({ provider: "openai", modelId: "gpt-4o" });
		expect(result.modelSource).toBe("repo");
		expect(logger.lines.some((l) => l.includes("repo config"))).toBe(true);
	});

	it("repo model overrides daemon model", () => {
		const repoConfig: RepoConfig = {
			model: { provider: "openai", modelId: "gpt-4o" },
		};
		const daemonModel: DaemonModelConfig = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
		const logger = createCapturingLogger();
		const result = mergeConfigs(repoConfig, daemonModel, logger);
		expect(result.model).toEqual({ provider: "openai", modelId: "gpt-4o" });
		expect(result.modelSource).toBe("repo");
		expect(logger.lines.some((l) => l.includes("overrides daemon"))).toBe(true);
	});

	it("passes through excludePaths from repo config", () => {
		const repoConfig: RepoConfig = {
			excludePaths: ["vendor/**", "*.lock"],
		};
		const result = mergeConfigs(repoConfig, undefined);
		expect(result.excludePaths).toEqual(["vendor/**", "*.lock"]);
	});

	it("does not include empty excludePaths", () => {
		const repoConfig: RepoConfig = {
			excludePaths: [],
		};
		const result = mergeConfigs(repoConfig, undefined);
		expect(result.excludePaths).toBeUndefined();
	});

	it("merges model and excludePaths together", () => {
		const repoConfig: RepoConfig = {
			model: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
			excludePaths: ["dist/**"],
		};
		const daemonModel: DaemonModelConfig = { provider: "openai", modelId: "gpt-4o" };
		const result = mergeConfigs(repoConfig, daemonModel);
		expect(result.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
		expect(result.modelSource).toBe("repo");
		expect(result.excludePaths).toEqual(["dist/**"]);
	});
});

// ---------------------------------------------------------------------------
// Integration: end-to-end load + merge
// ---------------------------------------------------------------------------

describe("integration", () => {
	let tmpDir: string;

	function makeTmpDir(): string {
		const dir = join(tmpdir(), `fixbot-repo-config-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	afterEach(() => {
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	it("load + merge: repo model overrides daemon model end-to-end", () => {
		tmpDir = makeTmpDir();
		const configDir = join(tmpDir, ".fixbot");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.yml"),
			'model: openai/gpt-4o\nexcludePaths:\n  - "vendor/**"\n  - "*.lock"\n',
			"utf-8",
		);

		const logger = createCapturingLogger();
		const { config: repoConfig } = loadRepoConfig(tmpDir, logger);
		const daemonModel: DaemonModelConfig = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
		const merged = mergeConfigs(repoConfig, daemonModel, logger);

		expect(merged.model).toEqual({ provider: "openai", modelId: "gpt-4o" });
		expect(merged.modelSource).toBe("repo");
		expect(merged.excludePaths).toEqual(["vendor/**", "*.lock"]);
	});

	it("load + merge: falls back to daemon model when no repo config exists", () => {
		tmpDir = makeTmpDir();
		const logger = createCapturingLogger();
		const { config: repoConfig } = loadRepoConfig(tmpDir, logger);
		const daemonModel: DaemonModelConfig = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
		const merged = mergeConfigs(repoConfig, daemonModel, logger);

		expect(merged.model).toEqual(daemonModel);
		expect(merged.modelSource).toBe("daemon");
		expect(merged.excludePaths).toBeUndefined();
	});
});
