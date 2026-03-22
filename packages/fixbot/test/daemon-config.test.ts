import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
	createDaemonStatus,
	DAEMON_STATUS_VERSION_V1,
	DEFAULT_GITHUB_POLL_INTERVAL_MS,
	normalizeDaemonStatus,
	parseDaemonConfigText,
} from "../src/index";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureConfigPath = join(testDir, "fixtures", "daemon.config.json");

describe("daemon config contract", () => {
	it("normalizes valid config relative to the config file", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
				status: {
					file: "./runtime/status/fixbot-status.json",
					pretty: false,
				},
				runtime: {
					heartbeatIntervalMs: 15_000,
					idleSleepMs: 2_500,
				},
			}),
			fixtureConfigPath,
		);

		expect(config).toEqual({
			version: "fixbot.daemon-config/v1",
			paths: {
				stateDir: join(testDir, "fixtures", "runtime", "state"),
				resultsDir: join(testDir, "fixtures", "runtime", "results"),
				statusFile: join(testDir, "fixtures", "runtime", "status", "fixbot-status.json"),
				pidFile: join(testDir, "fixtures", "runtime", "state", "daemon.pid"),
				lockFile: join(testDir, "fixtures", "runtime", "state", "daemon.lock"),
			},
			status: {
				format: "json",
				file: join(testDir, "fixtures", "runtime", "status", "fixbot-status.json"),
				pretty: false,
			},
			runtime: {
				heartbeatIntervalMs: 15_000,
				idleSleepMs: 2_500,
			},
			github: undefined,
			identity: {
				botUrl: "https://github.com/nicobailon/fixbot",
			},
		});
	});

	it("rejects invalid runtime settings", () => {
		const invalid = JSON.stringify({
			version: "fixbot.daemon-config/v1",
			paths: {
				stateDir: "./runtime/state",
				resultsDir: "./runtime/results",
			},
			runtime: {
				heartbeatIntervalMs: 0,
			},
		});

		expect(() => parseDaemonConfigText(invalid, fixtureConfigPath)).toThrow(
			`${fixtureConfigPath}.runtime.heartbeatIntervalMs must be a positive integer`,
		);
	});

	it("creates and validates the daemon status contract shape", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
			}),
			fixtureConfigPath,
		);
		const status = createDaemonStatus(config, {
			state: "idle",
			pid: 4321,
			startedAt: "2026-03-16T08:00:00.000Z",
			heartbeatAt: "2026-03-16T08:00:05.000Z",
			lastTransitionAt: "2026-03-16T08:00:05.000Z",
			lastError: {
				message: "previous startup warning",
				at: "2026-03-16T07:59:59.000Z",
				code: "WARN_BOOT",
			},
		});

		expect(status).toEqual({
			version: DAEMON_STATUS_VERSION_V1,
			state: "idle",
			pid: 4321,
			startedAt: "2026-03-16T08:00:00.000Z",
			heartbeatAt: "2026-03-16T08:00:05.000Z",
			lastTransitionAt: "2026-03-16T08:00:05.000Z",
			paths: config.paths,
			lastError: {
				message: "previous startup warning",
				at: "2026-03-16T07:59:59.000Z",
				code: "WARN_BOOT",
			},
			queue: {
				depth: 0,
				preview: [],
				previewTruncated: false,
			},
			activeJob: null,
			recentResults: [],
		});

		expect(() =>
			normalizeDaemonStatus(
				{
					...status,
					state: "unknown",
				},
				"status.json",
			),
		).toThrow('status.json.state must be one of "starting", "idle", "running", "degraded", "error"');
	});
});

describe("daemon config github section", () => {
	it("parses and normalizes a valid github config section", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
				github: {
					repos: [
						{
							url: "https://github.com/owner/repo",
							baseBranch: "main",
							triggerLabel: "fixbot",
						},
					],
					pollIntervalMs: 30_000,
					token: "ghp_test123",
				},
			}),
			fixtureConfigPath,
		);

		expect(config.github).toBeDefined();
		expect(config.github!.repos).toEqual([
			{
				url: "https://github.com/owner/repo",
				baseBranch: "main",
				triggerLabel: "fixbot",
			},
		]);
		expect(config.github!.pollIntervalMs).toBe(30_000);
		expect(config.github!.token).toBe("ghp_test123");
	});

	it("defaults pollIntervalMs and token when omitted", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
				github: {
					repos: [
						{
							url: "https://github.com/owner/repo",
							baseBranch: "main",
							triggerLabel: "fixbot",
						},
					],
				},
			}),
			fixtureConfigPath,
		);

		expect(config.github).toBeDefined();
		expect(config.github!.pollIntervalMs).toBe(DEFAULT_GITHUB_POLL_INTERVAL_MS);
	});

	it("rejects github config with empty repos array", () => {
		const invalid = JSON.stringify({
			version: "fixbot.daemon-config/v1",
			paths: {
				stateDir: "./runtime/state",
				resultsDir: "./runtime/results",
			},
			github: {
				repos: [],
			},
		});

		expect(() => parseDaemonConfigText(invalid, fixtureConfigPath)).toThrow(
			`${fixtureConfigPath}.github.repos must be a non-empty array`,
		);
	});

	it("rejects github repo entry missing triggerLabel", () => {
		const invalid = JSON.stringify({
			version: "fixbot.daemon-config/v1",
			paths: {
				stateDir: "./runtime/state",
				resultsDir: "./runtime/results",
			},
			github: {
				repos: [
					{
						url: "https://github.com/owner/repo",
						baseBranch: "main",
					},
				],
			},
		});

		expect(() => parseDaemonConfigText(invalid, fixtureConfigPath)).toThrow(
			`${fixtureConfigPath}.github.repos[0].triggerLabel must be a non-empty string`,
		);
	});

	it("parses config without github section (backward compatibility)", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
			}),
			fixtureConfigPath,
		);

		expect(config.github).toBeUndefined();
	});
});

describe("daemon config appAuth section", () => {
	it("parses valid appAuth config", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
				github: {
					repos: [
						{
							url: "https://github.com/owner/repo",
							baseBranch: "main",
							triggerLabel: "fixbot",
						},
					],
					appAuth: {
						appId: 12345,
						privateKeyPath: "/etc/fixbot/app.pem",
						installationId: 67890,
					},
				},
			}),
			fixtureConfigPath,
		);

		expect(config.github).toBeDefined();
		expect(config.github!.appAuth).toEqual({
			appId: 12345,
			privateKeyPath: "/etc/fixbot/app.pem",
			installationId: 67890,
		});
	});

	it("passes appAuth through to normalized config", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
				github: {
					repos: [
						{
							url: "https://github.com/owner/repo",
							baseBranch: "main",
							triggerLabel: "fixbot",
						},
					],
					appAuth: {
						appId: 1,
						privateKeyPath: "/key.pem",
						installationId: 2,
					},
				},
			}),
			fixtureConfigPath,
		);

		expect(config.github!.appAuth).toEqual({
			appId: 1,
			privateKeyPath: "/key.pem",
			installationId: 2,
		});
	});

	it("rejects appAuth with missing appId", () => {
		const invalid = JSON.stringify({
			version: "fixbot.daemon-config/v1",
			paths: {
				stateDir: "./runtime/state",
				resultsDir: "./runtime/results",
			},
			github: {
				repos: [
					{
						url: "https://github.com/owner/repo",
						baseBranch: "main",
						triggerLabel: "fixbot",
					},
				],
				appAuth: {
					privateKeyPath: "/key.pem",
					installationId: 1,
				},
			},
		});

		expect(() => parseDaemonConfigText(invalid, fixtureConfigPath)).toThrow(
			`${fixtureConfigPath}.github.appAuth.appId must be a positive integer`,
		);
	});

	it("rejects appAuth with non-integer installationId", () => {
		const invalid = JSON.stringify({
			version: "fixbot.daemon-config/v1",
			paths: {
				stateDir: "./runtime/state",
				resultsDir: "./runtime/results",
			},
			github: {
				repos: [
					{
						url: "https://github.com/owner/repo",
						baseBranch: "main",
						triggerLabel: "fixbot",
					},
				],
				appAuth: {
					appId: 1,
					privateKeyPath: "/key.pem",
					installationId: 1.5,
				},
			},
		});

		expect(() => parseDaemonConfigText(invalid, fixtureConfigPath)).toThrow(
			`${fixtureConfigPath}.github.appAuth.installationId must be a positive integer`,
		);
	});

	it("rejects appAuth with empty privateKeyPath", () => {
		const invalid = JSON.stringify({
			version: "fixbot.daemon-config/v1",
			paths: {
				stateDir: "./runtime/state",
				resultsDir: "./runtime/results",
			},
			github: {
				repos: [
					{
						url: "https://github.com/owner/repo",
						baseBranch: "main",
						triggerLabel: "fixbot",
					},
				],
				appAuth: {
					appId: 1,
					privateKeyPath: "",
					installationId: 1,
				},
			},
		});

		expect(() => parseDaemonConfigText(invalid, fixtureConfigPath)).toThrow(
			`${fixtureConfigPath}.github.appAuth.privateKeyPath must be a non-empty string`,
		);
	});

	it("config without appAuth has appAuth undefined", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
				github: {
					repos: [
						{
							url: "https://github.com/owner/repo",
							baseBranch: "main",
							triggerLabel: "fixbot",
						},
					],
				},
			}),
			fixtureConfigPath,
		);

		expect(config.github!.appAuth).toBeUndefined();
	});
});

describe("daemon config gpgKeyId", () => {
	it("parses gpgKeyId from github config", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
				github: {
					repos: [
						{
							url: "https://github.com/owner/repo",
							baseBranch: "main",
							triggerLabel: "fixbot",
						},
					],
					gpgKeyId: "ABCDEF1234567890",
				},
			}),
			fixtureConfigPath,
		);
		expect(config.github!.gpgKeyId).toBe("ABCDEF1234567890");
	});

	it("gpgKeyId is undefined when not set", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
				github: {
					repos: [
						{
							url: "https://github.com/owner/repo",
							baseBranch: "main",
							triggerLabel: "fixbot",
						},
					],
				},
			}),
			fixtureConfigPath,
		);
		expect(config.github!.gpgKeyId).toBeUndefined();
	});

	it("rejects empty string gpgKeyId", () => {
		expect(() =>
			parseDaemonConfigText(
				JSON.stringify({
					version: "fixbot.daemon-config/v1",
					paths: {
						stateDir: "./runtime/state",
						resultsDir: "./runtime/results",
					},
					github: {
						repos: [
							{
								url: "https://github.com/owner/repo",
								baseBranch: "main",
								triggerLabel: "fixbot",
							},
						],
						gpgKeyId: "",
					},
				}),
				fixtureConfigPath,
			),
		).toThrow();
	});
});

describe("parseDaemonSubmissionSource via status parsing", () => {
	it("accepts github-label submission kind in daemon status", () => {
		const config = parseDaemonConfigText(
			JSON.stringify({
				version: "fixbot.daemon-config/v1",
				paths: {
					stateDir: "./runtime/state",
					resultsDir: "./runtime/results",
				},
			}),
			fixtureConfigPath,
		);

		const status = normalizeDaemonStatus(
			{
				version: "fixbot.daemon-status/v1",
				state: "idle",
				lastTransitionAt: "2026-03-16T08:00:00.000Z",
				paths: config.paths,
				queue: {
					depth: 1,
					preview: [
						{
							jobId: "gh-abc123",
							enqueuedAt: "2026-03-16T08:00:00.000Z",
							submission: {
								kind: "github-label",
								githubRepo: "https://github.com/owner/repo",
								githubIssueNumber: 42,
								githubLabelName: "fixbot",
								githubActionsRunId: 99999,
							},
						},
					],
					previewTruncated: false,
				},
				recentResults: [],
			},
			"test-status",
		);

		expect(status.queue.preview[0].submission).toEqual({
			kind: "github-label",
			githubRepo: "https://github.com/owner/repo",
			githubIssueNumber: 42,
			githubLabelName: "fixbot",
			githubActionsRunId: 99999,
		});
	});
});
