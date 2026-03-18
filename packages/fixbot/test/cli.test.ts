import { describe, expect, it } from "bun:test";
import { getHelpText, parseArgs } from "../src/cli-args";

describe("cli args", () => {
	it("parses image build as a public command", () => {
		expect(parseArgs(["image", "build"])).toEqual({
			command: "image-build",
		});
	});

	it("parses run arguments", () => {
		expect(parseArgs(["run", "--job", "job.json"])).toEqual({
			command: "run",
			jobFile: "job.json",
		});
	});

	it("parses daemon lifecycle commands", () => {
		expect(parseArgs(["daemon", "start", "--config", "daemon.json", "--foreground"])).toEqual({
			command: "daemon-start",
			configFile: "daemon.json",
			foreground: true,
		});
		expect(parseArgs(["daemon", "enqueue", "--config", "daemon.json", "--job", "job.json"])).toEqual({
			command: "daemon-enqueue",
			configFile: "daemon.json",
			jobFile: "job.json",
		});
		expect(parseArgs(["daemon", "status", "--config", "daemon.json"])).toEqual({
			command: "daemon-status",
			configFile: "daemon.json",
		});
		expect(parseArgs(["daemon", "stop", "--config", "daemon.json"])).toEqual({
			command: "daemon-stop",
			configFile: "daemon.json",
		});
		expect(parseArgs(["daemon", "health", "--config", "daemon.json"])).toEqual({
			command: "daemon-health",
			configFile: "daemon.json",
		});
	});

	it("prints help text with the daemon commands", () => {
		const helpText = getHelpText();
		expect(helpText).toContain("fixbot image build");
		expect(helpText).toContain("fixbot daemon start --config <file> [--foreground]");
		expect(helpText).toContain("fixbot daemon enqueue --config <file> --job <file>");
		expect(helpText).toContain("fixbot daemon status --config <file>");
		expect(helpText).toContain("fixbot daemon stop --config <file>");
		expect(helpText).toContain("fixbot daemon health --config <file>");
	});
});
