import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	appendLearning,
	buildLearningEntry,
	classifyError,
	detectPatterns,
	formatLearningsContext,
	readLearnings,
	recordLearning,
	repoUrlToSlug,
	rotateLearnings,
} from "../src/learnings";
import type { JobResultV1, LearningEntryV1 } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute the on-disk dir for a given repo URL (mirrors learnings.ts logic). */
function repoCacheDir(repoUrl: string): string {
	return join(homedir(), ".fixbot", "repos", repoUrlToSlug(repoUrl));
}

function cleanupRepoDir(repoUrl: string): void {
	try {
		rmSync(repoCacheDir(repoUrl), { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function makeResult(overrides: Partial<JobResultV1> = {}): JobResultV1 {
	return {
		version: "fixbot.result/v1",
		jobId: overrides.jobId ?? "job-1",
		taskClass: overrides.taskClass ?? "fix_ci",
		status: overrides.status ?? "success",
		summary: overrides.summary ?? "Fixed the CI build.",
		failureReason: overrides.failureReason,
		repo: overrides.repo ?? { url: "https://github.com/test/repo.git", baseBranch: "main" },
		execution: {
			mode: "process",
			timeoutMs: 600000,
			memoryLimitMb: 4096,
			sandbox: { mode: "workspace-write", networkAccess: true },
			workspaceDir: "/tmp/ws",
			startedAt: "2025-01-01T00:00:00.000Z",
			finishedAt: "2025-01-01T00:02:00.000Z",
			durationMs: overrides.execution?.durationMs ?? 120000,
			...overrides.execution,
		},
		artifacts: {
			resultFile: "/tmp/result.json",
			rootDir: "/tmp/artifacts",
			jobSpecFile: "/tmp/job.json",
			patchFile: "/tmp/patch.diff",
			traceFile: "/tmp/trace.jsonl",
			assistantFinalFile: "/tmp/final.txt",
		},
		diagnostics: {
			patchSha256: "abc123",
			changedFileCount: 2,
			markers: { result: true, summary: true, failureReason: false },
		},
	};
}

function makeEntry(overrides: Partial<LearningEntryV1> = {}): LearningEntryV1 {
	return {
		version: "fixbot.learning/v1",
		jobId: overrides.jobId ?? "job-1",
		taskClass: overrides.taskClass ?? "fix_ci",
		status: overrides.status ?? "success",
		errorCategory: overrides.errorCategory ?? null,
		summary: overrides.summary ?? "Fixed the CI build.",
		durationMs: overrides.durationMs ?? 120000,
		timestamp: overrides.timestamp ?? "2025-01-01T00:02:00.000Z",
	};
}

// ---------------------------------------------------------------------------
// repoUrlToSlug
// ---------------------------------------------------------------------------

describe("repoUrlToSlug", () => {
	it("handles HTTPS URL with .git suffix", () => {
		expect(repoUrlToSlug("https://github.com/owner/repo.git")).toBe("owner__repo");
	});

	it("handles HTTPS URL without .git suffix", () => {
		expect(repoUrlToSlug("https://github.com/owner/repo")).toBe("owner__repo");
	});

	it("handles SSH URL with .git suffix", () => {
		expect(repoUrlToSlug("git@github.com:owner/repo.git")).toBe("owner__repo");
	});

	it("handles SSH URL without .git suffix", () => {
		expect(repoUrlToSlug("git@github.com:owner/repo")).toBe("owner__repo");
	});

	it("handles HTTPS URL with different host", () => {
		expect(repoUrlToSlug("https://gitlab.com/myorg/myproject.git")).toBe("myorg__myproject");
	});

	it("handles SSH URL with different host", () => {
		expect(repoUrlToSlug("git@gitlab.com:myorg/myproject.git")).toBe("myorg__myproject");
	});

	it("falls back to hash for malformed URL", () => {
		const result = repoUrlToSlug("not-a-url");
		expect(result).toStartWith("_hash_");
		expect(result.length).toBe(6 + 16); // "_hash_" + 16 hex chars
	});

	it("falls back to hash for URL with too many segments", () => {
		const result = repoUrlToSlug("https://github.com/owner/repo/extra/path");
		expect(result).toStartWith("_hash_");
	});

	it("produces deterministic hash for same input", () => {
		const a = repoUrlToSlug("not-a-url");
		const b = repoUrlToSlug("not-a-url");
		expect(a).toBe(b);
	});

	it("produces different hashes for different inputs", () => {
		const a = repoUrlToSlug("url-one");
		const b = repoUrlToSlug("url-two");
		expect(a).not.toBe(b);
	});
});

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe("classifyError", () => {
	it("returns null for success", () => {
		expect(classifyError(makeResult({ status: "success" }))).toBeNull();
	});

	it("returns timeout for timeout status", () => {
		expect(classifyError(makeResult({ status: "timeout" }))).toBe("timeout");
	});

	it("detects auth_error from summary", () => {
		expect(classifyError(makeResult({ status: "failed", summary: "Authentication failed: 401" }))).toBe("auth_error");
	});

	it("detects auth_error from failureReason", () => {
		expect(
			classifyError(makeResult({ status: "failed", summary: "failed", failureReason: "permission denied" })),
		).toBe("auth_error");
	});

	it("detects rate_limit", () => {
		expect(classifyError(makeResult({ status: "failed", summary: "rate limit exceeded (429)" }))).toBe("rate_limit");
	});

	it("detects model_refusal", () => {
		expect(classifyError(makeResult({ status: "failed", summary: "content policy violation refused" }))).toBe(
			"model_refusal",
		);
	});

	it("detects no_changes", () => {
		expect(classifyError(makeResult({ status: "failed", summary: "no changes needed, nothing to commit" }))).toBe(
			"no_changes",
		);
	});

	it("detects build_failure", () => {
		expect(classifyError(makeResult({ status: "failed", summary: "compilation error in src/main.ts" }))).toBe(
			"build_failure",
		);
	});

	it("detects test_failure", () => {
		expect(classifyError(makeResult({ status: "failed", summary: "3 tests fail in suite" }))).toBe("test_failure");
	});

	it("returns unknown for unrecognized failure", () => {
		expect(classifyError(makeResult({ status: "failed", summary: "something went wrong" }))).toBe("unknown");
	});
});

// ---------------------------------------------------------------------------
// buildLearningEntry
// ---------------------------------------------------------------------------

describe("buildLearningEntry", () => {
	it("builds entry from successful result", () => {
		const result = makeResult();
		const entry = buildLearningEntry(result);
		expect(entry.version).toBe("fixbot.learning/v1");
		expect(entry.jobId).toBe("job-1");
		expect(entry.taskClass).toBe("fix_ci");
		expect(entry.status).toBe("success");
		expect(entry.errorCategory).toBeNull();
		expect(entry.summary).toBe("Fixed the CI build.");
		expect(entry.durationMs).toBe(120000);
	});

	it("truncates summary exceeding 200 chars", () => {
		const longSummary = "A".repeat(250);
		const result = makeResult({ summary: longSummary });
		const entry = buildLearningEntry(result);
		expect(entry.summary.length).toBe(200);
		expect(entry.summary).toEndWith("...");
	});

	it("preserves summary at exactly 200 chars", () => {
		const exactSummary = "B".repeat(200);
		const result = makeResult({ summary: exactSummary });
		const entry = buildLearningEntry(result);
		expect(entry.summary).toBe(exactSummary);
	});
});

// ---------------------------------------------------------------------------
// appendLearning / readLearnings
// ---------------------------------------------------------------------------

describe("appendLearning / readLearnings", () => {
	const testRepoUrl = `https://github.com/fixbot-test-${Date.now()}/learnings-test.git`;

	afterEach(() => cleanupRepoDir(testRepoUrl));

	it("reads empty array when no file exists", () => {
		const uniqueUrl = `https://github.com/nonexistent-${Date.now()}/repo.git`;
		const entries = readLearnings(uniqueUrl);
		expect(entries).toEqual([]);
		cleanupRepoDir(uniqueUrl);
	});

	it("appends and reads back entries", () => {
		const entry1 = makeEntry({ jobId: "j1" });
		const entry2 = makeEntry({ jobId: "j2", status: "failed", errorCategory: "timeout" });

		appendLearning(testRepoUrl, entry1);
		appendLearning(testRepoUrl, entry2);

		const entries = readLearnings(testRepoUrl);
		expect(entries).toHaveLength(2);
		expect(entries[0].jobId).toBe("j1");
		expect(entries[1].jobId).toBe("j2");
		expect(entries[1].errorCategory).toBe("timeout");
	});
});

// ---------------------------------------------------------------------------
// rotateLearnings
// ---------------------------------------------------------------------------

describe("rotateLearnings", () => {
	const testRepoUrl = `https://github.com/fixbot-test-${Date.now()}/rotate-test.git`;

	afterEach(() => cleanupRepoDir(testRepoUrl));

	it("does nothing when under limit", () => {
		for (let i = 0; i < 5; i++) {
			appendLearning(testRepoUrl, makeEntry({ jobId: `j${i}` }));
		}
		rotateLearnings(testRepoUrl);
		expect(readLearnings(testRepoUrl)).toHaveLength(5);
	});

	it("trims to 100 entries when over limit", () => {
		for (let i = 0; i < 105; i++) {
			appendLearning(testRepoUrl, makeEntry({ jobId: `j${i}` }));
		}
		expect(readLearnings(testRepoUrl)).toHaveLength(105);
		rotateLearnings(testRepoUrl);
		const after = readLearnings(testRepoUrl);
		expect(after).toHaveLength(100);
		// Should keep the most recent (last 100)
		expect(after[0].jobId).toBe("j5");
		expect(after[99].jobId).toBe("j104");
	});
});

// ---------------------------------------------------------------------------
// detectPatterns
// ---------------------------------------------------------------------------

describe("detectPatterns", () => {
	it("returns empty for fewer than 2 entries", () => {
		expect(detectPatterns([makeEntry()])).toEqual([]);
		expect(detectPatterns([])).toEqual([]);
	});

	it("flags majority failures", () => {
		const entries = [
			makeEntry({ status: "failed", errorCategory: "unknown" }),
			makeEntry({ status: "failed", errorCategory: "unknown" }),
			makeEntry({ status: "success" }),
		];
		const patterns = detectPatterns(entries);
		expect(patterns.some((p) => p.message.includes("2/3 recent jobs failed"))).toBe(true);
	});

	it("flags recurring error category", () => {
		const entries = [
			makeEntry({ status: "failed", errorCategory: "auth_error" }),
			makeEntry({ status: "failed", errorCategory: "auth_error" }),
			makeEntry({ status: "failed", errorCategory: "auth_error" }),
			makeEntry({ status: "success" }),
		];
		const patterns = detectPatterns(entries);
		expect(patterns.some((p) => p.message.includes("Recurring auth_error"))).toBe(true);
	});

	it("flags slowing trend", () => {
		const entries = [
			makeEntry({ durationMs: 60000 }),
			makeEntry({ durationMs: 60000 }),
			makeEntry({ durationMs: 180000 }),
			makeEntry({ durationMs: 180000 }),
		];
		const patterns = detectPatterns(entries);
		expect(patterns.some((p) => p.message.includes("trending slower"))).toBe(true);
	});

	it("does not flag when durations are similar", () => {
		const entries = [
			makeEntry({ durationMs: 60000 }),
			makeEntry({ durationMs: 60000 }),
			makeEntry({ durationMs: 65000 }),
			makeEntry({ durationMs: 70000 }),
		];
		const patterns = detectPatterns(entries);
		expect(patterns.some((p) => p.message.includes("trending slower"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// formatLearningsContext
// ---------------------------------------------------------------------------

describe("formatLearningsContext", () => {
	const testRepoUrl = `https://github.com/fixbot-test-${Date.now()}/format-test.git`;

	afterEach(() => cleanupRepoDir(testRepoUrl));

	it("returns undefined when no learnings exist", () => {
		const uniqueUrl = `https://github.com/fixbot-test-${Date.now()}/empty.git`;
		const result = formatLearningsContext(uniqueUrl);
		expect(result).toBeUndefined();
		cleanupRepoDir(uniqueUrl);
	});

	it("formats recent entries as markdown", () => {
		appendLearning(testRepoUrl, makeEntry({ jobId: "j1", summary: "Fixed CI" }));
		appendLearning(
			testRepoUrl,
			makeEntry({ jobId: "j2", status: "failed", errorCategory: "timeout", summary: "Timed out" }),
		);

		const context = formatLearningsContext(testRepoUrl);
		expect(context).toBeDefined();
		expect(context!).toContain("## Recent Job History");
		expect(context!).toContain("OK fix_ci");
		expect(context!).toContain("FAIL fix_ci");
		expect(context!).toContain("[timeout]");
	});
});

// ---------------------------------------------------------------------------
// recordLearning
// ---------------------------------------------------------------------------

describe("recordLearning", () => {
	const testRepoUrl = `https://github.com/fixbot-test-${Date.now()}/record-test.git`;

	afterEach(() => cleanupRepoDir(testRepoUrl));

	it("records a learning entry safely", () => {
		const result = makeResult({ repo: { url: testRepoUrl, baseBranch: "main" } });
		recordLearning(result);
		const entries = readLearnings(testRepoUrl);
		expect(entries).toHaveLength(1);
		expect(entries[0].jobId).toBe("job-1");
	});

	it("does not throw when recording succeeds with a logger attached", () => {
		const warnings: string[] = [];
		const logger = { warn: (msg: string) => warnings.push(msg) };

		const result = makeResult({ repo: { url: testRepoUrl, baseBranch: "main" } });
		// Should not throw
		expect(() => recordLearning(result, logger)).not.toThrow();
		// No warnings expected on success
		expect(warnings).toHaveLength(0);
	});
});
