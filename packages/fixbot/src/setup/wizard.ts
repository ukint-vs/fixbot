/**
 * Guided CLI setup wizard for fixbot daemon.
 *
 * Walks a solo developer through:
 *   1. AI provider authentication (API key → saved to agent.db)
 *   2. GitHub token for repo access + issue polling + PR creation
 *   3. Repository selection (which repos to watch)
 *   4. Daemon config generation
 *   5. Connectivity verification
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AuthCredentialStore } from "@fixbot/pi-ai";
import { getAgentDbPath, getAgentDir } from "@fixbot/pi-utils";
import {
	ask,
	askSecret,
	askWithDefault,
	choose,
	closePrompt,
	confirm,
	heading,
	info,
	step,
	success,
	warn,
} from "./prompt";

// ---------------------------------------------------------------------------
// Provider definitions (subset most useful for solo dev)
// ---------------------------------------------------------------------------

interface ProviderChoice {
	id: string;
	name: string;
	envVar: string;
	keyPrefix?: string;
	keyHint: string;
}

const PROVIDERS: ProviderChoice[] = [
	{
		id: "anthropic",
		name: "Anthropic (Claude)",
		envVar: "ANTHROPIC_API_KEY",
		keyPrefix: "sk-ant-",
		keyHint: "starts with sk-ant-",
	},
	{
		id: "openai",
		name: "OpenAI (GPT-4, o-series)",
		envVar: "OPENAI_API_KEY",
		keyPrefix: "sk-",
		keyHint: "starts with sk-",
	},
	{
		id: "google",
		name: "Google (Gemini)",
		envVar: "GEMINI_API_KEY",
		keyHint: "Gemini API key from ai.google.dev",
	},
	{
		id: "openrouter",
		name: "OpenRouter (multi-provider)",
		envVar: "OPENROUTER_API_KEY",
		keyPrefix: "sk-or-",
		keyHint: "starts with sk-or-",
	},
];

const TOTAL_STEPS = 5;

// ---------------------------------------------------------------------------
// Step 1: AI Provider
// ---------------------------------------------------------------------------

async function setupAiProvider(): Promise<{ provider: string; saved: boolean }> {
	step(1, TOTAL_STEPS, "AI Provider");

	info("fixbot needs an AI model to analyze code and generate fixes.");
	info("You can configure multiple providers later — let's start with one.\n");

	// Check if any env vars are already set
	const envProvider = PROVIDERS.find((p) => process.env[p.envVar]);
	if (envProvider) {
		console.log(`  Found ${envProvider.envVar} in environment.`);
		const useEnv = await confirm(`Use ${envProvider.name} from environment?`);
		if (useEnv) {
			success(`Using ${envProvider.name} from ${envProvider.envVar}`);
			return { provider: envProvider.id, saved: false };
		}
	}

	const provider = await choose("Which AI provider?", PROVIDERS, (p) => p.name);

	// Check env var for chosen provider
	const envKey = process.env[provider.envVar];
	if (envKey) {
		info(`Found ${provider.envVar} in environment — will use that.`);
		const saveToDb = await confirm("Also save this key to fixbot's credential store?");
		if (saveToDb) {
			await saveApiKeyToStore(provider.id, envKey);
			success(`Saved to ${getAgentDbPath()}`);
		}
		return { provider: provider.id, saved: saveToDb };
	}

	console.log(`\n  Get your API key:`);
	if (provider.id === "anthropic") {
		console.log("  https://console.anthropic.com/settings/keys");
	} else if (provider.id === "openai") {
		console.log("  https://platform.openai.com/api-keys");
	} else if (provider.id === "google") {
		console.log("  https://aistudio.google.com/apikey");
	} else if (provider.id === "openrouter") {
		console.log("  https://openrouter.ai/keys");
	}

	const apiKey = await askSecret(`\n  Paste your API key (${provider.keyHint})`);
	if (!apiKey) {
		warn("No API key provided — you can set it later via environment variable.");
		return { provider: provider.id, saved: false };
	}

	await saveApiKeyToStore(provider.id, apiKey);
	success(`Saved ${provider.name} key to ${getAgentDbPath()}`);
	return { provider: provider.id, saved: true };
}

async function saveApiKeyToStore(provider: string, apiKey: string): Promise<void> {
	const dbPath = getAgentDbPath();
	const dir = join(dbPath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const store = await AuthCredentialStore.open(dbPath);
	try {
		store.saveApiKey(provider, apiKey);
	} finally {
		store.close();
	}
}

// ---------------------------------------------------------------------------
// Step 2: GitHub Token
// ---------------------------------------------------------------------------

interface GitHubTokenResult {
	token: string | undefined;
	source: "env" | "input" | "none";
}

async function setupGitHubToken(): Promise<GitHubTokenResult> {
	step(2, TOTAL_STEPS, "GitHub Token");

	info("fixbot needs a GitHub token to:");
	console.log("    - Clone private repositories");
	console.log("    - Poll issues for trigger labels");
	console.log("    - Push branches and open PRs with fixes\n");

	// Check existing env
	const existing = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (existing) {
		const masked = `${existing.slice(0, 6)}..${existing.slice(-4)}`;
		console.log(`  Found token in environment: ${masked}`);
		const useIt = await confirm("Use this token?");
		if (useIt) {
			success("Using GitHub token from environment");
			return { token: existing, source: "env" };
		}
	}

	console.log("  Create a fine-grained personal access token:");
	console.log("  https://github.com/settings/tokens?type=beta");
	console.log("\n  Permissions needed:");
	console.log("    - Contents: Read and write");
	console.log("    - Issues: Read and write");
	console.log("    - Pull requests: Read and write");
	console.log("    - Actions: Read-only (for CI log access)\n");

	const token = await askSecret("  Paste your GitHub token (ghp_ or github_pat_)");
	if (!token) {
		warn("No token provided — daemon GitHub features will be disabled.");
		warn("You can still use 'fixbot run' with public repos.");
		return { token: undefined, source: "none" };
	}

	success("GitHub token received");
	return { token, source: "input" };
}

// ---------------------------------------------------------------------------
// Step 3: Repos
// ---------------------------------------------------------------------------

interface RepoConfig {
	url: string;
	baseBranch: string;
	triggerLabel: string;
}

async function setupRepos(): Promise<RepoConfig[]> {
	step(3, TOTAL_STEPS, "Repositories to Watch");

	info("Which GitHub repos should the daemon monitor for issues?");
	info("Add a trigger label to any issue to queue a fix.\n");

	const repos: RepoConfig[] = [];

	while (true) {
		const repoInput = await ask("  GitHub repo (owner/repo or full URL, blank to finish): ");
		if (!repoInput) break;

		let url: string;
		if (repoInput.startsWith("https://")) {
			url = repoInput.endsWith(".git") ? repoInput : `${repoInput}.git`;
		} else if (repoInput.includes("/")) {
			url = `https://github.com/${repoInput}.git`;
		} else {
			warn("Please use owner/repo format (e.g., myorg/myapp)");
			continue;
		}

		const baseBranch = await askWithDefault("  Base branch", "main");
		const triggerLabel = await askWithDefault("  Trigger label (add to issues to queue fixes)", "fixbot");

		repos.push({ url, baseBranch, triggerLabel });
		success(`Added ${url} (branch: ${baseBranch}, label: ${triggerLabel})`);
		console.log();
	}

	if (repos.length === 0) {
		info("No repos configured — you can add them later in the config file.");
	}

	return repos;
}

// ---------------------------------------------------------------------------
// Step 4: Generate Config
// ---------------------------------------------------------------------------

interface GeneratedConfig {
	configPath: string;
	config: Record<string, unknown>;
}

async function generateDaemonConfig(
	githubToken: string | undefined,
	repos: RepoConfig[],
): Promise<GeneratedConfig> {
	step(4, TOTAL_STEPS, "Generate Daemon Config");

	const defaultDir = join(homedir(), ".fixbot");
	const configDir = await askWithDefault("Config directory", defaultDir);

	const stateDir = join(configDir, "daemon");
	const resultsDir = join(configDir, "results");
	const configPath = join(configDir, "daemon.config.json");

	const config: Record<string, unknown> = {
		version: "fixbot.daemon-config/v1",
		paths: {
			stateDir: resolve(stateDir),
			resultsDir: resolve(resultsDir),
		},
		runtime: {
			heartbeatIntervalMs: 5000,
			idleSleepMs: 1000,
		},
	};

	if (repos.length > 0 || githubToken) {
		const github: Record<string, unknown> = {};
		if (repos.length > 0) {
			github.repos = repos.map((r) => ({
				url: r.url,
				baseBranch: r.baseBranch,
				triggerLabel: r.triggerLabel,
			}));
		} else {
			github.repos = [];
		}
		if (githubToken) {
			github.token = githubToken;
		}
		github.pollIntervalMs = 60_000;
		config.github = github;
	}

	// Write config
	for (const dir of [configDir, stateDir, resultsDir]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
	success(`Config written to ${configPath}`);

	return { configPath, config };
}

// ---------------------------------------------------------------------------
// Step 5: Verify
// ---------------------------------------------------------------------------

async function verify(
	providerResult: { provider: string; saved: boolean },
	githubResult: GitHubTokenResult,
	repos: RepoConfig[],
	configResult: GeneratedConfig,
): Promise<void> {
	step(5, TOTAL_STEPS, "Verify Setup");

	let issues = 0;

	// Check agent.db
	const dbPath = getAgentDbPath();
	if (existsSync(dbPath)) {
		success(`Credential store: ${dbPath}`);
	} else if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) {
		success("API key found in environment");
	} else {
		warn("No credential store and no API key in environment");
		issues++;
	}

	// Check GitHub
	if (githubResult.token) {
		// Quick validation: try GitHub API
		try {
			const resp = await fetch("https://api.github.com/user", {
				headers: {
					Authorization: `Bearer ${githubResult.token}`,
					Accept: "application/vnd.github+json",
					"User-Agent": "fixbot",
				},
			});
			if (resp.ok) {
				const user = (await resp.json()) as { login: string };
				success(`GitHub: authenticated as ${user.login}`);
			} else {
				warn(`GitHub: token returned HTTP ${resp.status} — check permissions`);
				issues++;
			}
		} catch (e) {
			warn(`GitHub: could not reach API — ${e instanceof Error ? e.message : String(e)}`);
			issues++;
		}
	} else {
		warn("GitHub: no token — daemon polling and PR creation disabled");
	}

	// Check config
	if (existsSync(configResult.configPath)) {
		success(`Daemon config: ${configResult.configPath}`);
	} else {
		warn("Daemon config not written");
		issues++;
	}

	// Summary
	heading("Setup Complete");

	if (issues > 0) {
		console.log(`  ${issues} issue(s) found — see warnings above.\n`);
	} else {
		console.log("  Everything looks good!\n");
	}

	console.log("  Next steps:\n");

	console.log("  Run a single job:");
	console.log("    fixbot run job.json\n");

	if (repos.length > 0) {
		console.log("  Start the daemon (foreground):");
		console.log(`    fixbot daemon start --config ${configResult.configPath} --foreground\n`);

		console.log("  Start the daemon (background):");
		console.log(`    fixbot daemon start --config ${configResult.configPath}\n`);

		console.log("  Trigger a fix:");
		console.log(`    Add the "${repos[0].triggerLabel}" label to any issue in ${repos[0].url}\n`);
	} else {
		console.log("  Start the daemon (after adding repos to config):");
		console.log(`    fixbot daemon start --config ${configResult.configPath} --foreground\n`);
	}

	console.log("  Check daemon status:");
	console.log(`    fixbot daemon status --config ${configResult.configPath}\n`);
}

// ---------------------------------------------------------------------------
// Main wizard entry point
// ---------------------------------------------------------------------------

export async function runSetupWizard(): Promise<void> {
	heading("fixbot setup");
	console.log("  Self-hosted coding agent daemon for GitHub repositories.");
	console.log("  This wizard will configure authentication, repos, and daemon settings.\n");

	try {
		const providerResult = await setupAiProvider();
		const githubResult = await setupGitHubToken();
		const repos = await setupRepos();
		const configResult = await generateDaemonConfig(githubResult.token, repos);
		await verify(providerResult, githubResult, repos, configResult);
	} finally {
		closePrompt();
	}
}
