import { Command, Flags } from "@oh-my-pi/pi-utils/cli";

/**
 * Internal command invoked by the daemon to execute a prepared job in a child process.
 * Not intended for direct user invocation.
 */
export default class InternalRun extends Command {
	static description = "Execute a prepared fixbot job (internal, used by daemon)";
	static hidden = true;

	static flags = {
		execution: Flags.string({
			description: "Path to execution-plan.json",
			required: true,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(InternalRun);
		const { executeFromPlan } = await import("../internal-runner");
		await executeFromPlan(flags.execution);
	}
}
