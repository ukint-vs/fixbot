import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFailureCommentBody,
	buildNoPatchCommentBody,
	buildPRBody,
	buildPRTitle,
	fetchGitHubUserIdentity,
	parseOwnerRepo,
	reportJobResult,
} from "../src/daemon/github-reporter";
import type {
	DaemonJobEnvelopeV1,
	DaemonSubmissionSourceV1,
	JobResultV1,
	NormalizedDaemonConfigV1,
} from "../src/types";

// ---------------------------------------------------------------------------
// Mock spawnCommandOrThrow
// ---------------------------------------------------------------------------

mock.module("../src/command", () => ({
	spawnCommandOrThrow: mock(async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" })),
}));

mock.module("../src/git", () => ({
	configureLocalGitIdentity: mock(async () => {}),
	tryEnableGpgSigning: mock(async () => false),
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = mock((() => {}) as (...args: unknown[]) => Promise<Response>);

const originalFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
	mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSubmission(overrides: Partial<DaemonSubmissionSourceV1> = {}): DaemonSubmissionSourceV1 {
	return {
		kind: "github-label",
		githubRepo: "test-owner/test-repo",
		githubIssueNumber: 7,
		githubLabelName: "fixbot",
		githubActionsRunId: 12345,
		...overrides,
	};
}

function makeResult(overrides: Partial<JobResultV1> = {}): JobResultV1 {
	return {
		version: "fixbot.result/v1",
		jobId: "job-abc",
		taskClass: "fix_ci",
		status: "success",
		summary: "Fixed the flaky test",
		repo: { url: "https://github.com/test-owner/test-repo", baseBranch: "main" },
		fixCi: { githubActionsRunId: 12345 },
		execution: {
			mode: "process",
			timeoutMs: 600000,
			memoryLimitMb: 4096,
			sandbox: { mode: "workspace-write", networkAccess: false },
			selectedModel: { provider: "anthropic", modelId: "claude-3" },
			workspaceDir: "/tmp/workspace-test",
			baseCommit: "abc123",
			headCommit: "def456",
			startedAt: "2026-01-01T00:00:00Z",
			finishedAt: "2026-01-01T00:05:00Z",
			durationMs: 300000,
		},
		artifacts: {
			resultFile: "/tmp/results/result.json",
			rootDir: "/tmp/results",
			jobSpecFile: "/tmp/results/job-spec.json",
			patchFile: "/tmp/results/patch.diff",
			traceFile: "/tmp/results/trace.json",
			assistantFinalFile: "/tmp/results/assistant-final.md",
		},
		diagnostics: {
			patchSha256: "abc",
			changedFileCount: 2,
			markers: { result: true, summary: true, failureReason: false },
		},
		...overrides,
	};
}

function makeEnvelope(overrides: Partial<DaemonJobEnvelopeV1> = {}): DaemonJobEnvelopeV1 {
	return {
		version: "fixbot.daemon-job-envelope/v1",
		jobId: "job-abc",
		job: {
			version: "fixbot.job/v1",
			jobId: "job-abc",
			taskClass: "fix_ci",
			repo: { url: "https://github.com/test-owner/test-repo", baseBranch: "main" },
			fixCi: { githubActionsRunId: 12345 },
			execution: {
				mode: "process",
				timeoutMs: 600000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: false },
			},
		},
		submission: makeSubmission(),
		enqueuedAt: "2026-01-01T00:00:00Z",
		artifacts: {
			artifactDir: "/tmp/results",
			resultFile: "/tmp/results/result.json",
		},
		...overrides,
	};
}

function makeConfig(overrides: Partial<NormalizedDaemonConfigV1> = {}): NormalizedDaemonConfigV1 {
	return {
		version: "fixbot.daemon-config/v1",
		paths: {
			stateDir: "/tmp/state",
			resultsDir: "/tmp/results",
			statusFile: "/tmp/state/daemon-status.json",
			pidFile: "/tmp/state/daemon.pid",
			lockFile: "/tmp/state/daemon.lock",
		},
		status: { format: "json", file: "/tmp/state/daemon-status.json", pretty: true },
		runtime: { heartbeatIntervalMs: 5000, idleSleepMs: 1000 },
		github: {
			repos: [
				{
					url: "https://github.com/test-owner/test-repo",
					baseBranch: "main",
					triggerLabel: "fixbot",
				},
			],
			token: "ghp_test_token",
			pollIntervalMs: 60000,
		},
		identity: { botUrl: "https://github.com/nicobailon/fixbot" },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// parseOwnerRepo
// ---------------------------------------------------------------------------

describe("parseOwnerRepo", () => {
	it("parses https://github.com/owner/repo", () => {
		expect(parseOwnerRepo("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("parses https://github.com/owner/repo.git", () => {
		expect(parseOwnerRepo("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("handles trailing slashes", () => {
		expect(parseOwnerRepo("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("parses owner/repo shorthand", () => {
		expect(parseOwnerRepo("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("throws on invalid format", () => {
		expect(() => parseOwnerRepo("https://github.com/just-one")).toThrow();
	});
});

// ---------------------------------------------------------------------------
// buildPRBody
// ---------------------------------------------------------------------------

describe("buildPRBody", () => {
	it("contains summary, bot identity, CI metadata, model, job ID", () => {
		const result = makeResult();
		const submission = makeSubmission();
		const body = buildPRBody(result, "job-abc", submission, "https://github.com/nicobailon/fixbot");

		expect(body).toContain("## Summary");
		expect(body).toContain("Fixed the flaky test");
		expect(body).toContain("github.com/nicobailon/fixbot");
		expect(body).toContain("#12345");
		expect(body).toContain("anthropic/claude-3");
		expect(body).toContain("`job-abc`");
		expect(body).toContain("**Changed files:** 2");
	});

	it("uses custom botUrl when provided", () => {
		const result = makeResult();
		const submission = makeSubmission();
		const body = buildPRBody(result, "job-abc", submission, "https://example.com/my-bot");
		expect(body).toContain("https://example.com/my-bot");
		expect(body).not.toContain("github.com/nicobailon/fixbot");
	});

	it("uses default botUrl when given the default value", () => {
		const result = makeResult();
		const submission = makeSubmission();
		const body = buildPRBody(result, "job-abc", submission, "https://github.com/nicobailon/fixbot");
		expect(body).toContain("github.com/nicobailon/fixbot");
	});
});

// ---------------------------------------------------------------------------
// buildFailureCommentBody
// ---------------------------------------------------------------------------

describe("buildFailureCommentBody", () => {
	it("contains fixbot-result marker, failure reason, job ID, artifacts", () => {
		const result = makeResult({ status: "failed", failureReason: "Compilation error" });
		const submission = makeSubmission();
		const body = buildFailureCommentBody(result, "job-abc", submission);

		expect(body).toContain("<!-- fixbot-result -->");
		expect(body).toContain("Compilation error");
		expect(body).toContain("`job-abc`");
		expect(body).toContain("/tmp/results");
	});

	it("falls back to summary when failureReason is missing", () => {
		const result = makeResult({ status: "failed", failureReason: undefined });
		const submission = makeSubmission();
		const body = buildFailureCommentBody(result, "job-abc", submission);

		expect(body).toContain("Fixed the flaky test");
	});
});

// ---------------------------------------------------------------------------
// buildNoPatchCommentBody
// ---------------------------------------------------------------------------

describe("buildNoPatchCommentBody", () => {
	it("contains fixbot-result marker, no changes text, summary, job ID", () => {
		const result = makeResult({
			diagnostics: {
				patchSha256: "abc",
				changedFileCount: 0,
				markers: { result: true, summary: true, failureReason: false },
			},
		});
		const submission = makeSubmission();
		const body = buildNoPatchCommentBody(result, "job-abc", submission);

		expect(body).toContain("<!-- fixbot-result -->");
		expect(body).toContain("no changes");
		expect(body).toContain("Fixed the flaky test");
		expect(body).toContain("`job-abc`");
	});
});

// ---------------------------------------------------------------------------
// reportJobResult
// ---------------------------------------------------------------------------

describe("reportJobResult", () => {
	it("success+patch: pushes branch and creates PR", async () => {
		const { spawnCommandOrThrow } = await import("../src/command");
		const tmpDir = mkdtempSync(join(tmpdir(), "fixbot-reporter-test-"));

		const result = makeResult({ execution: { ...makeResult().execution, workspaceDir: tmpDir } });
		const envelope = makeEnvelope();
		const config = makeConfig();

		// Mock GET /user for identity fetch in createAndPushBranch
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ login: "fixbot-bot", id: 12345, name: "Fixbot Bot", email: "fixbot@example.com" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		// Mock POST /repos/.../pulls
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ number: 42, html_url: "https://github.com/test-owner/test-repo/pull/42" }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const logs: string[] = [];
		await reportJobResult(envelope, result, config, msg => logs.push(msg));

		// spawnCommandOrThrow called for git operations
		expect(spawnCommandOrThrow).toHaveBeenCalled();
		const calls = (spawnCommandOrThrow as ReturnType<typeof mock>).mock.calls;
		const gitCommands = calls.map(c => `${c[0]} ${c[1][0]}`);
		expect(gitCommands).toContain("git checkout");
		expect(gitCommands).toContain("git add");
		expect(gitCommands).toContain("git commit");
		expect(gitCommands).toContain("git push");

		// fetch called for GET /user (identity) and POST /repos/.../pulls (PR creation)
		expect(mockFetch).toHaveBeenCalledTimes(2);
		const prCall = mockFetch.mock.calls[1] as [string, RequestInit];
		const [fetchUrl, fetchInit] = prCall;
		expect(fetchUrl).toContain("/repos/test-owner/test-repo/pulls");
		const fetchBody = JSON.parse(fetchInit.body as string) as Record<string, string>;
		expect(fetchBody.head).toBe("fixbot/job-abc");
		expect(fetchBody.base).toBe("main");

		expect(logs.some(l => l.includes("opened PR #42"))).toBe(true);

		try {
			rmdirSync(tmpDir);
		} catch {
			// cleanup best-effort
		}
	});

	it("failure: posts comment with failure body", async () => {
		const result = makeResult({ status: "failed", failureReason: "Type check failed" });
		const envelope = makeEnvelope();
		const config = makeConfig();

		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({}), { status: 201, headers: { "Content-Type": "application/json" } }),
		);

		const logs: string[] = [];
		await reportJobResult(envelope, result, config, msg => logs.push(msg));

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [fetchUrl, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(fetchUrl).toContain("/repos/test-owner/test-repo/issues/7/comments");
		const fetchBody = JSON.parse(fetchInit.body as string) as { body: string };
		expect(fetchBody.body).toContain("<!-- fixbot-result -->");
		expect(fetchBody.body).toContain("Type check failed");

		expect(logs.some(l => l.includes("posted comment on test-owner/test-repo#7"))).toBe(true);
	});

	it("no-patch success: posts comment, not PR", async () => {
		const result = makeResult({
			diagnostics: {
				patchSha256: "abc",
				changedFileCount: 0,
				markers: { result: true, summary: true, failureReason: false },
			},
		});
		const envelope = makeEnvelope();
		const config = makeConfig();

		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({}), { status: 201, headers: { "Content-Type": "application/json" } }),
		);

		await reportJobResult(envelope, result, config);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [fetchUrl, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(fetchUrl).toContain("/issues/7/comments");
		const fetchBody = JSON.parse(fetchInit.body as string) as { body: string };
		expect(fetchBody.body).toContain("no changes");
	});

	it("skips when no token", async () => {
		const result = makeResult();
		const envelope = makeEnvelope();
		const config = makeConfig({ github: { repos: [], token: undefined, pollIntervalMs: 60000 } });

		await reportJobResult(envelope, result, config);

		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("skips when non-github-label submission", async () => {
		const result = makeResult();
		const envelope = makeEnvelope({
			submission: { kind: "cli", filePath: "/tmp/job.json" },
		});
		const config = makeConfig();

		await reportJobResult(envelope, result, config);

		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("skips push when workspace missing, posts comment instead", async () => {
		const { spawnCommandOrThrow } = await import("../src/command");
		(spawnCommandOrThrow as ReturnType<typeof mock>).mockClear();

		const result = makeResult({
			execution: { ...makeResult().execution, workspaceDir: "/tmp/nonexistent-workspace-xyz" },
		});
		const envelope = makeEnvelope();
		const config = makeConfig();

		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({}), { status: 201, headers: { "Content-Type": "application/json" } }),
		);

		const logs: string[] = [];
		await reportJobResult(envelope, result, config, msg => logs.push(msg));

		// No git commands for push
		expect(spawnCommandOrThrow as ReturnType<typeof mock>).not.toHaveBeenCalled();

		// Comment posted instead
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [fetchUrl] = mockFetch.mock.calls[0] as [string];
		expect(fetchUrl).toContain("/issues/7/comments");

		expect(logs.some(l => l.includes("workspace missing"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// fetchGitHubUserIdentity
// ---------------------------------------------------------------------------

describe("fetchGitHubUserIdentity", () => {
	it("returns name and email from the API response", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ login: "octocat", id: 1, name: "The Octocat", email: "octocat@github.com" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const identity = await fetchGitHubUserIdentity("ghp_token");
		expect(identity).toEqual({ name: "The Octocat", email: "octocat@github.com" });
	});

	it("falls back to noreply email when email is null", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ login: "octocat", id: 583231, name: "The Octocat", email: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const identity = await fetchGitHubUserIdentity("ghp_token");
		expect(identity).toEqual({ name: "The Octocat", email: "583231+octocat@users.noreply.github.com" });
	});

	it("uses login as name when display name is null", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ login: "octocat", id: 1, name: null, email: "octocat@github.com" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const identity = await fetchGitHubUserIdentity("ghp_token");
		expect(identity).toEqual({ name: "octocat", email: "octocat@github.com" });
	});

	it("returns null when the API returns a non-200 status", async () => {
		mockFetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
		const identity = await fetchGitHubUserIdentity("ghp_bad_token");
		expect(identity).toBeNull();
	});

	it("returns null when fetch throws", async () => {
		mockFetch.mockRejectedValueOnce(new Error("network error"));
		const identity = await fetchGitHubUserIdentity("ghp_token");
		expect(identity).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// buildPRTitle — task-aware
// ---------------------------------------------------------------------------

describe("buildPRTitle", () => {
	it("fix_ci result includes 'CI repair' and run ID", () => {
		const result = makeResult({ taskClass: "fix_ci" });
		const submission = makeSubmission({ githubActionsRunId: 12345 });
		const title = buildPRTitle(result, submission);
		expect(title).toContain("CI repair");
		expect(title).toContain("12345");
	});

	it("fix_lint result includes 'lint fixes' when no useful summary", () => {
		const result = makeResult({ taskClass: "fix_lint", fixCi: undefined, fixLint: {}, summary: undefined });
		const submission = makeSubmission({ githubActionsRunId: undefined, githubRepo: "owner/repo" });
		const title = buildPRTitle(result, submission);
		expect(title).toContain("lint fixes");
	});

	it("fix_tests result includes 'test fixes' when no useful summary", () => {
		const result = makeResult({ taskClass: "fix_tests", fixCi: undefined, fixTests: {}, summary: undefined });
		const submission = makeSubmission({ githubActionsRunId: undefined, githubRepo: "owner/repo" });
		const title = buildPRTitle(result, submission);
		expect(title).toContain("test fixes");
	});

	it("solve_issue result includes issue number when no useful summary", () => {
		const result = makeResult({
			taskClass: "solve_issue",
			fixCi: undefined,
			solveIssue: { issueNumber: 42 },
			summary: undefined,
		});
		const submission = makeSubmission({ githubActionsRunId: undefined, githubIssueNumber: 42 });
		const title = buildPRTitle(result, submission);
		expect(title).toContain("#42");
	});

	it("fix_cve result says CVE remediation when no useful summary", () => {
		const result = makeResult({
			taskClass: "fix_cve",
			fixCi: undefined,
			fixCve: { cveId: "CVE-2024-1234" },
			summary: undefined,
		});
		const submission = makeSubmission({ githubActionsRunId: undefined });
		const title = buildPRTitle(result, submission);
		expect(title).toContain("CVE remediation");
	});

	it("uses agent summary as title when summary is useful", () => {
		const result = makeResult({
			taskClass: "fix_lint",
			fixCi: undefined,
			fixLint: {},
			summary: "Fixed missing semicolons across 3 files",
		});
		const submission = makeSubmission({ githubActionsRunId: undefined });
		const title = buildPRTitle(result, submission);
		expect(title).toBe("Fixed missing semicolons across 3 files");
	});
});

// ---------------------------------------------------------------------------
// buildPRBody — conditional CI run line
// ---------------------------------------------------------------------------

describe("buildPRBody — task-aware", () => {
	it("fix_lint result does NOT contain 'CI run'", () => {
		const result = makeResult({ taskClass: "fix_lint", fixCi: undefined, fixLint: {} });
		const submission = makeSubmission({ githubActionsRunId: undefined });
		const body = buildPRBody(result, "job-lint", submission, "https://github.com/nicobailon/fixbot");
		expect(body).not.toContain("CI run");
		expect(body).toContain("**Task:** fix_lint");
	});

	it("fix_ci result still contains CI run line", () => {
		const result = makeResult({ taskClass: "fix_ci" });
		const submission = makeSubmission({ githubActionsRunId: 12345 });
		const body = buildPRBody(result, "job-ci", submission, "https://github.com/nicobailon/fixbot");
		expect(body).toContain("**CI run:** #12345");
	});
});

// ---------------------------------------------------------------------------
// buildFailureCommentBody — task-aware
// ---------------------------------------------------------------------------

describe("buildFailureCommentBody — task-aware", () => {
	it("fix_tests result includes 'fix tests task'", () => {
		const result = makeResult({ taskClass: "fix_tests", status: "failed", failureReason: "Tests still fail" });
		const submission = makeSubmission({ githubActionsRunId: undefined });
		const body = buildFailureCommentBody(result, "job-tests", submission);
		expect(body).toContain("fix tests task");
		expect(body).not.toContain("CI run #undefined");
	});

	it("fix_ci result with run ID still shows CI run reference", () => {
		const result = makeResult({ taskClass: "fix_ci", status: "failed", failureReason: "Build error" });
		const submission = makeSubmission({ githubActionsRunId: 99001 });
		const body = buildFailureCommentBody(result, "job-ci", submission);
		expect(body).toContain("CI run #99001");
	});

	it("solve_issue result shows task-aware text", () => {
		const result = makeResult({
			taskClass: "solve_issue",
			status: "failed",
			failureReason: "Could not resolve issue",
			fixCi: undefined,
			solveIssue: { issueNumber: 42 },
		});
		const submission = makeSubmission({ githubActionsRunId: undefined });
		const body = buildFailureCommentBody(result, "job-solve", submission);
		expect(body).not.toContain("CI run");
		expect(body).toContain("solve issue task");
	});

	it("fix_cve result shows task-aware text", () => {
		const result = makeResult({
			taskClass: "fix_cve",
			status: "failed",
			failureReason: "CVE patch failed",
			fixCi: undefined,
			fixCve: { cveId: "CVE-2024-1234" },
		});
		const submission = makeSubmission({ githubActionsRunId: undefined });
		const body = buildFailureCommentBody(result, "job-cve", submission);
		expect(body).not.toContain("CI run");
		expect(body).toContain("fix cve task");
	});
});

// ---------------------------------------------------------------------------
// buildNoPatchCommentBody — task-aware
// ---------------------------------------------------------------------------

describe("buildNoPatchCommentBody — task-aware", () => {
	it("fix_lint result includes 'fix lint task'", () => {
		const result = makeResult({ taskClass: "fix_lint" });
		const submission = makeSubmission({ githubActionsRunId: undefined });
		const body = buildNoPatchCommentBody(result, "job-lint", submission);
		expect(body).toContain("fix lint task");
		expect(body).not.toContain("CI run #undefined");
	});
});
