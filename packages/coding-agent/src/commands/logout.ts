/**
 * Logout from an OAuth provider via the CLI.
 */
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { type LogoutCommandArgs, runLogoutCommand } from "../cli/login-cli";
import { initTheme } from "../modes/theme/theme";

export default class Logout extends Command {
	static description = "Logout from an OAuth provider";

	static args = {
		provider: Args.string({
			description: "Provider ID (e.g. anthropic, openai-codex, github-copilot)",
			required: true,
		}),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(Logout);
		const cmd: LogoutCommandArgs = {
			provider: args.provider,
		};
		await initTheme();
		await runLogoutCommand(cmd);
	}
}
