import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_PER_PROVIDER, type Api, type KnownProvider, type Model } from "@oh-my-pi/pi-ai";
import { type AuthStorage, discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { getAgentDbPath, getAgentDir } from "@oh-my-pi/pi-utils";
import type { DaemonModelConfig, ModelOverride, ModelSelection, NormalizedJobSpecV1 } from "./types";

export interface HostAgentConfig {
	hostAgentDir: string;
	hostAgentDirExists: boolean;
	authFilePath: string;
	authFileExists: boolean;
}

export interface ResolveExecutionModelOptions {
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	/** Model override from daemon config — takes precedence over provider defaults. */
	configModel?: DaemonModelConfig;
}

function isExistingDirectory(path: string): boolean {
	if (!existsSync(path)) {
		return false;
	}
	return statSync(path).isDirectory();
}

export function resolveHostAgentConfig(): HostAgentConfig {
	const hostAgentDir = process.env.FIXBOT_AGENT_DIR?.trim() || getAgentDir();
	if (process.env.FIXBOT_AGENT_DIR?.trim() && !isExistingDirectory(hostAgentDir)) {
		throw new Error(`Configured FIXBOT_AGENT_DIR does not exist: ${hostAgentDir}`);
	}

	const authFilePath = getAgentDbPath();
	return {
		hostAgentDir,
		hostAgentDirExists: isExistingDirectory(hostAgentDir),
		authFilePath,
		authFileExists: existsSync(authFilePath),
	};
}

export function buildMissingModelError(): Error {
	return new Error(
		[
			"No authenticated models are available for this fixbot run.",
			"",
			"Set up fixbot first:",
			"1. Run `fixbot`",
			"2. Run `/login`",
			"3. Run `/model`",
			"",
			"Or set provider API key environment variables before running fixbot.",
		].join("\n"),
	);
}

export async function resolveExecutionModel(
	job: NormalizedJobSpecV1,
	options: ResolveExecutionModelOptions = {},
): Promise<Model<Api>> {
	const authStorage = options.authStorage ?? (await discoverAuthStorage());
	const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
	await modelRegistry.refresh();

	// If job specifies a model override, find and validate it
	if (job.execution.model) {
		const override = job.execution.model;
		const model = modelRegistry.getAvailable().find(
			(m) => m.provider === override.provider && m.id === override.modelId,
		);
		if (!model) {
			throw new Error(
				`Requested model ${override.provider}/${override.modelId} is not available. Run 'fixbot auth' to configure API keys.`,
			);
		}
		return model as Model<Api>;
	}

	// Priority: job override (above) → config model → provider default → first available
	const available = modelRegistry.getAvailable();

	// Config-level model override from daemon.config.json
	if (options.configModel) {
		const cm = options.configModel;
		const configMatch = available.find(
			(m) => m.provider === cm.provider && m.id === cm.modelId,
		);
		if (configMatch) {
			return configMatch as Model<Api>;
		}
		// Warn but don't throw — fall through to provider default
		console.warn(
			`[fixbot] config model ${cm.provider}/${cm.modelId} not available, falling back to provider default`,
		);
	}

	// Prefer a provider's known-good default, iterating by provider priority
	// (same order as coding-agent's model-resolver) rather than models.json insertion order
	const selected = (Object.keys(DEFAULT_MODEL_PER_PROVIDER) as KnownProvider[]).reduce<Model<Api> | undefined>(
		(found, provider) => {
			if (found) return found;
			const defaultId = DEFAULT_MODEL_PER_PROVIDER[provider];
			return available.find((m) => m.provider === provider && m.id === defaultId);
		},
		undefined,
	) ?? available[0];
	if (!selected) {
		throw buildMissingModelError();
	}
	return selected as Model<Api>;
}

export async function resolvePlannedModel(
	selectedModel: ModelSelection,
	options: ResolveExecutionModelOptions = {},
): Promise<Model<Api>> {
	const authStorage = options.authStorage ?? (await discoverAuthStorage());
	const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
	await modelRegistry.refresh();

	const model = modelRegistry.getAvailable().find(
		(m) => m.provider === selectedModel.provider && m.id === selectedModel.modelId,
	);
	if (!model) {
		throw new Error(
			`Selected model ${selectedModel.provider}/${selectedModel.modelId} is not available. Run 'fixbot auth' to configure API keys.`,
		);
	}
	return model as Model<Api>;
}
