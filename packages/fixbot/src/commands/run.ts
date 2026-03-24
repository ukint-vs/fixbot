import { Args, Command } from "@oh-my-pi/pi-utils/cli";

export default class Run extends Command {
	static description = "Run a single fixbot job";

	static args = {
		job: Args.string({
			description: "Path to job spec JSON file",
			required: true,
		}),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(Run);
		const { parseJobSpecText } = await import("../contracts");
		const { runJob } = await import("../runner");
		const { readFileSync } = await import("node:fs");

		const text = readFileSync(args.job!, "utf-8");
		const job = parseJobSpecText(text, args.job!);
		const result = await runJob(job);

		console.log(JSON.stringify(result, null, 2));
		process.exitCode = result.status === "success" ? 0 : 1;
	}
}
