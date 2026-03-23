import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	fetchNewPRComments,
	loadPRTracker,
	markCycleComplete,
	markPRBlocked,
	pollPRComments,
	registerPR,
	sanitizeCommentBody,
	savePRTracker,
} from "../src/daemon/comment-poller";
import type { PRTrackerState } from "../src/types";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

type MockRoute = {
	urlPattern: string;
	method?: string;
	response: { status: number; body: unknown };
};

function createMockFetch(routes: MockRoute[]): typeof globalThis.fetch {
	return (async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const method = init?.method ?? "GET";

		for (const route of routes) {
			if (url.includes(route.urlPattern) && (route.method ?? "GET") === method) {
				return new Response(JSON.stringify(route.response.body), {
					status: route.response.status,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
		return new Response("Not Found", { status: 404 });
	}) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `fixbot-test-comment-poller-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// PR Tracker persistence
// ---------------------------------------------------------------------------

describe("PR Tracker persistence", () => {
	it("returns empty state when no file exists", () => {
		const state = loadPRTracker(testDir);
		expect(state.version).toBe("fixbot.pr-tracker/v1");
		expect(state.entries).toEqual([]);
	});

	it("round-trips save and load", () => {
		const state: PRTrackerState = {
			version: "fixbot.pr-tracker/v1",
			entries: [
				{
					owner: "owner",
					repo: "repo",
					prNumber: 42,
					headBranch: "fixbot/gh-abc123",
					baseBranch: "main",
					repoUrl: "owner/repo",
					jobId: "gh-abc123",
					createdAt: "2024-01-01T00:00:00Z",
					lastCheckedAt: "2024-01-01T00:00:00Z",
					lastProcessedCommentId: 0,
					cycleCount: 0,
				},
			],
		};
		savePRTracker(testDir, state);
		const loaded = loadPRTracker(testDir);
		expect(loaded.entries).toHaveLength(1);
		expect(loaded.entries[0].prNumber).toBe(42);
	});

	it("registerPR adds a new entry", () => {
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});
		const state = loadPRTracker(testDir);
		expect(state.entries).toHaveLength(1);
		expect(state.entries[0].prNumber).toBe(10);
		expect(state.entries[0].cycleCount).toBe(0);
		expect(state.entries[0].lastProcessedCommentId).toBe(0);
	});

	it("registerPR does not duplicate existing entries", () => {
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});
		const state = loadPRTracker(testDir);
		expect(state.entries).toHaveLength(1);
	});

	it("markCycleComplete advances cursor and increments cycle count", () => {
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});
		markCycleComplete(testDir, "owner", "repo", 10, 555);
		const state = loadPRTracker(testDir);
		expect(state.entries[0].lastProcessedCommentId).toBe(555);
		expect(state.entries[0].cycleCount).toBe(1);
	});

	it("markPRBlocked sets blockedAt and blockedReason", () => {
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});
		markPRBlocked(testDir, "owner", "repo", 10, "max cycles reached");
		const state = loadPRTracker(testDir);
		expect(state.entries[0].blockedAt).toBeDefined();
		expect(state.entries[0].blockedReason).toBe("max cycles reached");
	});
});

// ---------------------------------------------------------------------------
// sanitizeCommentBody
// ---------------------------------------------------------------------------

describe("sanitizeCommentBody", () => {
	it("strips HTML tags", () => {
		expect(sanitizeCommentBody("<p>Hello <b>world</b></p>")).toBe("Hello world");
	});

	it("truncates to 4000 chars", () => {
		const long = "a".repeat(5000);
		expect(sanitizeCommentBody(long).length).toBe(4000);
	});

	it("trims whitespace", () => {
		expect(sanitizeCommentBody("  hello  ")).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// fetchNewPRComments
// ---------------------------------------------------------------------------

describe("fetchNewPRComments", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("fetches and merges review + issue comments", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/pulls/10/comments",
				response: {
					status: 200,
					body: [
						{ id: 100, body: "Fix this", user: { login: "alice" }, path: "src/a.ts", line: 5, created_at: "2024-01-01T00:00:00Z" },
					],
				},
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				response: {
					status: 200,
					body: [
						{ id: 200, body: "General comment", user: { login: "bob" }, created_at: "2024-01-01T00:01:00Z" },
					],
				},
			},
		]);

		const result = await fetchNewPRComments("owner", "repo", 10, 0, "fake-token");
		expect(result.comments).toHaveLength(2);
		expect(result.comments[0].id).toBe(100);
		expect(result.comments[0].path).toBe("src/a.ts");
		expect(result.comments[1].id).toBe(200);
		expect(result.hasMore).toBe(false);
	});

	it("filters out comments with fixbot marker", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/pulls/10/comments",
				response: {
					status: 200,
					body: [
						{ id: 100, body: "<!-- fixbot-ack -->\nBot comment", user: { login: "fixbot" }, created_at: "2024-01-01T00:00:00Z" },
						{ id: 101, body: "Real review", user: { login: "alice" }, created_at: "2024-01-01T00:01:00Z" },
					],
				},
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				response: { status: 200, body: [] },
			},
		]);

		const result = await fetchNewPRComments("owner", "repo", 10, 0, "fake-token");
		expect(result.comments).toHaveLength(1);
		expect(result.comments[0].id).toBe(101);
	});

	it("filters out bot username comments", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/pulls/10/comments",
				response: {
					status: 200,
					body: [
						{ id: 100, body: "I addressed this", user: { login: "mybot" }, created_at: "2024-01-01T00:00:00Z" },
						{ id: 101, body: "Fix this please", user: { login: "alice" }, created_at: "2024-01-01T00:01:00Z" },
					],
				},
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				response: { status: 200, body: [] },
			},
		]);

		const result = await fetchNewPRComments("owner", "repo", 10, 0, "fake-token", "mybot");
		expect(result.comments).toHaveLength(1);
		expect(result.comments[0].user).toBe("alice");
	});

	it("skips comments older than sinceCommentId", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/pulls/10/comments",
				response: {
					status: 200,
					body: [
						{ id: 50, body: "Old comment", user: { login: "alice" }, created_at: "2024-01-01T00:00:00Z" },
						{ id: 101, body: "New comment", user: { login: "alice" }, created_at: "2024-01-02T00:00:00Z" },
					],
				},
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				response: { status: 200, body: [] },
			},
		]);

		const result = await fetchNewPRComments("owner", "repo", 10, 100, "fake-token");
		expect(result.comments).toHaveLength(1);
		expect(result.comments[0].id).toBe(101);
	});
});

// ---------------------------------------------------------------------------
// pollPRComments
// ---------------------------------------------------------------------------

describe("pollPRComments", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns actionable results for PRs with new comments", async () => {
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});

		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/pulls/10/comments",
				response: {
					status: 200,
					body: [
						{ id: 100, body: "Fix this", user: { login: "alice" }, path: "src/a.ts", line: 5, created_at: "2024-01-01T00:00:00Z" },
					],
				},
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				response: { status: 200, body: [] },
			},
		]);

		const result = await pollPRComments(testDir, "fake-token");
		expect(result.actionable).toHaveLength(1);
		expect(result.actionable[0].comments).toHaveLength(1);
		expect(result.skipped).toBe(0);
		expect(result.errors).toBe(0);
	});

	it("skips PRs with no new comments", async () => {
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});

		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/pulls/10/comments",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				response: { status: 200, body: [] },
			},
		]);

		const result = await pollPRComments(testDir, "fake-token");
		expect(result.actionable).toHaveLength(0);
		expect(result.skipped).toBe(1);
	});

	it("blocks PRs at max cycle count", async () => {
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});
		for (let i = 0; i < 5; i++) {
			markCycleComplete(testDir, "owner", "repo", 10, i * 100);
		}

		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/pulls/10/comments",
				response: {
					status: 200,
					body: [
						{ id: 600, body: "More changes", user: { login: "alice" }, created_at: "2024-01-01T00:00:00Z" },
					],
				},
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				response: { status: 200, body: [] },
			},
		]);

		const result = await pollPRComments(testDir, "fake-token");
		expect(result.actionable).toHaveLength(0);
		expect(result.skipped).toBe(1);

		const state = loadPRTracker(testDir);
		expect(state.entries[0].blockedAt).toBeDefined();
		expect(state.entries[0].blockedReason).toContain("max cycles");
	});

	it("skips blocked PRs without unblock phrase", async () => {
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});
		markPRBlocked(testDir, "owner", "repo", 10, "test block");

		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/pulls/10/comments",
				response: {
					status: 200,
					body: [
						{ id: 100, body: "Please fix this", user: { login: "alice" }, created_at: "2024-01-01T00:00:00Z" },
					],
				},
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				response: { status: 200, body: [] },
			},
		]);

		const result = await pollPRComments(testDir, "fake-token");
		expect(result.actionable).toHaveLength(0);
		expect(result.skipped).toBe(1);
	});

	it("unblocks PRs when unblock phrase is found", async () => {
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});
		markPRBlocked(testDir, "owner", "repo", 10, "test block");

		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/pulls/10/comments",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				response: {
					status: 200,
					body: [
						{ id: 100, body: "fixbot continue", user: { login: "alice" }, created_at: "2024-01-01T00:00:00Z" },
					],
				},
			},
		]);

		const result = await pollPRComments(testDir, "fake-token");
		expect(result.unblocked).toBe(1);

		const state = loadPRTracker(testDir);
		expect(state.entries[0].blockedAt).toBeUndefined();
	});

	it("returns empty when no tracked PRs exist", async () => {
		const result = await pollPRComments(testDir, "fake-token");
		expect(result.actionable).toHaveLength(0);
		expect(result.skipped).toBe(0);
		expect(result.errors).toBe(0);
	});
});
