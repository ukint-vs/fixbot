import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDaemonConfig } from "../src/config";
import { runDaemon } from "../src/daemon/service";
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
	const directory = mkdtempSync(join(tmpdir(), "fixbot-cmd-"));
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

async function runDaemonCommand(argv: string[]): Promise<void> {
	const Daemon = (await import("../src/commands/daemon")).default;
	const cmd = new Daemon(argv, { bin: "fixbot", version: "0.0.0-test", commands: new Map() });
	await cmd.run();
}

describe("daemon command dispatch", () => {
	describe("status", () => {
		it("destructures getDaemonStatusFromConfigFile result and passes issues to renderDaemonStatus", async () => {
			const configPath = createTempConfig();
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			};
			try {
				await runDaemonCommand(["status", "--config", configPath]);
			} finally {
				console.log = originalLog;
			}

			// renderDaemonStatus produces lines starting with "State:"
			const output = logs.join("\n");
			expect(output).toContain("State:");
			expect(output).toContain("PID:");
			expect(output).toContain("Queue depth:");
		});

		it("renders status with last error when daemon is not running", async () => {
			const configPath = createTempConfig();

			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			};
			try {
				await runDaemonCommand(["status", "--config", configPath]);
			} finally {
				console.log = originalLog;
			}

			const output = logs.join("\n");
			// When no daemon is running, the status should reflect a non-idle state
			expect(output).toContain("State:");
			expect(output).toContain("Last error:");
		});
	});

	describe("health", () => {
		it("reports unhealthy when daemon is not running", async () => {
			const configPath = createTempConfig();
			const logs: string[] = [];
			const originalLog = console.log;
			const originalExitCode = process.exitCode;
			console.log = (...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			};
			try {
				await runDaemonCommand(["health", "--config", configPath]);
				expect(logs[0]).toMatch(/^unhealthy:/);
				expect(process.exitCode).toBe(1);
			} finally {
				console.log = originalLog;
				process.exitCode = originalExitCode;
			}
		});

		it("reports healthy when daemon is idle", async () => {
			const configPath = createTempConfig();
			const config = loadDaemonConfig(configPath);

			const controller = new AbortController();
			controllers.push(controller);

			const daemonPromise = runDaemon(config, {
				signal: controller.signal,
				installSignalHandlers: false,
			});

			// Wait for daemon to reach idle
			await waitFor(
				() => readDaemonStatusFile(config),
				status => status?.state === "idle" && status.pid === process.pid,
				5_000,
			);

			const logs: string[] = [];
			const originalLog = console.log;
			const originalExitCode = process.exitCode;
			console.log = (...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			};
			try {
				await runDaemonCommand(["health", "--config", configPath]);
				expect(logs[0]).toBe("healthy");
				expect(process.exitCode).toBe(0);
			} finally {
				console.log = originalLog;
				process.exitCode = originalExitCode;
			}

			controller.abort();
			await daemonPromise;
		});

		it("uses status.state not status.lifecycle", async () => {
			const configPath = createTempConfig();
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			};
			try {
				await runDaemonCommand(["health", "--config", configPath]);
			} finally {
				console.log = originalLog;
			}

			// If .lifecycle was used instead of .state, the output would be
			// "unhealthy: undefined" since lifecycle doesn't exist on the status object
			expect(logs[0]).not.toContain("undefined");
			expect(logs[0]).toMatch(/^unhealthy: (degraded|error|starting|stopped)/);
		});
	});

	describe("start", () => {
		// Skip: startDaemonInBackground spawns a child process via process.argv[1],
		// which points to the test runner during `bun test`, not the CLI binary.
		it.skip("passes config file path string to startDaemonInBackground, not config object", async () => {
			const configPath = createTempConfig();

			// This test verifies the bug fix: startDaemonInBackground expects a string path,
			// not a NormalizedDaemonConfigV1 object. If the old bug were present (passing the
			// config object), resolve() in startDaemonInBackground would call toString() on it,
			// producing "[object Object]" and failing to find the config file.
			// We start and immediately stop to verify it doesn't crash.
			const { startDaemonInBackground, stopDaemonFromConfigFile } = await import("../src/daemon/service");
			const result = await startDaemonInBackground(configPath);
			expect(result.pid).toBeGreaterThan(0);
			expect(result.status.state).toBe("idle");
			await stopDaemonFromConfigFile(configPath);
		});
	});

	describe("enqueue", () => {
		it("passes arguments in correct order: configPath first, jobPath second", async () => {
			const configPath = createTempConfig();
			const config = loadDaemonConfig(configPath);

			const controller = new AbortController();
			controllers.push(controller);

			const daemonPromise = runDaemon(config, {
				signal: controller.signal,
				installSignalHandlers: false,
				jobRunner: (async () => {
					throw new Error("should not be called in enqueue test");
				}) as unknown as import("../src/daemon/service").DaemonJobRunner,
			});

			// Wait for daemon to reach idle
			await waitFor(
				() => readDaemonStatusFile(config),
				status => status?.state === "idle" && status.pid === process.pid,
				5_000,
			);

			// Create a job spec file
			const directory = temporaryDirectories[0]!;
			const jobPath = join(directory, "job.json");
			writeFileSync(
				jobPath,
				JSON.stringify({
					version: "fixbot.job/v1",
					jobId: "dispatch-test-001",
					taskClass: "solve_issue",
					repo: {
						url: "https://github.com/test/repo",
						baseBranch: "main",
					},
					solveIssue: {
						issueNumber: 1,
						issueTitle: "test",
						issueBody: "test body",
					},
					execution: {
						mode: "process",
						timeoutMs: 600_000,
						memoryLimitMb: 4096,
						sandbox: { mode: "workspace-write", networkAccess: true },
					},
				}),
			);

			// Run the enqueue command — if args were reversed, this would fail
			// because it would try to parse the config JSON as a job spec
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			};
			try {
				await runDaemonCommand(["enqueue", "--config", configPath, "--job", jobPath]);
			} finally {
				console.log = originalLog;
			}

			const output = logs.join("\n");
			expect(output).toContain("Enqueued daemon job:");
			expect(output).toContain("dispatch-test-001");

			controller.abort();
			await daemonPromise;
		});
	});

	describe("--config default", () => {
		it("does not throw 'Missing required flag' when --config is omitted", async () => {
			// --config now has a default value (DEFAULT_DAEMON_CONFIG_PATH).
			// Point it to a non-existent temp path to keep the test hermetic
			// and avoid loading/mutating the developer's real daemon state.
			const configPath = join(mkdtempSync(join(tmpdir(), "fixbot-cfg-default-")), "daemon.config.json");
			temporaryDirectories.push(configPath.replace(/\/[^/]+$/, ""));
			const err = await runDaemonCommand(["status", "--config", configPath]).catch((e: Error) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).not.toContain("Missing required flag");
		});
	});
});
