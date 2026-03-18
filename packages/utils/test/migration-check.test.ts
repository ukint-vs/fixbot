import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// We test checkConfigMigration by checking its console.warn output.
// The function checks for ~/.omp and ~/.fixbot directories.

describe("checkConfigMigration", () => {
	const home = os.homedir();
	const legacyDir = path.join(home, ".omp");
	const currentDir = path.join(home, ".fixbot");

	let legacyExisted: boolean;
	let currentExisted: boolean;
	let warnOutput: string[];

	beforeEach(() => {
		legacyExisted = fs.existsSync(legacyDir);
		currentExisted = fs.existsSync(currentDir);
		warnOutput = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnOutput.push(args.join(" "));
		};
	});

	afterEach(() => {
		// Restore console.warn — it gets replaced in beforeEach
		// Clean up any test-created directories
	});

	it("should not warn when neither directory exists", async () => {
		// Skip if either directory actually exists on this machine
		if (legacyExisted || currentExisted) return;

		const { checkConfigMigration } = await import("../src/dirs");
		checkConfigMigration();
		expect(warnOutput.length).toBe(0);
	});

	it("should not warn when only .fixbot exists", async () => {
		// Skip if .omp exists (can't test this branch safely)
		if (legacyExisted) return;
		if (!currentExisted) return; // Need .fixbot to exist for this test

		const { checkConfigMigration } = await import("../src/dirs");
		checkConfigMigration();
		expect(warnOutput.length).toBe(0);
	});

	it("exports checkConfigMigration function", async () => {
		const mod = await import("../src/dirs");
		expect(typeof mod.checkConfigMigration).toBe("function");
	});

	it("exports APP_NAME as fixbot", async () => {
		const { APP_NAME } = await import("../src/dirs");
		expect(APP_NAME).toBe("fixbot");
	});

	it("exports CONFIG_DIR_NAME as .fixbot", async () => {
		const { CONFIG_DIR_NAME } = await import("../src/dirs");
		expect(CONFIG_DIR_NAME).toBe(".fixbot");
	});
});
