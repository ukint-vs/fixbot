/**
 * Login/logout CLI command handlers.
 *
 * Handles `fixbot login [provider]` and `fixbot logout <provider>` for
 * managing OAuth provider authentication from the terminal.
 */
import * as readline from "node:readline";
import { getOAuthProviders, type OAuthProviderId, type OAuthProviderInfo } from "@oh-my-pi/pi-ai";
import { APP_NAME, getAgentDbPath } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import { discoverAuthStorage } from "../sdk";
import { openPath } from "../utils/open";

// =============================================================================
// Types
// =============================================================================

export interface LoginCommandArgs {
	provider?: string;
	flags: {
		status?: boolean;
	};
}

export interface LogoutCommandArgs {
	provider?: string;
}

// =============================================================================
// Readline Helpers
// =============================================================================

function createReadlineInterface(): readline.Interface {
	return readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
}

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
	return new Promise((resolve, reject) => {
		rl.question(question, answer => {
			resolve(answer.trim());
		});
		rl.once("close", () => {
			reject(new Error("Input closed"));
		});
	});
}

// =============================================================================
// Provider Picker
// =============================================================================

async function pickProvider(): Promise<string | undefined> {
	const providers = getOAuthProviders();
	if (providers.length === 0) {
		console.error(chalk.red("No OAuth providers available."));
		return undefined;
	}

	console.log(chalk.bold("\nAvailable providers:\n"));
	for (let i = 0; i < providers.length; i++) {
		console.log(`  ${chalk.cyan(String(i + 1).padStart(2, " "))}. ${providers[i].name}`);
	}
	console.log("");

	const rl = createReadlineInterface();
	try {
		const answer = await askQuestion(rl, `Select provider [1-${providers.length}]: `);
		const index = Number.parseInt(answer, 10) - 1;
		if (Number.isNaN(index) || index < 0 || index >= providers.length) {
			console.error(chalk.red(`Invalid selection: ${answer}`));
			return undefined;
		}
		return providers[index].id;
	} catch {
		// readline closed (Ctrl+D)
		return undefined;
	} finally {
		rl.close();
	}
}

// =============================================================================
// Provider Validation
// =============================================================================

function resolveProvider(providerId: string): OAuthProviderInfo {
	const providers = getOAuthProviders();
	const providerInfo = providers.find(p => p.id === providerId);
	if (!providerInfo) {
		console.error(chalk.red(`Unknown provider: ${providerId}`));
		console.error(chalk.dim(`Run '${APP_NAME} login --status' to see available providers`));
		process.exit(1);
	}
	return providerInfo;
}

// =============================================================================
// Login Command
// =============================================================================

export async function runLoginCommand(args: LoginCommandArgs): Promise<void> {
	let authStorage: Awaited<ReturnType<typeof discoverAuthStorage>> | undefined;
	try {
		authStorage = await discoverAuthStorage();
	} catch (error) {
		console.error(
			chalk.red(`Failed to open credentials database: ${error instanceof Error ? error.message : String(error)}`),
		);
		process.exit(1);
	}

	// --status flag: show credential status table
	if (args.flags.status) {
		await showAuthStatus(authStorage);
		return;
	}

	// Resolve provider
	let providerId = args.provider;
	if (!providerId) {
		providerId = await pickProvider();
		if (!providerId) {
			return;
		}
	}

	const providerInfo = resolveProvider(providerId);

	// Check if already logged in
	if (authStorage.has(providerId)) {
		console.log(chalk.yellow(`Already logged in to ${providerInfo.name}. Re-authenticating...`));
	}

	// Run OAuth flow with terminal callbacks
	const rl = createReadlineInterface();
	try {
		await authStorage.login(providerId as OAuthProviderId, {
			onAuth: (info: { url: string; instructions?: string }) => {
				console.log(chalk.dim(`\nURL: ${info.url}`));
				if (info.instructions) {
					console.log(chalk.yellow(info.instructions));
				}
				openPath(info.url);
			},
			onPrompt: async (prompt: { message: string; placeholder?: string }) => {
				const question = prompt.placeholder ? `${prompt.message} (${prompt.placeholder}): ` : `${prompt.message}: `;
				return askQuestion(rl, question);
			},
			onProgress: (message: string) => {
				console.log(chalk.dim(message));
			},
			onManualCodeInput: async () => {
				return askQuestion(rl, "Paste the authorization code (or full redirect URL): ");
			},
		});

		console.log(chalk.green(`\n${theme.status.success} Successfully logged in to ${providerInfo.name}`));
		console.log(chalk.dim(`Credentials saved to ${getAgentDbPath()}`));
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			// User cancelled — exit cleanly
			return;
		}
		console.error(chalk.red(`\nLogin failed: ${error instanceof Error ? error.message : String(error)}`));
		process.exit(1);
	} finally {
		rl.close();
	}
}

// =============================================================================
// Logout Command
// =============================================================================

export async function runLogoutCommand(args: LogoutCommandArgs): Promise<void> {
	if (!args.provider) {
		console.error(chalk.red(`Usage: ${APP_NAME} logout <provider>`));
		console.error(chalk.dim(`Run '${APP_NAME} login --status' to see logged-in providers`));
		process.exit(1);
	}

	let authStorage: Awaited<ReturnType<typeof discoverAuthStorage>> | undefined;
	try {
		authStorage = await discoverAuthStorage();
	} catch (error) {
		console.error(
			chalk.red(`Failed to open credentials database: ${error instanceof Error ? error.message : String(error)}`),
		);
		process.exit(1);
	}

	const providerId = args.provider;
	const providerInfo = resolveProvider(providerId);

	// Check if logged in
	if (!authStorage.has(providerId)) {
		console.log(chalk.dim(`Not logged in to ${providerInfo.name}`));
		return;
	}

	await authStorage.logout(providerId);
	console.log(chalk.green(`${theme.status.success} Successfully logged out of ${providerInfo.name}`));
}

// =============================================================================
// Auth Status
// =============================================================================

async function showAuthStatus(authStorage: Awaited<ReturnType<typeof discoverAuthStorage>>): Promise<void> {
	const providers = getOAuthProviders();

	console.log(chalk.bold("\nProvider authentication status:\n"));

	for (const provider of providers) {
		const hasCredential = authStorage.has(provider.id);
		if (hasCredential) {
			const oauthCred = authStorage.getOAuthCredential(provider.id);
			let expiryInfo = "";
			if (oauthCred?.expires) {
				const remaining = oauthCred.expires - Date.now();
				if (remaining > 0) {
					const hours = Math.floor(remaining / (1000 * 60 * 60));
					const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
					expiryInfo = hours > 0 ? ` (expires in ${hours}h ${minutes}m)` : ` (expires in ${minutes}m)`;
				} else {
					expiryInfo = " (expired)";
				}
			}
			console.log(`  ${chalk.green(theme.status.success)} ${provider.name}${chalk.dim(expiryInfo)}`);
		} else {
			console.log(`  ${chalk.dim(theme.status.error)} ${chalk.dim(provider.name)}`);
		}
	}
	console.log("");
}
