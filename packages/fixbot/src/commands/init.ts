import { Command } from "@fixbot/pi-utils/cli";

export default class Init extends Command {
	static description = "Interactive setup wizard for fixbot daemon";

	async run(): Promise<void> {
		const { runSetupWizard } = await import("../setup/wizard");
		await runSetupWizard();
	}
}
