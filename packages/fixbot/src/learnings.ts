import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_FIXBOT_DIR } from "./config";
import {
	type ErrorCategory,
	type JobResultV1,
	LEARNING_ENTRY_VERSION_V1,
	type LearningEntryV1,
	type ResultStatus,
} from "./types";

const LEARNINGS_FILE = "learnings.jsonl";
const MAX_ENTRIES = 100;
const INJECT_COUNT = 10;
const MAX_SUMMARY_LENGTH = 200;

// ---------------------------------------------------------------------------
// Repo URL → filesystem-safe slug
// ---------------------------------------------------------------------------

/**
 * Convert a repo URL to a filesystem-safe slug.
 *
 * Handles HTTPS URLs (https://github.com/owner/repo.git),
 * SSH URLs (git@github.com:owner/repo.git), and falls back
 * to a SHA-256 hash prefix for anything unexpected.
 */
export function repoUrlToSlug(url: string): string {
	// Try HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
	const httpsMatch = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (httpsMatch) {
		return `${httpsMatch[1]}__${httpsMatch[2]}`;
	}

	// Try SSH: git@github.com:owner/repo.git or git@github.com:owner/repo
	const sshMatch = url.match(/^[^@]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (sshMatch) {
		return `${sshMatch[1]}__${sshMatch[2]}`;
	}

	// Fallback: SHA-256 hash prefix
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
	return `_hash_${hash}`;
}

/**
 * Get (and ensure existence of) the per-repo learnings directory.
 * Returns the path: ~/.fixbot/repos/{owner}__{repo}/
 */
function getLearningsDir(repoUrl: string): string {
	const slug = repoUrlToSlug(repoUrl);
	const dir = join(DEFAULT_FIXBOT_DIR, "repos", slug);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// Error category detection
// ---------------------------------------------------------------------------

/** Derive an ErrorCategory from a job result, or null for clean successes. */
export function classifyError(result: JobResultV1): ErrorCategory | null {
	if (result.status === "success") return null;
	if (result.status === "timeout") return "timeout";

	const text = `${result.summary ?? ""} ${result.failureReason ?? ""}`.toLowerCase();

	if (text.includes("auth") || text.includes("permission") || text.includes("credentials") || text.includes("401") || text.includes("403")) {
		return "auth_error";
	}
	if (text.includes("rate limit") || text.includes("rate_limit") || text.includes("429") || text.includes("too many requests")) {
		return "rate_limit";
	}
	if (text.includes("refused") || text.includes("refusal") || text.includes("content policy") || text.includes("safety")) {
		return "model_refusal";
	}
	if (text.includes("no changes") || text.includes("no fix") || text.includes("nothing to commit")) {
		return "no_changes";
	}
	if (text.includes("build fail") || text.includes("compile") || text.includes("compilation")) {
		return "build_failure";
	}
	if (text.includes("test fail") || text.includes("tests fail") || text.includes("test suite")) {
		return "test_failure";
	}
	return "unknown";
}

// ---------------------------------------------------------------------------
// JSONL read / write
// ---------------------------------------------------------------------------

function getLearningsPath(repoUrl: string): string {
	return join(getLearningsDir(repoUrl), LEARNINGS_FILE);
}

function truncateSummary(summary: string): string {
	if (summary.length <= MAX_SUMMARY_LENGTH) return summary;
	return `${summary.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

/** Build a LearningEntryV1 from a completed job result. */
export function buildLearningEntry(result: JobResultV1): LearningEntryV1 {
	return {
		version: LEARNING_ENTRY_VERSION_V1,
		jobId: result.jobId,
		taskClass: result.taskClass,
		status: result.status,
		errorCategory: classifyError(result),
		summary: truncateSummary(result.summary),
		durationMs: result.execution.durationMs,
		timestamp: result.execution.finishedAt,
	};
}

/** Append a learning entry to the per-repo JSONL file. */
export function appendLearning(repoUrl: string, entry: LearningEntryV1): void {
	const filePath = getLearningsPath(repoUrl);
	appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
}

/** Read all learning entries from the per-repo JSONL file. */
export function readLearnings(repoUrl: string): LearningEntryV1[] {
	const filePath = getLearningsPath(repoUrl);
	if (!existsSync(filePath)) return [];

	const content = readFileSync(filePath, "utf-8").trim();
	if (content === "") return [];

	const entries: LearningEntryV1[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed) as LearningEntryV1;
			if (parsed.version === LEARNING_ENTRY_VERSION_V1) {
				entries.push(parsed);
			}
		} catch {
			// Skip malformed lines silently
		}
	}
	return entries;
}

/**
 * Rotate the learnings file if it exceeds MAX_ENTRIES.
 * Keeps the most recent MAX_ENTRIES entries using atomic rename.
 */
export function rotateLearnings(repoUrl: string): void {
	const filePath = getLearningsPath(repoUrl);
	if (!existsSync(filePath)) return;

	const entries = readLearnings(repoUrl);
	if (entries.length <= MAX_ENTRIES) return;

	const kept = entries.slice(-MAX_ENTRIES);
	const tmpPath = `${filePath}.tmp`;
	writeFileSync(tmpPath, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
	renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

interface PatternInsight {
	message: string;
}

/**
 * Detect simple patterns from recent learning entries.
 * Analyses the last 10 entries for recurring error categories.
 */
export function detectPatterns(entries: LearningEntryV1[]): PatternInsight[] {
	const recent = entries.slice(-INJECT_COUNT);
	if (recent.length < 2) return [];

	const insights: PatternInsight[] = [];

	// Count error categories
	const categoryCounts = new Map<ErrorCategory, number>();
	let failCount = 0;
	for (const entry of recent) {
		if (entry.errorCategory) {
			categoryCounts.set(entry.errorCategory, (categoryCounts.get(entry.errorCategory) ?? 0) + 1);
			failCount++;
		}
	}

	// Flag if majority of recent jobs are failing
	if (failCount > recent.length / 2) {
		insights.push({ message: `${failCount}/${recent.length} recent jobs failed.` });
	}

	// Flag dominant error category (>= 3 occurrences)
	for (const [category, count] of categoryCounts) {
		if (count >= 3) {
			insights.push({ message: `Recurring ${category}: seen ${count} times in last ${recent.length} jobs.` });
		}
	}

	// Flag if recent jobs are getting slower (compare first half vs second half averages)
	if (recent.length >= 4) {
		const mid = Math.floor(recent.length / 2);
		const firstHalf = recent.slice(0, mid);
		const secondHalf = recent.slice(mid);
		const avgFirst = firstHalf.reduce((sum, e) => sum + e.durationMs, 0) / firstHalf.length;
		const avgSecond = secondHalf.reduce((sum, e) => sum + e.durationMs, 0) / secondHalf.length;
		if (avgSecond > avgFirst * 1.5 && avgSecond - avgFirst > 30_000) {
			insights.push({ message: "Recent jobs are trending slower." });
		}
	}

	return insights;
}

// ---------------------------------------------------------------------------
// Context formatting (for injection into agent prompts)
// ---------------------------------------------------------------------------

function formatStatus(status: ResultStatus): string {
	switch (status) {
		case "success":
			return "OK";
		case "failed":
			return "FAIL";
		case "timeout":
			return "TIMEOUT";
	}
}

function formatDurationShort(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

/**
 * Format recent learnings into a markdown section suitable for injection
 * into the agent's context. Returns undefined if there are no learnings.
 */
export function formatLearningsContext(repoUrl: string): string | undefined {
	const entries = readLearnings(repoUrl);
	if (entries.length === 0) return undefined;

	const recent = entries.slice(-INJECT_COUNT);
	const patterns = detectPatterns(entries);

	const lines: string[] = [
		"## Recent Job History",
		"",
	];

	for (const entry of recent) {
		const status = formatStatus(entry.status);
		const duration = formatDurationShort(entry.durationMs);
		const category = entry.errorCategory ? ` [${entry.errorCategory}]` : "";
		lines.push(`- ${status} ${entry.taskClass} (${duration})${category}: ${entry.summary}`);
	}

	if (patterns.length > 0) {
		lines.push("");
		lines.push("**Patterns:**");
		for (const p of patterns) {
			lines.push(`- ${p.message}`);
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// High-level: record a learning from a completed job (safe, never throws)
// ---------------------------------------------------------------------------

/**
 * Record a learning entry after job completion.
 * All operations are wrapped in try/catch — failures are logged at warn level, never crash jobs.
 */
export function recordLearning(
	result: JobResultV1,
	logger?: { warn: (msg: string) => void },
): void {
	try {
		const entry = buildLearningEntry(result);
		appendLearning(result.repo.url, entry);
		rotateLearnings(result.repo.url);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.warn(`failed to record learning: ${msg}`);
	}
}
