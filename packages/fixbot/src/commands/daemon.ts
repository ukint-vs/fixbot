import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { DEFAULT_DAEMON_CONFIG_PATH } from "../config";

const ACTIONS = ["start", "stop", "status", "health", "enqueue"] as const;
type DaemonAction = (typeof ACTIONS)[number];

export default class Daemon extends Command {
	static description = "Manage the fixbot daemon";

	static args = {
		action: Args.string({
			description: "Daemon action",
			required: true,
			options: [...ACTIONS],
		}),
	};

	static flags = {
		config: Flags.string({ description: "Path to daemon config file", default: DEFAULT_DAEMON_CONFIG_PATH }),
		foreground: Flags.boolean({ description: "Run daemon in foreground (start only)" }),
		job: Flags.string({ description: "Path to job spec JSON file (enqueue only)" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Daemon);
		const action = args.action as DaemonAction;
		const configPath = flags.config;

		switch (action) {
			case "start": {
				const { runDaemonFromConfigFile, startDaemonInBackground } = await import("../daemon/service");
				if (flags.foreground) {
					await runDaemonFromConfigFile(configPath, { logger: (msg) => console.log(msg) });
				} else {
					await startDaemonInBackground(configPath);
				}
				break;
			}
			case "stop": {
				const { stopDaemonFromConfigFile } = await import("../daemon/service");
				await stopDaemonFromConfigFile(configPath);
				break;
			}
			case "status": {
				const { getDaemonStatusFromConfigFile } = await import("../daemon/service");
				const { renderDaemonStatus } = await import("../daemon/status-store");
				const { status, issues } = await getDaemonStatusFromConfigFile(configPath);
				console.log(renderDaemonStatus(status, issues));
				break;
			}
			case "health": {
				const { getDaemonStatusFromConfigFile } = await import("../daemon/service");
				const { status } = await getDaemonStatusFromConfigFile(configPath);
				const isHealthy = status.state === "idle" || status.state === "running";
				console.log(isHealthy ? "healthy" : `unhealthy: ${status.state}`);
				process.exitCode = isHealthy ? 0 : 1;
				break;
			}
			case "enqueue": {
				const jobPath = flags.job;
				if (!jobPath) {
					throw new Error("--job flag is required for enqueue action");
				}
				const { enqueueDaemonJobFromFile, renderDaemonEnqueueSummary } = await import("../daemon/enqueue");
				const result = await enqueueDaemonJobFromFile(configPath, jobPath);
				console.log(renderDaemonEnqueueSummary(result));
				break;
			}
		}
	}
}
