/**
 * Login to an OAuth provider from the CLI.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type LoginCommandArgs, runLoginCommand } from "../cli/login-cli";
import { initTheme } from "../modes/theme/theme";

export default class Login extends Command {
	static description = "Login to an OAuth provider";

	static args = {
		provider: Args.string({
			description: "Provider ID (e.g. anthropic, openai-codex, github-copilot)",
			required: false,
		}),
	};

	static flags = {
		status: Flags.boolean({ description: "Show authentication status for all providers" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Login);
		const cmd: LoginCommandArgs = {
			provider: args.provider,
			flags: {
				status: flags.status,
			},
		};
		await initTheme();
		await runLoginCommand(cmd);
	}
}
