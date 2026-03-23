import { beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import type {
	DaemonRecentResultSummaryV1,
	DaemonStatusSnapshotV1,
} from "../src/types";
import {
	computeRepoStats,
	formatDuration,
	formatElapsed,
	formatStatusDashboard,
	formatUptime,
} from "../src/daemon/status-formatter";

// Disable chalk colors for deterministic assertions
beforeAll(() => {
	chalk.level = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<DaemonStatusSnapshotV1> = {}): DaemonStatusSnapshotV1 {
	return {
		version: "fixbot.daemon-status/v1",
		state: "idle",
		pid: 12345,
		startedAt: "2026-03-20T10:00:00.000Z",
		heartbeatAt: "2026-03-20T10:05:00.000Z",
		heartbeatAgeMs: 3_000,
		lastTransitionAt: "2026-03-20T10:00:01.000Z",
		paths: {
			stateDir: "/tmp/state",
			resultsDir: "/tmp/results",
			statusFile: "/tmp/state/daemon-status.json",
			pidFile: "/tmp/state/daemon.pid",
			lockFile: "/tmp/state/daemon.lock",
		},
		lastError: null,
		queue: { depth: 0, preview: [], previewTruncated: false },
		activeJob: null,
		recentResults: [],
		...overrides,
	};
}

function makeResult(
	overrides: Partial<DaemonRecentResultSummaryV1> = {},
): DaemonRecentResultSummaryV1 {
	return {
		jobId: "job-1",
		status: "success",
		finishedAt: "2026-03-20T10:00:00.000Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
	it("returns 0s for zero milliseconds", () => {
		expect(formatDuration(0)).toBe("0s");
	});

	it("returns 0s for negative input", () => {
		expect(formatDuration(-5000)).toBe("0s");
	});

	it("formats seconds only", () => {
		expect(formatDuration(45_000)).toBe("45s");
	});

	it("formats minutes and seconds", () => {
		expect(formatDuration(125_000)).toBe("2m 5s");
	});

	it("formats hours, minutes, and seconds", () => {
		expect(formatDuration(3_723_000)).toBe("1h 2m 3s");
	});

	it("formats days and hours without seconds", () => {
		// 2 days, 3 hours = 183600s
		expect(formatDuration(183_600_000)).toBe("2d 3h");
	});

	it("omits seconds when days are present", () => {
		// 1 day, 0 hours, 5 minutes, 30 seconds
		const ms = (86_400 + 5 * 60 + 30) * 1_000;
		expect(formatDuration(ms)).toBe("1d 5m");
	});

	it("formats sub-second as 0s", () => {
		expect(formatDuration(999)).toBe("0s");
	});

	it("formats exactly one day", () => {
		expect(formatDuration(86_400_000)).toBe("1d");
	});
});

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

describe("formatUptime", () => {
	it("returns n/a for null startedAt", () => {
		expect(formatUptime(null)).toBe("n/a");
	});

	it("returns n/a for invalid date string", () => {
		expect(formatUptime("not-a-date")).toBe("n/a");
	});

	it("returns 0s when now equals startedAt", () => {
		const t = Date.parse("2026-03-20T10:00:00.000Z");
		expect(formatUptime("2026-03-20T10:00:00.000Z", t)).toBe("0s");
	});

	it("returns formatted duration for valid uptime", () => {
		const started = "2026-03-20T10:00:00.000Z";
		const now = Date.parse("2026-03-20T12:30:45.000Z");
		expect(formatUptime(started, now)).toBe("2h 30m 45s");
	});

	it("returns 0s when now is before startedAt", () => {
		const started = "2026-03-20T12:00:00.000Z";
		const now = Date.parse("2026-03-20T10:00:00.000Z");
		expect(formatUptime(started, now)).toBe("0s");
	});
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe("formatElapsed", () => {
	it("returns n/a for undefined startedAt", () => {
		expect(formatElapsed(undefined)).toBe("n/a");
	});

	it("returns n/a for invalid date", () => {
		expect(formatElapsed("garbage")).toBe("n/a");
	});

	it("returns formatted elapsed time", () => {
		const started = "2026-03-20T10:00:00.000Z";
		const now = Date.parse("2026-03-20T10:05:30.000Z");
		expect(formatElapsed(started, now)).toBe("5m 30s");
	});
});

// ---------------------------------------------------------------------------
// computeRepoStats
// ---------------------------------------------------------------------------

describe("computeRepoStats", () => {
	it("returns empty array for empty results", () => {
		expect(computeRepoStats([])).toEqual([]);
	});

	it("groups by githubRepo and falls back to cli", () => {
		const results: DaemonRecentResultSummaryV1[] = [
			makeResult({
				jobId: "j1",
				status: "success",
				finishedAt: "2026-03-20T10:00:00.000Z",
				submission: { kind: "github-label", githubRepo: "owner/repo-a" },
			}),
			makeResult({
				jobId: "j2",
				status: "failed",
				finishedAt: "2026-03-20T10:01:00.000Z",
				submission: { kind: "cli" },
			}),
			makeResult({
				jobId: "j3",
				status: "success",
				finishedAt: "2026-03-20T10:02:00.000Z",
			}),
		];
		const now = Date.parse("2026-03-20T11:00:00.000Z");
		const stats = computeRepoStats(results, 7 * 24 * 60 * 60 * 1_000, now);

		expect(stats.length).toBe(2);
		const cliStats = stats.find((s) => s.repo === "cli");
		const repoStats = stats.find((s) => s.repo === "owner/repo-a");
		expect(cliStats).toBeDefined();
		expect(cliStats!.total).toBe(2);
		expect(cliStats!.failed).toBe(1);
		expect(cliStats!.success).toBe(1);
		expect(repoStats).toBeDefined();
		expect(repoStats!.total).toBe(1);
		expect(repoStats!.success).toBe(1);
		expect(repoStats!.successRate).toBe("100%");
	});

	it("excludes results outside the time window", () => {
		const now = Date.parse("2026-03-20T10:00:00.000Z");
		const results: DaemonRecentResultSummaryV1[] = [
			makeResult({
				jobId: "old",
				status: "success",
				finishedAt: "2026-03-01T10:00:00.000Z", // 19 days ago
			}),
			makeResult({
				jobId: "recent",
				status: "success",
				finishedAt: "2026-03-19T10:00:00.000Z", // 1 day ago
			}),
		];
		const stats = computeRepoStats(results, 7 * 24 * 60 * 60 * 1_000, now);
		expect(stats.length).toBe(1);
		expect(stats[0].total).toBe(1);
	});

	it("counts timeout status separately", () => {
		const now = Date.parse("2026-03-20T10:00:00.000Z");
		const results: DaemonRecentResultSummaryV1[] = [
			makeResult({ status: "timeout", finishedAt: "2026-03-20T09:00:00.000Z" }),
			makeResult({ status: "success", finishedAt: "2026-03-20T09:00:00.000Z", jobId: "j2" }),
		];
		const stats = computeRepoStats(results, 7 * 24 * 60 * 60 * 1_000, now);
		expect(stats[0].timeout).toBe(1);
		expect(stats[0].success).toBe(1);
		expect(stats[0].successRate).toBe("50%");
	});

	it("sorts by total descending then alphabetically", () => {
		const now = Date.parse("2026-03-20T10:00:00.000Z");
		const results: DaemonRecentResultSummaryV1[] = [
			makeResult({
				jobId: "a1",
				finishedAt: "2026-03-20T09:00:00.000Z",
				submission: { kind: "github-label", githubRepo: "z-repo" },
			}),
			makeResult({
				jobId: "b1",
				finishedAt: "2026-03-20T09:01:00.000Z",
				submission: { kind: "github-label", githubRepo: "a-repo" },
			}),
			makeResult({
				jobId: "b2",
				finishedAt: "2026-03-20T09:02:00.000Z",
				submission: { kind: "github-label", githubRepo: "a-repo" },
			}),
		];
		const stats = computeRepoStats(results, 7 * 24 * 60 * 60 * 1_000, now);
		expect(stats[0].repo).toBe("a-repo");
		expect(stats[1].repo).toBe("z-repo");
	});

	it("computes 0% success rate when all failed", () => {
		const now = Date.parse("2026-03-20T10:00:00.000Z");
		const results: DaemonRecentResultSummaryV1[] = [
			makeResult({ status: "failed", finishedAt: "2026-03-20T09:00:00.000Z" }),
			makeResult({ status: "failed", finishedAt: "2026-03-20T09:01:00.000Z", jobId: "j2" }),
		];
		const stats = computeRepoStats(results, 7 * 24 * 60 * 60 * 1_000, now);
		expect(stats[0].successRate).toBe("0%");
	});
});

// ---------------------------------------------------------------------------
// formatStatusDashboard
// ---------------------------------------------------------------------------

describe("formatStatusDashboard", () => {
	it("renders the daemon status section with state and PID", () => {
		const output = formatStatusDashboard(makeSnapshot());
		expect(output).toContain("Daemon Status");
		expect(output).toContain("State:     idle");
		expect(output).toContain("PID:       12345");
	});

	it("renders uptime from startedAt", () => {
		const now = Date.parse("2026-03-20T12:00:00.000Z");
		const output = formatStatusDashboard(
			makeSnapshot({ startedAt: "2026-03-20T10:00:00.000Z" }),
			[],
			now,
		);
		expect(output).toContain("Uptime:    2h");
	});

	it("renders heartbeat age", () => {
		const output = formatStatusDashboard(makeSnapshot({ heartbeatAgeMs: 5_000 }));
		expect(output).toContain("Heartbeat: 5s ago");
	});

	it("renders 'never' for null heartbeat", () => {
		const output = formatStatusDashboard(makeSnapshot({ heartbeatAgeMs: null }));
		expect(output).toContain("Heartbeat: never");
	});

	it("renders last error when present", () => {
		const output = formatStatusDashboard(
			makeSnapshot({
				lastError: { message: "something broke", code: "BROKEN", at: "2026-03-20T10:00:00.000Z" },
			}),
		);
		expect(output).toContain("[BROKEN] something broke");
	});

	it("renders issues when present", () => {
		const output = formatStatusDashboard(makeSnapshot(), ["pid mismatch", "stale heartbeat"]);
		expect(output).toContain("pid mismatch; stale heartbeat");
	});

	it("renders empty queue", () => {
		const output = formatStatusDashboard(makeSnapshot());
		expect(output).toContain("Queue");
		expect(output).toContain("Depth: 0");
	});

	it("renders queue with preview items", () => {
		const output = formatStatusDashboard(
			makeSnapshot({
				queue: {
					depth: 3,
					preview: [
						{ jobId: "job-100", enqueuedAt: "2026-03-20T10:00:00.000Z" },
						{ jobId: "job-101" },
					],
					previewTruncated: true,
				},
			}),
		);
		expect(output).toContain("Depth: 3");
		expect(output).toContain("job-100");
		expect(output).toContain("job-101");
		expect(output).toContain("... and 1 more");
	});

	it("renders no active job", () => {
		const output = formatStatusDashboard(makeSnapshot());
		expect(output).toContain("Active Job");
		expect(output).toContain("none");
	});

	it("renders active job with elapsed time", () => {
		const now = Date.parse("2026-03-20T10:10:00.000Z");
		const output = formatStatusDashboard(
			makeSnapshot({
				activeJob: {
					jobId: "job-42",
					state: "running",
					startedAt: "2026-03-20T10:05:00.000Z",
				},
			}),
			[],
			now,
		);
		expect(output).toContain("Job ID:  job-42");
		expect(output).toContain("State:   running");
		expect(output).toContain("Elapsed: 5m");
	});

	it("renders empty recent results", () => {
		const output = formatStatusDashboard(makeSnapshot());
		expect(output).toContain("Recent Results");
		expect(output).toContain("none");
	});

	it("renders recent results with status and summary", () => {
		const output = formatStatusDashboard(
			makeSnapshot({
				recentResults: [
					makeResult({ jobId: "j1", status: "success", summary: "fixed CI" }),
					makeResult({ jobId: "j2", status: "failed", failureReason: "OOM" }),
				],
			}),
		);
		expect(output).toContain("j1 success - fixed CI");
		expect(output).toContain("j2 failed");
		expect(output).toContain("(OOM)");
	});

	it("truncates recent results display to 10", () => {
		const results: DaemonRecentResultSummaryV1[] = [];
		for (let i = 0; i < 15; i++) {
			results.push(
				makeResult({
					jobId: `job-${i}`,
					finishedAt: `2026-03-20T10:${String(i).padStart(2, "0")}:00.000Z`,
				}),
			);
		}
		const output = formatStatusDashboard(makeSnapshot({ recentResults: results }));
		expect(output).toContain("job-0");
		expect(output).toContain("job-9");
		expect(output).not.toContain("job-10 success");
		expect(output).toContain("... and 5 more");
	});

	it("renders per-repo stats section", () => {
		const now = Date.parse("2026-03-20T11:00:00.000Z");
		const output = formatStatusDashboard(
			makeSnapshot({
				recentResults: [
					makeResult({
						jobId: "j1",
						status: "success",
						finishedAt: "2026-03-20T10:00:00.000Z",
						submission: { kind: "github-label", githubRepo: "owner/repo" },
					}),
					makeResult({
						jobId: "j2",
						status: "failed",
						finishedAt: "2026-03-20T10:01:00.000Z",
						submission: { kind: "github-label", githubRepo: "owner/repo" },
					}),
				],
			}),
			[],
			now,
		);
		expect(output).toContain("Per-Repo Stats (last 7 days)");
		expect(output).toContain("owner/repo");
		expect(output).toContain("2 jobs");
		expect(output).toContain("50%");
	});

	it("omits per-repo stats when no results in window", () => {
		const now = Date.parse("2026-04-01T10:00:00.000Z");
		const output = formatStatusDashboard(
			makeSnapshot({
				recentResults: [
					makeResult({
						finishedAt: "2026-03-01T10:00:00.000Z", // way outside 7-day window
					}),
				],
			}),
			[],
			now,
		);
		expect(output).not.toContain("Per-Repo Stats");
	});

	it("renders PID as none when null", () => {
		const output = formatStatusDashboard(makeSnapshot({ pid: null }));
		expect(output).toContain("PID:       none");
	});

	it("renders degraded state", () => {
		const output = formatStatusDashboard(makeSnapshot({ state: "degraded" }));
		expect(output).toContain("State:     degraded");
	});

	it("renders error state", () => {
		const output = formatStatusDashboard(makeSnapshot({ state: "error" }));
		expect(output).toContain("State:     error");
	});

	it("renders n/a uptime when startedAt is null", () => {
		const output = formatStatusDashboard(makeSnapshot({ startedAt: null }));
		expect(output).toContain("Uptime:    n/a");
	});
});
