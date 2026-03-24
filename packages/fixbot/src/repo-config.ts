import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Logger } from "./logger";
import type { DaemonModelConfig, RepoConfig, RepoModelConfig } from "./types";

/** Path within a repo checkout where the per-repo config lives. */
export const REPO_CONFIG_PATH = ".fixbot/config.yml";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a "provider/modelId" string into a {@link RepoModelConfig}.
 * Returns `undefined` if the format is invalid.
 */
export function parseModelString(raw: unknown): RepoModelConfig | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return undefined;
	return {
		provider: trimmed.slice(0, slashIndex),
		modelId: trimmed.slice(slashIndex + 1),
	};
}

/**
 * Parse raw YAML text into a validated {@link RepoConfig}.
 *
 * - Unknown top-level keys produce warnings but don't fail.
 * - Invalid `model` or `excludePaths` values produce warnings and are dropped.
 * - Returns `{ config, warnings }`.
 */
export function parseRepoConfig(yamlText: string): { config: RepoConfig; warnings: string[] } {
	const warnings: string[] = [];
	const config: RepoConfig = {};

	let raw: unknown;
	try {
		raw = parseYaml(yamlText);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		warnings.push(`Invalid YAML: ${msg}`);
		return { config, warnings };
	}

	if (raw === null || raw === undefined) {
		return { config, warnings };
	}

	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("Config must be a YAML mapping (object), got " + (Array.isArray(raw) ? "array" : typeof raw));
		return { config, warnings };
	}

	const record = raw as Record<string, unknown>;
	const knownKeys = new Set(["model", "excludePaths"]);

	for (const key of Object.keys(record)) {
		if (!knownKeys.has(key)) {
			warnings.push(`Unknown config key "${key}" — ignoring`);
		}
	}

	// model
	if ("model" in record && record.model !== undefined && record.model !== null) {
		const parsed = parseModelString(record.model);
		if (parsed) {
			config.model = parsed;
		} else {
			warnings.push(
				`Invalid model value "${String(record.model)}" — expected "provider/modelId" format (e.g. "anthropic/claude-sonnet-4-6")`,
			);
		}
	}

	// excludePaths
	if ("excludePaths" in record && record.excludePaths !== undefined && record.excludePaths !== null) {
		if (Array.isArray(record.excludePaths)) {
			const valid: string[] = [];
			for (const item of record.excludePaths) {
				if (typeof item === "string" && item.trim() !== "") {
					valid.push(item.trim());
				} else {
					warnings.push(`Invalid excludePaths entry ${JSON.stringify(item)} — must be a non-empty string`);
				}
			}
			if (valid.length > 0) {
				config.excludePaths = valid;
			}
		} else {
			warnings.push("excludePaths must be an array of glob strings");
		}
	}

	return { config, warnings };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load and parse `.fixbot/config.yml` from a workspace directory.
 *
 * - If the file doesn't exist, returns an empty config with no warnings.
 * - If the file can't be read or parsed, returns an empty config with warnings.
 * - Never throws.
 */
export function loadRepoConfig(
	workspaceDir: string,
	logger?: Logger,
): { config: RepoConfig; warnings: string[] } {
	const configPath = join(workspaceDir, REPO_CONFIG_PATH);

	if (!existsSync(configPath)) {
		return { config: {}, warnings: [] };
	}

	let yamlText: string;
	try {
		yamlText = readFileSync(configPath, "utf-8");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const warning = `Failed to read ${REPO_CONFIG_PATH}: ${msg}`;
		logger?.warn(warning);
		return { config: {}, warnings: [warning] };
	}

	const result = parseRepoConfig(yamlText);

	for (const w of result.warnings) {
		logger?.warn(`${REPO_CONFIG_PATH}: ${w}`);
	}

	if (result.config.model) {
		logger?.info(
			`repo config: model=${result.config.model.provider}/${result.config.model.modelId}`,
		);
	}
	if (result.config.excludePaths && result.config.excludePaths.length > 0) {
		logger?.info(`repo config: excludePaths=[${result.config.excludePaths.join(", ")}]`);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export interface MergedConfig {
	/** The resolved model config — repo wins over daemon. */
	model?: DaemonModelConfig;
	/** Source of the model: "repo", "daemon", or undefined if no model set. */
	modelSource?: "repo" | "daemon";
	/** Merged excludePaths from repo config (daemon has no equivalent). */
	excludePaths?: string[];
}

/**
 * Merge per-repo config with daemon-level config.
 *
 * Priority: repo config wins over daemon config for overlapping fields.
 * Logs which values came from which source.
 */
export function mergeConfigs(
	repoConfig: RepoConfig,
	daemonModel: DaemonModelConfig | undefined,
	logger?: Logger,
): MergedConfig {
	const result: MergedConfig = {};

	if (repoConfig.model) {
		result.model = {
			provider: repoConfig.model.provider,
			modelId: repoConfig.model.modelId,
		};
		result.modelSource = "repo";
		if (daemonModel) {
			logger?.info(
				`model from repo config (${repoConfig.model.provider}/${repoConfig.model.modelId}) overrides daemon config (${daemonModel.provider}/${daemonModel.modelId})`,
			);
		} else {
			logger?.info(
				`model from repo config: ${repoConfig.model.provider}/${repoConfig.model.modelId}`,
			);
		}
	} else if (daemonModel) {
		result.model = daemonModel;
		result.modelSource = "daemon";
		logger?.info(`model from daemon config: ${daemonModel.provider}/${daemonModel.modelId}`);
	}

	if (repoConfig.excludePaths && repoConfig.excludePaths.length > 0) {
		result.excludePaths = repoConfig.excludePaths;
	}

	return result;
}
