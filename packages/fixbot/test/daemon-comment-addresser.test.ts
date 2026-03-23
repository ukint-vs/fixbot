import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { deriveCommentJobId, addressComments } from "../src/daemon/comment-addresser";
import { registerPR, loadPRTracker, type PRCommentPollResult, type PRReviewComment } from "../src/daemon/comment-poller";
import type { NormalizedDaemonConfigV1, JobResultV1 } from "../src/types";
import type { DaemonJobRunner } from "../src/daemon/service";

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
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

function makeConfig(overrides?: Partial<NormalizedDaemonConfigV1>): NormalizedDaemonConfigV1 {
	return {
		version: "fixbot.daemon-config/v1",
		paths: {
			stateDir: testDir,
			resultsDir: join(testDir, "results"),
			statusFile: join(testDir, "status.json"),
			pidFile: join(testDir, "daemon.pid"),
			lockFile: join(testDir, "daemon.lock"),
		},
		status: { format: "json", file: join(testDir, "status.json"), pretty: false },
		runtime: { heartbeatIntervalMs: 30_000, idleSleepMs: 1_000 },
		github: {
			repos: [],
			token: "fake-token",
			pollIntervalMs: 60_000,
			botUsername: "fixbot",
		},
		identity: { botUrl: "https://example.com/fixbot" },
		...overrides,
	};
}

function makeComments(): PRReviewComment[] {
	return [
		{
			id: 100,
			body: "Please fix the indentation here",
			user: "alice",
			path: "src/main.ts",
			line: 42,
			createdAt: "2024-01-01T00:00:00Z",
		},
		{
			id: 101,
			body: "This variable name is confusing",
			user: "bob",
			path: "src/utils.ts",
			line: 10,
			createdAt: "2024-01-01T00:01:00Z",
		},
	];
}

beforeEach(() => {
	testDir = join(tmpdir(), `fixbot-test-comment-addr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
	mkdirSync(join(testDir, "results"), { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deriveCommentJobId", () => {
	it("produces a deterministic gh-comment- prefixed ID", () => {
		const id1 = deriveCommentJobId("owner", "repo", 42, 1);
		const id2 = deriveCommentJobId("owner", "repo", 42, 1);
		expect(id1).toBe(id2);
		expect(id1).toMatch(/^gh-comment-[a-f0-9]{16}$/);
	});

	it("different inputs produce different IDs", () => {
		const id1 = deriveCommentJobId("owner", "repo", 42, 1);
		const id2 = deriveCommentJobId("owner", "repo", 42, 2);
		expect(id1).not.toBe(id2);
	});

	it("different PRs produce different IDs", () => {
		const id1 = deriveCommentJobId("owner", "repo", 42, 1);
		const id2 = deriveCommentJobId("owner", "repo", 43, 1);
		expect(id1).not.toBe(id2);
	});
});

describe("addressComments", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns error when no token is configured", async () => {
		const config = makeConfig({ github: undefined });
		registerPR(testDir, {
			owner: "owner",
			repo: "repo",
			prNumber: 10,
			headBranch: "fixbot/gh-abc",
			baseBranch: "main",
			repoUrl: "owner/repo",
			jobId: "gh-abc",
		});

		const entry = loadPRTracker(testDir).entries[0];
		const pollResult: PRCommentPollResult = {
			entry,
			comments: makeComments(),
			hasMore: false,
		};

		const mockRunner: DaemonJobRunner = mock(async () => ({} as JobResultV1));
		const result = await addressComments({
			config,
			pollResult,
			jobRunner: mockRunner,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("no GitHub token");
		expect(result.addressedCount).toBe(0);
	});

	it("advances cursor even when clone fails", async () => {
		const config = makeConfig();
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
				urlPattern: "/user",
				response: { status: 200, body: { login: "fixbot", id: 123, name: "Fixbot" } },
			},
		]);

		const entry = loadPRTracker(testDir).entries[0];
		const comments = makeComments();
		const pollResult: PRCommentPollResult = {
			entry,
			comments,
			hasMore: false,
		};

		const mockRunner: DaemonJobRunner = mock(async () => ({} as JobResultV1));
		const result = await addressComments({
			config,
			pollResult,
			jobRunner: mockRunner,
		});

		// Clone will fail since there's no real git repo, but cursor should advance
		expect(result.success).toBe(false);

		const state = loadPRTracker(testDir);
		expect(state.entries[0].lastProcessedCommentId).toBe(101);
		expect(state.entries[0].cycleCount).toBe(1);
	});
});
