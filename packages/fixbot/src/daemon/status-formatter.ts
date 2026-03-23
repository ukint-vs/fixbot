import chalk from "chalk";
import type {
	DaemonRecentResultSummaryV1,
	DaemonStatusSnapshotV1,
} from "../types";

// ---------------------------------------------------------------------------
// RepoStats
// ---------------------------------------------------------------------------

export interface RepoStats {
	repo: string;
	total: number;
	success: number;
	failed: number;
	timeout: number;
	successRate: string;
}

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

/**
 * Format milliseconds as human-readable duration.
 * Examples: "2h 14m", "3m 12s", "0s"
 */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";

	const totalSeconds = Math.floor(ms / 1_000);
	if (totalSeconds === 0) return "0s";

	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);

	// Omit seconds when days are present
	if (days === 0 && seconds > 0) parts.push(`${seconds}s`);

	return parts.length > 0 ? parts.join(" ") : "0s";
}

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

/**
 * Format uptime from an ISO timestamp. Returns "n/a" for null/invalid inputs.
 */
export function formatUptime(startedAt: string | null | undefined, now: number = Date.now()): string {
	if (startedAt == null) return "n/a";
	const startMs = Date.parse(startedAt);
	if (Number.isNaN(startMs)) return "n/a";
	const elapsed = now - startMs;
	if (elapsed <= 0) return "0s";
	return formatDuration(elapsed);
}

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

/**
 * Format elapsed time from an ISO timestamp. Returns "n/a" for undefined/invalid inputs.
 */
export function formatElapsed(startedAt: string | undefined, now: number = Date.now()): string {
	if (startedAt === undefined) return "n/a";
	const startMs = Date.parse(startedAt);
	if (Number.isNaN(startMs)) return "n/a";
	const elapsed = now - startMs;
	if (elapsed <= 0) return "0s";
	return formatDuration(elapsed);
}

// ---------------------------------------------------------------------------
// computeRepoStats
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

/**
 * Group recent results by repo, compute counts and success rate.
 * Results outside the time window are excluded.
 */
export function computeRepoStats(
	results: DaemonRecentResultSummaryV1[],
	windowMs: number = DEFAULT_WINDOW_MS,
	now: number = Date.now(),
): RepoStats[] {
	const cutoff = now - windowMs;

	const map = new Map<string, { success: number; failed: number; timeout: number }>();

	for (const r of results) {
		const finishedMs = Date.parse(r.finishedAt);
		if (finishedMs < cutoff) continue;

		const repo = r.submission?.githubRepo ?? "cli";
		let entry = map.get(repo);
		if (!entry) {
			entry = { success: 0, failed: 0, timeout: 0 };
			map.set(repo, entry);
		}

		if (r.status === "success") entry.success++;
		else if (r.status === "timeout") entry.timeout++;
		else entry.failed++;
	}

	const stats: RepoStats[] = [];
	for (const [repo, counts] of map) {
		const total = counts.success + counts.failed + counts.timeout;
		const rate = total > 0 ? Math.round((counts.success / total) * 100) : 0;
		stats.push({
			repo,
			total,
			success: counts.success,
			failed: counts.failed,
			timeout: counts.timeout,
			successRate: `${rate}%`,
		});
	}

	// Sort by total descending, then alphabetically
	stats.sort((a, b) => {
		if (b.total !== a.total) return b.total - a.total;
		return a.repo.localeCompare(b.repo);
	});

	return stats;
}

// ---------------------------------------------------------------------------
// formatStatusDashboard
// ---------------------------------------------------------------------------

function stateColor(state: string): (text: string) => string {
	switch (state) {
		case "idle":
			return chalk.green;
		case "running":
			return chalk.blue;
		case "degraded":
			return chalk.yellow;
		case "error":
			return chalk.red;
		default:
			return chalk.gray;
	}
}

function section(title: string): string {
	return `\n${chalk.bold.underline(title)}\n`;
}

/**
 * Render a full colored status dashboard from a DaemonStatusSnapshotV1.
 */
export function formatStatusDashboard(
	status: DaemonStatusSnapshotV1,
	issues: string[] = [],
	now: number = Date.now(),
): string {
	const lines: string[] = [];

	// ── Daemon Status ──
	lines.push(section("Daemon Status"));

	const stateStr = stateColor(status.state)(status.state);
	lines.push(`  State:     ${stateStr}`);
	lines.push(`  PID:       ${status.pid != null ? status.pid : "none"}`);
	lines.push(`  Uptime:    ${formatUptime(status.startedAt, now)}`);

	if (status.heartbeatAgeMs != null) {
		lines.push(`  Heartbeat: ${formatDuration(status.heartbeatAgeMs)} ago`);
	} else {
		lines.push("  Heartbeat: never");
	}

	if (status.lastError) {
		const code = status.lastError.code ? `[${status.lastError.code}] ` : "";
		lines.push(`  ${chalk.red("Last Error:")} ${code}${status.lastError.message}`);
	}

	if (issues && issues.length > 0) {
		lines.push(`  ${chalk.yellow("Issues:")} ${issues.join("; ")}`);
	}

	// ── Queue ──
	lines.push(section("Queue"));
	lines.push(`  Depth: ${status.queue.depth}`);

	if (status.queue.preview.length > 0) {
		for (const job of status.queue.preview) {
			const enq = job.enqueuedAt ? ` (enqueued ${job.enqueuedAt})` : "";
			lines.push(`    ${chalk.dim("•")} ${job.jobId}${enq}`);
		}
		const remaining = status.queue.depth - status.queue.preview.length;
		if (remaining > 0) {
			lines.push(`    ${chalk.dim(`... and ${remaining} more`)}`);
		}
	}

	// ── Active Job ──
	lines.push(section("Active Job"));

	if (status.activeJob) {
		lines.push(`  Job ID:  ${status.activeJob.jobId}`);
		lines.push(`  State:   ${status.activeJob.state}`);
		lines.push(`  Elapsed: ${formatElapsed(status.activeJob.startedAt, now)}`);
	} else {
		lines.push(`  ${chalk.dim("none")}`);
	}

	// ── Recent Results ──
	lines.push(section("Recent Results"));

	if (status.recentResults.length === 0) {
		lines.push(`  ${chalk.dim("none")}`);
	} else {
		const maxDisplay = 10;
		const displayed = status.recentResults.slice(0, maxDisplay);
		for (const r of displayed) {
			const statusColor = r.status === "success" ? chalk.green : r.status === "failed" ? chalk.red : chalk.yellow;
			let line = `  ${r.jobId} ${statusColor(r.status)}`;
			if (r.summary) line += ` - ${r.summary}`;
			if (r.failureReason) line += ` ${chalk.dim(`(${r.failureReason})`)}`;
			lines.push(line);
		}
		const remaining = status.recentResults.length - maxDisplay;
		if (remaining > 0) {
			lines.push(`  ${chalk.dim(`... and ${remaining} more`)}`);
		}
	}

	// ── Per-Repo Stats ──
	const repoStats = computeRepoStats(status.recentResults, DEFAULT_WINDOW_MS, now);
	if (repoStats.length > 0) {
		lines.push(section("Per-Repo Stats (last 7 days)"));
		for (const s of repoStats) {
			lines.push(
				`  ${s.repo}  ${s.total} jobs  ${chalk.green(`${s.success} ok`)}  ${chalk.red(`${s.failed} fail`)}  ${s.successRate}`,
			);
		}
	}

	return lines.join("\n") + "\n";
}
