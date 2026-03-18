import { Args, Command } from "@oh-my-pi/pi-utils/cli";

export default class ValidateJob extends Command {
	static description = "Validate a fixbot job spec";

	static args = {
		job: Args.string({
			description: "Path to job spec JSON file",
			required: true,
		}),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(ValidateJob);
		const { parseJobSpecText } = await import("../contracts");
		const { readFileSync } = await import("node:fs");

		const text = readFileSync(args.job, "utf-8");
		const job = parseJobSpecText(text, args.job);
		console.log(`Valid ${job.taskClass} job: ${job.jobId}`);
	}
}
