import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDaemonConfig } from "../src/config";
import { getDaemonStatusFromConfigFile, runDaemon } from "../src/daemon/service";
import { readDaemonStatusFile } from "../src/daemon/status-store";

const temporaryDirectories: string[] = [];
const controllers: AbortController[] = [];

afterEach(async () => {
	for (const controller of controllers.splice(0)) {
		controller.abort();
	}
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempConfig(): string {
	const directory = mkdtempSync(join(tmpdir(), "fixbot-health-"));
	temporaryDirectories.push(directory);
	const configPath = join(directory, "daemon.config.json");
	mkdirSync(join(directory, "state"), { recursive: true });
	mkdirSync(join(directory, "results"), { recursive: true });
	writeFileSync(
		configPath,
		`${JSON.stringify(
			{
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./state",
					resultsDir: "./results",
				},
				runtime: {
					heartbeatIntervalMs: 75,
					idleSleepMs: 20,
				},
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	return configPath;
}

async function waitFor<T>(
	callback: () => T | Promise<T>,
	predicate: (value: T) => boolean,
	timeoutMs: number,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastValue = await callback();
	while (Date.now() < deadline) {
		if (predicate(lastValue)) {
			return lastValue;
		}
		await new Promise(resolve => setTimeout(resolve, 25));
		lastValue = await callback();
	}
	return lastValue;
}

describe("daemon health", () => {
	it("exits 1 when daemon is not running", async () => {
		const configPath = createTempConfig();
		const { status } = await getDaemonStatusFromConfigFile(configPath);
		const alive = status.state === "idle" || status.state === "running";
		expect(alive).toBe(false);
	});

	it("exits 0 when daemon is alive", async () => {
		const configPath = createTempConfig();
		const config = loadDaemonConfig(configPath);

		const controller = new AbortController();
		controllers.push(controller);

		const daemonPromise = runDaemon(config, {
			signal: controller.signal,
			installSignalHandlers: false,
		});

		// Wait for the daemon to reach idle state
		const idleStatus = await waitFor(
			() => readDaemonStatusFile(config),
			status => status?.state === "idle" && status.pid === process.pid,
			5_000,
		);
		expect(idleStatus?.state).toBe("idle");

		// Verify health check would report alive
		const { status } = await getDaemonStatusFromConfigFile(configPath);
		const alive = status.state === "idle" || status.state === "running";
		expect(alive).toBe(true);

		controller.abort();
		await daemonPromise;
	});
});
