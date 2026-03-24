import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { DEFAULT_DAEMON_CONFIG_PATH } from "../config";

export default class Status extends Command {
	static description = "Show fixbot daemon status dashboard";

	static flags = {
		config: Flags.string({
			description: "Path to daemon config file",
			default: DEFAULT_DAEMON_CONFIG_PATH,
		}),
		json: Flags.boolean({
			description: "Output raw JSON status",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Status);
		const configPath = flags.config;

		let status: import("../types").DaemonStatusV1;
		let issues: string[];

		try {
			const { getDaemonStatusFromConfigFile } = await import("../daemon/service");
			const result = await getDaemonStatusFromConfigFile(configPath);
			status = result.status;
			issues = result.issues;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`error: fixbot daemon is not running — ${message}\n`);
			process.exitCode = 1;
			return;
		}

		if (flags.json) {
			process.stdout.write(JSON.stringify({ status, issues }, null, 2) + "\n");
			return;
		}

		const { createDaemonStatusSnapshot } = await import("../daemon/status-store");
		const { formatStatusDashboard } = await import("../daemon/status-formatter");
		const snapshot = createDaemonStatusSnapshot(status);
		process.stdout.write(formatStatusDashboard(snapshot, issues));
	}
}
