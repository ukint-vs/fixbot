import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	buildGitHubJobSpec,
	deriveGitHubJobId,
	type GitHubEnqueueFn,
	parseGitHubRepoPath,
	pollGitHubRepos,
} from "../src/daemon/github-poller";
import { DuplicateDaemonJobError } from "../src/daemon/job-store";
import type { DaemonJobEnvelopeV1, NormalizedDaemonGitHubConfig } from "../src/types";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

type MockRoute = { urlPattern: string; method?: string; response: { status: number; body: unknown } };

function createMockFetch(routes: MockRoute[]): typeof globalThis.fetch {
	return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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

const BASE_CONFIG: NormalizedDaemonGitHubConfig = {
	repos: [
		{
			url: "https://github.com/owner/repo",
			baseBranch: "main",
			triggerLabel: "fixbot",
		},
	],
	token: "fake-token",
	pollIntervalMs: 60_000,
};

const RESULTS_DIR = "/tmp/fixbot-test-results";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseGitHubRepoPath", () => {
	it("handles plain https URL", () => {
		expect(parseGitHubRepoPath("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("handles URL with .git suffix", () => {
		expect(parseGitHubRepoPath("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("handles URL with trailing slash", () => {
		expect(parseGitHubRepoPath("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("handles URL with .git and trailing slash", () => {
		// .git before trailing slash — strip trailing slash first then .git
		expect(parseGitHubRepoPath("https://github.com/owner/repo.git/")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("throws on invalid URL with too many segments", () => {
		expect(() => parseGitHubRepoPath("https://github.com/a/b/c")).toThrow("exactly owner/repo");
	});

	it("throws on invalid URL with too few segments", () => {
		expect(() => parseGitHubRepoPath("https://github.com/owner")).toThrow("exactly owner/repo");
	});

	it("throws on non-URL string", () => {
		expect(() => parseGitHubRepoPath("not-a-url")).toThrow("Invalid GitHub repo URL");
	});
});

describe("deriveGitHubJobId", () => {
	it("produces a deterministic gh- prefixed ID", () => {
		const id = deriveGitHubJobId("https://github.com/owner/repo", 42, "fixbot");
		const expectedHex = createHash("sha256")
			.update("https://github.com/owner/repo/42/fixbot")
			.digest("hex")
			.slice(0, 16);
		expect(id).toBe(`gh-${expectedHex}`);
	});

	it("different inputs produce different IDs", () => {
		const id1 = deriveGitHubJobId("https://github.com/a/b", 1, "fix");
		const id2 = deriveGitHubJobId("https://github.com/a/b", 2, "fix");
		expect(id1).not.toBe(id2);
	});
});

describe("buildGitHubJobSpec", () => {
	it("returns a normalized job spec with fix_ci task class", () => {
		const spec = buildGitHubJobSpec("https://github.com/owner/repo", "main", 10, 12345, "fixbot");
		expect(spec.version).toBe("fixbot.job/v1");
		expect(spec.taskClass).toBe("fix_ci");
		expect(spec.repo.url).toBe("https://github.com/owner/repo");
		expect(spec.repo.baseBranch).toBe("main");
		expect(spec.fixCi!.githubActionsRunId).toBe(12345);
		expect(spec.execution.mode).toBe("process");
		expect(spec.execution.timeoutMs).toBe(600_000);
		expect(spec.execution.memoryLimitMb).toBe(4096);
		expect(spec.jobId).toMatch(/^gh-[a-f0-9]{16}$/);
	});
});

describe("pollGitHubRepos", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});

	it("enqueues one job for a labeled issue with a failing run", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 200, body: [{ number: 7, title: "CI broken" }] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/7/comments",
				method: "GET",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/actions/runs",
				response: { status: 200, body: { workflow_runs: [{ id: 99001 }] } },
			},
			{
				urlPattern: "/repos/owner/repo/issues/7/comments",
				method: "POST",
				response: { status: 201, body: {} },
			},
		]);

		const enqueued: DaemonJobEnvelopeV1[] = [];
		const enqueueFn: GitHubEnqueueFn = (envelope) => enqueued.push(envelope);

		const result = await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, enqueueFn);

		expect(result.enqueued).toHaveLength(1);
		expect(result.skipped).toBe(0);
		expect(result.errors).toBe(0);
		expect(enqueued).toHaveLength(1);

		const envelope = enqueued[0];
		expect(envelope.submission.kind).toBe("github-label");
		expect(envelope.submission.githubRepo).toBe("owner/repo");
		expect(envelope.submission.githubIssueNumber).toBe(7);
		expect(envelope.submission.githubActionsRunId).toBe(99001);
		expect(envelope.job.taskClass).toBe("fix_ci");
		expect(envelope.job.fixCi!.githubActionsRunId).toBe(99001);
	});

	it("second poll with ack comment skips re-enqueue", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 200, body: [{ number: 7, title: "CI broken" }] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/7/comments",
				method: "GET",
				response: {
					status: 200,
					body: [{ body: "<!-- fixbot-ack -->\n🤖 fixbot job `gh-abc123` has been queued." }],
				},
			},
		]);

		const enqueueFn = mock(() => undefined) as unknown as GitHubEnqueueFn;
		const result = await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, enqueueFn);

		expect(enqueueFn).not.toHaveBeenCalled();
		expect(result.skipped).toBe(1);
		expect(result.enqueued).toHaveLength(0);
	});

	it("no failing run skips with zero enqueue", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 200, body: [{ number: 7, title: "CI broken" }] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/7/comments",
				method: "GET",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/actions/runs",
				response: { status: 200, body: { workflow_runs: [] } },
			},
		]);

		const enqueueFn = mock(() => undefined) as unknown as GitHubEnqueueFn;
		const result = await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, enqueueFn);

		expect(enqueueFn).not.toHaveBeenCalled();
		expect(result.skipped).toBe(1);
		expect(result.enqueued).toHaveLength(0);
	});

	it("DuplicateDaemonJobError is caught as skip", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 200, body: [{ number: 7, title: "CI broken" }] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/7/comments",
				method: "GET",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/actions/runs",
				response: { status: 200, body: { workflow_runs: [{ id: 99001 }] } },
			},
		]);

		const enqueueFn: GitHubEnqueueFn = () => {
			throw new DuplicateDaemonJobError("gh-test", [{ kind: "queue", path: "/fake" }]);
		};

		const result = await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, enqueueFn);

		expect(result.skipped).toBe(1);
		expect(result.errors).toBe(0);
		expect(result.enqueued).toHaveLength(0);
	});

	it("non-200 GitHub API response returns empty and does not throw", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 403, body: { message: "rate limited" } },
			},
		]);

		const enqueueFn = mock(() => undefined) as unknown as GitHubEnqueueFn;
		const logs: string[] = [];
		const result = await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, enqueueFn, (msg) => logs.push(msg));

		expect(enqueueFn).not.toHaveBeenCalled();
		expect(result.enqueued).toHaveLength(0);
		expect(result.errors).toBe(0);
		expect(logs.some((l) => l.includes("403"))).toBe(true);
	});

	it("logs summary line with repo/enqueued/skipped/error counts", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 200, body: [] },
			},
		]);

		const enqueueFn = mock(() => undefined) as unknown as GitHubEnqueueFn;
		const logs: string[] = [];
		await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, enqueueFn, (msg) => logs.push(msg));

		expect(logs.some((l) => l.includes("github-poll repos=1 enqueued=0 skipped=0 errors=0"))).toBe(true);
	});

	it("github token never appears in log output", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 500, body: { message: "server error" } },
			},
		]);

		const logs: string[] = [];
		await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, mock(() => undefined), (msg) => logs.push(msg));

		for (const log of logs) {
			expect(log).not.toContain("fake-token");
		}
	});

	it("config with taskClassOverrides enqueues fix_lint job for fixbot:lint label", async () => {
		const config: NormalizedDaemonGitHubConfig = {
			repos: [
				{
					url: "https://github.com/owner/repo",
					baseBranch: "main",
					triggerLabel: "fixbot",
					taskClassOverrides: { "fixbot:lint": "fix_lint" },
				},
			],
			token: "fake-token",
			pollIntervalMs: 60_000,
		};

		globalThis.fetch = createMockFetch([
			// "fixbot:lint" label has one issue — must come before "fixbot" route to avoid substring match
			{
				urlPattern: "labels=fixbot%3Alint",
				response: { status: 200, body: [{ number: 10, title: "Lint issues" }] },
			},
			// triggerLabel "fixbot" has no issues
			{
				urlPattern: "labels=fixbot&",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				method: "GET",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/10/comments",
				method: "POST",
				response: { status: 201, body: {} },
			},
		]);

		const enqueued: DaemonJobEnvelopeV1[] = [];
		const enqueueFn: GitHubEnqueueFn = (envelope) => enqueued.push(envelope);

		const result = await pollGitHubRepos(config, RESULTS_DIR, enqueueFn);

		expect(result.enqueued).toHaveLength(1);
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].job.taskClass).toBe("fix_lint");
		expect(enqueued[0].job.fixCi).toBeUndefined();
		expect(enqueued[0].submission.githubLabelName).toBe("fixbot:lint");
	});

	it("fix_lint job from poller does not include fixCi field", async () => {
		const config: NormalizedDaemonGitHubConfig = {
			repos: [
				{
					url: "https://github.com/owner/repo",
					baseBranch: "main",
					triggerLabel: "fixbot",
					taskClassOverrides: { "fixbot:lint": "fix_lint" },
				},
			],
			token: "fake-token",
			pollIntervalMs: 60_000,
		};

		globalThis.fetch = createMockFetch([
			{
				urlPattern: "labels=fixbot%3Alint",
				response: { status: 200, body: [{ number: 11, title: "Fix lint" }] },
			},
			{
				urlPattern: "labels=fixbot&",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/11/comments",
				method: "GET",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/11/comments",
				method: "POST",
				response: { status: 201, body: {} },
			},
		]);

		const enqueued: DaemonJobEnvelopeV1[] = [];
		const enqueueFn: GitHubEnqueueFn = (envelope) => enqueued.push(envelope);

		await pollGitHubRepos(config, RESULTS_DIR, enqueueFn);

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].job.fixCi).toBeUndefined();
		expect(enqueued[0].submission.githubActionsRunId).toBeUndefined();
	});

	it("triggerLabel without override still produces fix_ci (backward compat)", async () => {
		// Uses BASE_CONFIG which has no taskClassOverrides
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 200, body: [{ number: 7, title: "CI broken" }] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/7/comments",
				method: "GET",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "/repos/owner/repo/actions/runs",
				response: { status: 200, body: { workflow_runs: [{ id: 99001 }] } },
			},
			{
				urlPattern: "/repos/owner/repo/issues/7/comments",
				method: "POST",
				response: { status: 201, body: {} },
			},
		]);

		const enqueued: DaemonJobEnvelopeV1[] = [];
		const enqueueFn: GitHubEnqueueFn = (envelope) => enqueued.push(envelope);

		const result = await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, enqueueFn);

		expect(result.enqueued).toHaveLength(1);
		expect(enqueued[0].job.taskClass).toBe("fix_ci");
		expect(enqueued[0].job.fixCi).toBeDefined();
	});
});
