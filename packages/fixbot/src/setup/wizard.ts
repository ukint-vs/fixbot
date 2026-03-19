/**
 * Guided CLI setup wizard for fixbot daemon.
 *
 * Walks a solo developer through:
 *   1. AI provider authentication (OAuth or API key → saved to agent.db)
 *   2. GitHub token for repo access + issue polling + PR creation
 *   3. Repository selection (which repos to watch)
 *   4. Daemon config generation
 *   5. Connectivity verification
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AuthCredentialStore, getOAuthProviders, type OAuthProviderId } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
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
// Provider definitions for API key auth (subset most useful for solo dev)
// ---------------------------------------------------------------------------

interface ApiKeyProviderChoice {
	id: string;
	name: string;
	envVar: string;
	keyPrefix?: string;
	keyHint: string;
	dashboardUrl: string;
}

const API_KEY_PROVIDERS: ApiKeyProviderChoice[] = [
	{
		id: "anthropic",
		name: "Anthropic (Claude)",
		envVar: "ANTHROPIC_API_KEY",
		keyPrefix: "sk-ant-",
		keyHint: "starts with sk-ant-",
		dashboardUrl: "https://console.anthropic.com/settings/keys",
	},
	{
		id: "openai",
		name: "OpenAI (GPT-4, o-series)",
		envVar: "OPENAI_API_KEY",
		keyPrefix: "sk-",
		keyHint: "starts with sk-",
		dashboardUrl: "https://platform.openai.com/api-keys",
	},
	{
		id: "google",
		name: "Google (Gemini)",
		envVar: "GEMINI_API_KEY",
		keyHint: "Gemini API key from ai.google.dev",
		dashboardUrl: "https://aistudio.google.com/apikey",
	},
	{
		id: "openrouter",
		name: "OpenRouter (multi-provider)",
		envVar: "OPENROUTER_API_KEY",
		keyPrefix: "sk-or-",
		keyHint: "starts with sk-or-",
		dashboardUrl: "https://openrouter.ai/keys",
	},
];

// Top OAuth providers to highlight (most commonly used for coding agents)
const FEATURED_OAUTH_PROVIDERS = [
	"anthropic",
	"github-copilot",
	"openai-codex",
	"google-gemini-cli",
	"cursor",
];

const TOTAL_STEPS = 5;

// No separate readline — all prompts go through the shared prompt.ts interface
// to avoid stdin conflicts between competing readline instances.

// ---------------------------------------------------------------------------
// Step 1: AI Provider
// ---------------------------------------------------------------------------

async function setupAiProvider(): Promise<{ provider: string; saved: boolean }> {
	step(1, TOTAL_STEPS, "AI Provider");

	info("fixbot needs an AI model to analyze code and generate fixes.");
	info("You can configure multiple providers later — let's start with one.\n");

	// Check if any API key env vars are already set
	const envProvider = API_KEY_PROVIDERS.find((p) => process.env[p.envVar]);
	if (envProvider) {
		console.log(`  Found ${envProvider.envVar} in environment.`);
		const useEnv = await confirm(`Use ${envProvider.name} from environment?`);
		if (useEnv) {
			success(`Using ${envProvider.name} from ${envProvider.envVar}`);
			return { provider: envProvider.id, saved: false };
		}
	}

	// Choose auth method
	const authMethods = [
		{ id: "oauth", name: "OAuth login (Claude Pro/Max, Copilot, Cursor, etc.)" },
		{ id: "api-key", name: "API key (Anthropic, OpenAI, Google, OpenRouter)" },
		{ id: "skip", name: "Skip — set up later with 'fixbot login' or env vars" },
	];

	const method = await choose("How would you like to authenticate?", authMethods, (m) => m.name);

	if (method.id === "skip") {
		warn("Skipped — run 'fixbot login <provider>' or set an API key env var before starting the daemon.");
		return { provider: "none", saved: false };
	}

	if (method.id === "oauth") {
		return setupOAuth();
	}

	return setupApiKey();
}

async function setupOAuth(): Promise<{ provider: string; saved: boolean }> {
	const allProviders = getOAuthProviders();

	// Build list: featured providers first, then "More providers..." option
	const featured = FEATURED_OAUTH_PROVIDERS
		.map((id) => allProviders.find((p) => p.id === id))
		.filter((p): p is NonNullable<typeof p> => p != null);

	const choices = [
		...featured.map((p) => ({ id: p.id, name: p.name })),
		{ id: "__more__", name: `All providers (${allProviders.length} available)` },
	];

	let providerId: string;
	const picked = await choose("Which provider?", choices, (c) => c.name);

	if (picked.id === "__more__") {
		// Show full list
		console.log("\n  Available OAuth providers:\n");
		for (let i = 0; i < allProviders.length; i++) {
			console.log(`  ${String(i + 1).padStart(3, " ")}. ${allProviders[i].name}`);
		}
		console.log();

		const answer = await ask(`  Select provider [1-${allProviders.length}]: `);
		const index = Number.parseInt(answer, 10) - 1;
		if (Number.isNaN(index) || index < 0 || index >= allProviders.length) {
			warn(`Invalid selection: ${answer}`);
			return { provider: "none", saved: false };
		}
		providerId = allProviders[index].id;
	} else {
		providerId = picked.id;
	}

	const providerInfo = allProviders.find((p) => p.id === providerId);
	if (!providerInfo) {
		warn("Provider not found");
		return { provider: "none", saved: false };
	}

	// Run OAuth flow
	info(`Opening browser for ${providerInfo.name} authentication...`);

	let authStorage;
	try {
		authStorage = await discoverAuthStorage();
	} catch (error) {
		warn(`Failed to open credentials database: ${error instanceof Error ? error.message : String(error)}`);
		return { provider: providerId, saved: false };
	}

	try {
		await authStorage.login(providerId as OAuthProviderId, {
			onAuth: (authInfo: { url: string; instructions?: string }) => {
				console.log(`\n  Open this URL in your browser:`);
				console.log(`  ${authInfo.url}\n`);
				if (authInfo.instructions) {
					console.log(`  ${authInfo.instructions}`);
				}
				// Try to open browser automatically
				try {
					const cmd =
						process.platform === "darwin"
							? ["open", authInfo.url]
							: process.platform === "win32"
								? ["rundll32", "url.dll,FileProtocolHandler", authInfo.url]
								: ["xdg-open", authInfo.url];
					Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
				} catch {
					// Best-effort
				}
			},
			onPrompt: async (prompt: { message: string; placeholder?: string }) => {
				const question = prompt.placeholder
					? `  ${prompt.message} (${prompt.placeholder})`
					: `  ${prompt.message}`;
				return ask(`${question}: `);
			},
			onProgress: (message: string) => {
				console.log(`  ${message}`);
			},
			onManualCodeInput: async () => {
				return ask("  Paste the authorization code (or full redirect URL): ");
			},
		});

		success(`Logged in to ${providerInfo.name}`);
		console.log(`  Credentials saved to ${getAgentDbPath()}\n`);
		return { provider: providerId, saved: true };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			warn("Login cancelled");
			return { provider: providerId, saved: false };
		}
		warn(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
		info("You can try again later with 'fixbot login'");
		return { provider: providerId, saved: false };
	}
}

async function setupApiKey(): Promise<{ provider: string; saved: boolean }> {
	const provider = await choose("Which AI provider?", API_KEY_PROVIDERS, (p) => p.name);

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
	console.log(`  ${provider.dashboardUrl}`);

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

	if (providerResult.provider === "none") {
		console.log("  Authenticate with an AI provider:");
		console.log("    fixbot login\n");
	}

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

	console.log("  Manage providers:");
	console.log("    fixbot login              # add another provider");
	console.log("    fixbot login --status     # see all provider status");
	console.log("    fixbot logout <provider>  # remove a provider\n");
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
