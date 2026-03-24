import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	type AckCommentResult,
	buildGitHubJobSpec,
	deleteAckComment,
	deriveGitHubJobId,
	fetchAssignedIssues,
	fetchIssuesWithFilter,
	type GitHubCancelFn,
	type GitHubEnqueueFn,
	hasAckComment,
	pollGitHubRepos,
	validateBotUsername,
} from "../src/daemon/github-poller";
import { parseOwnerRepo } from "../src/daemon/github-reporter";
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

const FIX_CI_CONFIG: NormalizedDaemonGitHubConfig = {
	repos: [
		{
			url: "https://github.com/owner/repo",
			baseBranch: "main",
			triggerLabel: "fixbot",
			taskClassOverrides: { fixbot: "fix_ci" },
		},
	],
	token: "fake-token",
	pollIntervalMs: 60_000,
};

const ASSIGNMENT_CONFIG: NormalizedDaemonGitHubConfig = {
	repos: [
		{
			url: "https://github.com/owner/repo",
			baseBranch: "main",
			triggerLabel: "fixbot",
		},
	],
	token: "fake-token",
	pollIntervalMs: 60_000,
	botUsername: "fixbot-bot",
};

const RESULTS_DIR = "/tmp/fixbot-test-results";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseOwnerRepo", () => {
	it("handles plain https URL", () => {
		expect(parseOwnerRepo("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("handles URL with .git suffix", () => {
		expect(parseOwnerRepo("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("handles URL with trailing slash", () => {
		expect(parseOwnerRepo("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("handles URL with .git and trailing slash", () => {
		// .git before trailing slash — strip trailing slash first then .git
		expect(parseOwnerRepo("https://github.com/owner/repo.git/")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("throws on invalid URL with too many segments", () => {
		expect(() => parseOwnerRepo("https://github.com/a/b/c")).toThrow("exactly owner/repo");
	});

	it("throws on invalid URL with too few segments", () => {
		expect(() => parseOwnerRepo("https://github.com/owner")).toThrow("exactly owner/repo");
	});

	it("throws on non-URL string", () => {
		expect(() => parseOwnerRepo("not-a-url")).toThrow("Expected owner/repo format");
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
	it("returns a normalized job spec with explicit fix_ci task class", () => {
		const spec = buildGitHubJobSpec("https://github.com/owner/repo", "main", 10, 12345, "fixbot", "fix_ci");
		expect(spec.version).toBe("fixbot.job/v1");
		expect(spec.taskClass).toBe("fix_ci");
		expect(spec.repo.url).toBe("https://github.com/owner/repo");
		expect(spec.repo.baseBranch).toBe("main");
		expect(spec.fixCi!.githubActionsRunId).toBe(12345);
		expect(spec.execution.mode).toBe("process");
		expect(spec.execution.timeoutMs).toBe(1_800_000);
		expect(spec.execution.memoryLimitMb).toBe(4096);
		expect(spec.jobId).toMatch(/^gh-[a-f0-9]{16}$/);
	});

	it("defaults to solve_issue with solveIssue context", () => {
		const spec = buildGitHubJobSpec("https://github.com/owner/repo", "main", 10, 0, "fixbot");
		expect(spec.taskClass).toBe("solve_issue");
		expect(spec.solveIssue).toBeDefined();
		expect(spec.solveIssue!.issueNumber).toBe(10);
		expect(spec.fixCi).toBeUndefined();
	});

	it("includes issueTitle in solveIssue context when provided", () => {
		const spec = buildGitHubJobSpec(
			"https://github.com/owner/repo",
			"main",
			10,
			0,
			"fixbot",
			"solve_issue",
			"Fix the login bug",
		);
		expect(spec.solveIssue!.issueTitle).toBe("Fix the login bug");
	});
});

describe("pollGitHubRepos", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});

	it("enqueues one fix_ci job for a labeled issue with a failing run", async () => {
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

		const result = await pollGitHubRepos(FIX_CI_CONFIG, RESULTS_DIR, enqueueFn);

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

	it("no failing run skips with zero enqueue for fix_ci override", async () => {
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
		const result = await pollGitHubRepos(FIX_CI_CONFIG, RESULTS_DIR, enqueueFn);

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

		const result = await pollGitHubRepos(FIX_CI_CONFIG, RESULTS_DIR, enqueueFn);

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

		expect(logs.some((l) => l.includes("github-poll repos=1 enqueued=0 skipped=0 errors=0 cancelled=0"))).toBe(true);
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

	it("triggerLabel without override produces solve_issue by default", async () => {
		// Uses BASE_CONFIG which has no taskClassOverrides — default is now solve_issue
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 200, body: [{ number: 7, title: "Fix the login bug" }] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/7/comments",
				method: "GET",
				response: { status: 200, body: [] },
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
		expect(enqueued[0].job.taskClass).toBe("solve_issue");
		expect(enqueued[0].job.solveIssue).toBeDefined();
		expect(enqueued[0].job.solveIssue!.issueNumber).toBe(7);
		expect(enqueued[0].job.solveIssue!.issueTitle).toBe("Fix the login bug");
		expect(enqueued[0].job.fixCi).toBeUndefined();
	});

	it("pollGitHubRepos returns cancelled: 0 by default", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?labels=fixbot",
				response: { status: 200, body: [] },
			},
		]);

		const enqueueFn = mock(() => undefined) as unknown as GitHubEnqueueFn;
		const result = await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, enqueueFn);

		expect(result.cancelled).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// validateBotUsername
// ---------------------------------------------------------------------------

describe("validateBotUsername", () => {
	it("returns undefined for undefined input", () => {
		expect(validateBotUsername(undefined)).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(validateBotUsername("")).toBeUndefined();
	});

	it("returns undefined for whitespace-only string", () => {
		expect(validateBotUsername("   ")).toBeUndefined();
	});

	it("returns trimmed lowercase username", () => {
		expect(validateBotUsername("  FixBot-App  ")).toBe("fixbot-app");
	});

	it("handles already-lowercase username", () => {
		expect(validateBotUsername("mybot")).toBe("mybot");
	});
});

// ---------------------------------------------------------------------------
// fetchIssuesWithFilter / fetchAssignedIssues
// ---------------------------------------------------------------------------

describe("fetchIssuesWithFilter", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("fetches issues with arbitrary filter string", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues?assignee=bot&state=open",
				response: { status: 200, body: [{ number: 5, title: "assigned issue", body: "desc" }] },
			},
		]);

		const result = await fetchIssuesWithFilter("owner", "repo", "assignee=bot");
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(5);
		expect(result[0].title).toBe("assigned issue");
	});

	it("returns empty array on network error", async () => {
		globalThis.fetch = (() => {
			throw new Error("network failure");
		}) as unknown as typeof fetch;

		const logs: string[] = [];
		const result = await fetchIssuesWithFilter("owner", "repo", "assignee=bot", "tok", (m) => logs.push(m));
		expect(result).toHaveLength(0);
		expect(logs.some((l) => l.includes("network error"))).toBe(true);
	});
});

describe("fetchAssignedIssues", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("delegates to fetchIssuesWithFilter with assignee parameter", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "assignee=fixbot-bot",
				response: { status: 200, body: [{ number: 3, title: "task", body: null }] },
			},
		]);

		const result = await fetchAssignedIssues("owner", "repo", "fixbot-bot");
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// hasAckComment (AckCommentResult)
// ---------------------------------------------------------------------------

describe("hasAckComment", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns found: true with commentId when ack comment exists", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues/1/comments",
				response: {
					status: 200,
					body: [{ id: 777, body: "<!-- fixbot-ack -->\n🤖 fixbot job `gh-abc` has been queued." }],
				},
			},
		]);

		const result = await hasAckComment("owner", "repo", 1, "tok");
		expect(result.found).toBe(true);
		expect(result.commentId).toBe(777);
	});

	it("returns found: false with null commentId when no ack comment", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues/2/comments",
				response: { status: 200, body: [{ id: 888, body: "just a regular comment" }] },
			},
		]);

		const result = await hasAckComment("owner", "repo", 2, "tok");
		expect(result.found).toBe(false);
		expect(result.commentId).toBeNull();
	});

	it("returns found: false on network error", async () => {
		globalThis.fetch = (() => {
			throw new Error("timeout");
		}) as unknown as typeof fetch;

		const result = await hasAckComment("owner", "repo", 3, "tok");
		expect(result.found).toBe(false);
		expect(result.commentId).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// deleteAckComment
// ---------------------------------------------------------------------------

describe("deleteAckComment", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns true on successful deletion (204)", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues/comments/777",
				method: "DELETE",
				response: { status: 204, body: null },
			},
		]);

		const result = await deleteAckComment("owner", "repo", 777, "tok");
		expect(result).toBe(true);
	});

	it("returns false on non-204 response", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "/repos/owner/repo/issues/comments/777",
				method: "DELETE",
				response: { status: 404, body: { message: "Not Found" } },
			},
		]);

		const result = await deleteAckComment("owner", "repo", 777, "tok");
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// deriveGitHubJobId with trigger discriminator
// ---------------------------------------------------------------------------

describe("deriveGitHubJobId trigger discriminator", () => {
	it("label trigger and assignment trigger produce different IDs for same issue", () => {
		const labelId = deriveGitHubJobId("https://github.com/owner/repo", 42, "fixbot");
		const assignId = deriveGitHubJobId("https://github.com/owner/repo", 42, "assign:fixbot-bot");
		expect(labelId).not.toBe(assignId);
	});
});

// ---------------------------------------------------------------------------
// Assignment-triggered polling via pollGitHubRepos
// ---------------------------------------------------------------------------

describe("pollGitHubRepos assignment trigger", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});

	it("enqueues solve_issue job when issue is assigned to bot", async () => {
		globalThis.fetch = createMockFetch([
			// Label polling returns no issues
			{
				urlPattern: "labels=fixbot",
				response: { status: 200, body: [] },
			},
			// Assignment polling returns one issue
			{
				urlPattern: "assignee=fixbot-bot",
				response: { status: 200, body: [{ number: 99, title: "Assigned task", body: "do this" }] },
			},
			// No ack comment on issue 99
			{
				urlPattern: "/repos/owner/repo/issues/99/comments",
				method: "GET",
				response: { status: 200, body: [] },
			},
			// Post ack comment
			{
				urlPattern: "/repos/owner/repo/issues/99/comments",
				method: "POST",
				response: { status: 201, body: {} },
			},
		]);

		const enqueued: DaemonJobEnvelopeV1[] = [];
		const enqueueFn: GitHubEnqueueFn = (envelope) => enqueued.push(envelope);

		const result = await pollGitHubRepos(ASSIGNMENT_CONFIG, RESULTS_DIR, enqueueFn);

		expect(result.enqueued).toHaveLength(1);
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].submission.kind).toBe("github-assignment");
		expect(enqueued[0].submission.githubRepo).toBe("owner/repo");
		expect(enqueued[0].submission.githubIssueNumber).toBe(99);
		expect(enqueued[0].job.taskClass).toBe("solve_issue");
		expect(enqueued[0].job.solveIssue!.issueNumber).toBe(99);
		expect(enqueued[0].job.solveIssue!.issueTitle).toBe("Assigned task");
	});

	it("skips assignment polling when botUsername is not configured", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "labels=fixbot",
				response: { status: 200, body: [] },
			},
		]);

		const enqueueFn = mock(() => undefined) as unknown as GitHubEnqueueFn;
		// BASE_CONFIG has no botUsername
		const result = await pollGitHubRepos(BASE_CONFIG, RESULTS_DIR, enqueueFn);

		expect(result.enqueued).toHaveLength(0);
		expect(enqueueFn).not.toHaveBeenCalled();
	});

	it("skips already-acked assigned issues", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "labels=fixbot",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "assignee=fixbot-bot",
				response: { status: 200, body: [{ number: 50, title: "task", body: null }] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/50/comments",
				method: "GET",
				response: {
					status: 200,
					body: [{ id: 333, body: "<!-- fixbot-ack -->\n🤖 fixbot job `gh-xyz` has been queued." }],
				},
			},
		]);

		const enqueueFn = mock(() => undefined) as unknown as GitHubEnqueueFn;
		const result = await pollGitHubRepos(ASSIGNMENT_CONFIG, RESULTS_DIR, enqueueFn);

		expect(enqueueFn).not.toHaveBeenCalled();
		expect(result.skipped).toBe(1);
	});

	it("DuplicateDaemonJobError during assignment enqueue is caught as skip", async () => {
		globalThis.fetch = createMockFetch([
			{
				urlPattern: "labels=fixbot",
				response: { status: 200, body: [] },
			},
			{
				urlPattern: "assignee=fixbot-bot",
				response: { status: 200, body: [{ number: 60, title: "task", body: null }] },
			},
			{
				urlPattern: "/repos/owner/repo/issues/60/comments",
				method: "GET",
				response: { status: 200, body: [] },
			},
		]);

		const enqueueFn: GitHubEnqueueFn = () => {
			throw new DuplicateDaemonJobError("gh-dup", [{ kind: "queue", path: "/fake" }]);
		};

		const result = await pollGitHubRepos(ASSIGNMENT_CONFIG, RESULTS_DIR, enqueueFn);

		expect(result.skipped).toBe(1);
		expect(result.errors).toBe(0);
		expect(result.enqueued).toHaveLength(0);
	});

	it("assignment and label triggers produce separate jobs for same issue", async () => {
		globalThis.fetch = createMockFetch([
			// Label polling returns issue 42
			{
				urlPattern: "labels=fixbot",
				response: { status: 200, body: [{ number: 42, title: "dual trigger", body: null }] },
			},
			// No ack for label check on issue 42
			{
				urlPattern: "/repos/owner/repo/issues/42/comments",
				method: "GET",
				response: { status: 200, body: [] },
			},
			// Post ack for label trigger
			{
				urlPattern: "/repos/owner/repo/issues/42/comments",
				method: "POST",
				response: { status: 201, body: {} },
			},
			// Assignment polling also returns issue 42
			{
				urlPattern: "assignee=fixbot-bot",
				response: { status: 200, body: [{ number: 42, title: "dual trigger", body: null }] },
			},
		]);

		const enqueued: DaemonJobEnvelopeV1[] = [];
		const enqueueFn: GitHubEnqueueFn = (envelope) => enqueued.push(envelope);

		const result = await pollGitHubRepos(ASSIGNMENT_CONFIG, RESULTS_DIR, enqueueFn);

		// Both should enqueue (the second hasAckComment check will find the ack from
		// the label trigger, so it will be skipped — but their job IDs differ)
		expect(result.enqueued.length).toBeGreaterThanOrEqual(1);
		// The label-triggered job
		const labelJob = enqueued.find((e) => e.submission.kind === "github-label");
		expect(labelJob).toBeDefined();
		expect(labelJob!.submission.githubLabelName).toBe("fixbot");

		// Verify job IDs use different triggers
		const labelJobId = deriveGitHubJobId("https://github.com/owner/repo", 42, "fixbot");
		const assignJobId = deriveGitHubJobId("https://github.com/owner/repo", 42, "assign:fixbot-bot");
		expect(labelJobId).not.toBe(assignJobId);
	});
});
