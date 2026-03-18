import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCommandOrThrow } from "../command";
import { configureLocalGitIdentity } from "../git";
import type { DaemonJobEnvelopeV1, DaemonSubmissionSourceV1, JobResultV1, NormalizedDaemonConfigV1 } from "../types";

// ---------------------------------------------------------------------------
// URL / owner-repo parsing
// ---------------------------------------------------------------------------

/**
 * Extract owner/repo from a GitHub URL like `https://github.com/owner/repo`
 * or `https://github.com/owner/repo.git`, or from an `owner/repo` shorthand.
 */
export function parseOwnerRepo(input: string): { owner: string; repo: string } {
	// If it looks like a URL, parse it
	if (input.startsWith("http://") || input.startsWith("https://")) {
		let pathname: string;
		try {
			pathname = new URL(input).pathname;
		} catch {
			throw new Error(`Invalid GitHub repo URL: ${input}`);
		}
		const cleaned = pathname
			.replace(/^\//, "")
			.replace(/\/$/, "")
			.replace(/\.git$/, "");
		const segments = cleaned.split("/").filter(Boolean);
		if (segments.length !== 2) {
			throw new Error(`GitHub repo URL must have exactly owner/repo path segments: ${input}`);
		}
		return { owner: segments[0], repo: segments[1] };
	}

	// Otherwise treat as owner/repo shorthand
	const cleaned = input.replace(/\.git$/, "").replace(/\/$/, "");
	const segments = cleaned.split("/").filter(Boolean);
	if (segments.length !== 2) {
		throw new Error(`Expected owner/repo format: ${input}`);
	}
	return { owner: segments[0], repo: segments[1] };
}

// ---------------------------------------------------------------------------
// GitHub API fetch wrapper
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";

export async function githubApiFetch(
	url: string,
	options: { method?: string; body?: unknown },
	token: string,
	logger?: (message: string) => void,
): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "fixbot",
	};
	const init: RequestInit = { method: options.method ?? "GET", headers };
	if (options.body !== undefined) {
		headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(options.body);
	}
	const fullUrl = url.startsWith("http") ? url : `${GITHUB_API_BASE}${url}`;
	const response = await fetch(fullUrl, init);
	if (response.status < 200 || response.status >= 300) {
		logger?.(`[fixbot] github-report warn: ${options.method ?? "GET"} ${url} returned ${response.status}`);
	}
	return response;
}

// ---------------------------------------------------------------------------
// Git branch operations
// ---------------------------------------------------------------------------

/**
 * Create a temporary GIT_ASKPASS script that echoes the token.
 * This avoids embedding the token in URLs where it could leak
 * into error messages, logs, or `.git/config`.
 */
function createAskPassScript(token: string): string {
	const scriptPath = join(tmpdir(), `fixbot-askpass-${process.pid}-${Date.now()}.sh`);
	writeFileSync(scriptPath, `#!/bin/sh\necho "${token}"\n`, { mode: 0o700 });
	return scriptPath;
}

export async function createAndPushBranch(
	workspaceDir: string,
	branchName: string,
	repoUrl: string,
	token: string,
	logger?: (message: string) => void,
): Promise<void> {
	await configureLocalGitIdentity(workspaceDir);

	await spawnCommandOrThrow("git", ["checkout", "-b", branchName], { cwd: workspaceDir });
	await spawnCommandOrThrow("git", ["add", "-A"], { cwd: workspaceDir });
	await spawnCommandOrThrow("git", ["commit", "-m", "fixbot: automated repair"], { cwd: workspaceDir });

	const { owner, repo } = parseOwnerRepo(repoUrl);
	const pushUrl = `https://x-access-token@github.com/${owner}/${repo}.git`;

	// Use GIT_ASKPASS to supply the token — never embed it in the URL.
	const askPassScript = createAskPassScript(token);
	try {
		await spawnCommandOrThrow("git", ["push", pushUrl, branchName], {
			cwd: workspaceDir,
			env: {
				...process.env,
				GIT_ASKPASS: askPassScript,
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	} finally {
		try {
			unlinkSync(askPassScript);
		} catch {
			// best-effort cleanup
		}
	}

	logger?.(`[fixbot] github-report: pushed branch ${branchName}`);
}

// ---------------------------------------------------------------------------
// GitHub PR / comment operations
// ---------------------------------------------------------------------------

export async function createPullRequest(
	owner: string,
	repo: string,
	title: string,
	body: string,
	head: string,
	base: string,
	token: string,
	logger?: (message: string) => void,
): Promise<{ number: number; html_url: string }> {
	const response = await githubApiFetch(
		`/repos/${owner}/${repo}/pulls`,
		{ method: "POST", body: { title, body, head, base } },
		token,
		logger,
	);
	if (response.status !== 201) {
		const text = await response.text();
		throw new Error(`Failed to create PR on ${owner}/${repo}: ${response.status} ${text}`);
	}
	const data = (await response.json()) as { number: number; html_url: string };
	return { number: data.number, html_url: data.html_url };
}

export async function postIssueComment(
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
	token: string,
	logger?: (message: string) => void,
): Promise<void> {
	const response = await githubApiFetch(
		`/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
		{ method: "POST", body: { body } },
		token,
		logger,
	);
	if (response.status !== 201) {
		const text = await response.text();
		throw new Error(`Failed to post comment on ${owner}/${repo}#${issueNumber}: ${response.status} ${text}`);
	}
}

// ---------------------------------------------------------------------------
// Body builders
// ---------------------------------------------------------------------------

export function buildPRTitle(result: JobResultV1, submission: DaemonSubmissionSourceV1): string {
	const ownerRepo = submission.githubRepo ?? "unknown";
	switch (result.taskClass) {
		case "fix_ci":
			return `fixbot: automated CI repair for run #${submission.githubActionsRunId}`;
		case "fix_lint":
			return `fixbot: lint fixes for ${ownerRepo}`;
		case "fix_tests":
			return `fixbot: test fixes for ${ownerRepo}`;
		case "solve_issue":
			return `fixbot: fix for issue #${submission.githubIssueNumber}`;
		case "fix_cve":
			return "fixbot: CVE remediation";
		default:
			return "fixbot: automated repair";
	}
}

export function buildPRBody(
	result: JobResultV1,
	jobId: string,
	submission: DaemonSubmissionSourceV1,
	botUrl: string,
): string {
	const model = result.execution.selectedModel;
	const modelStr = model ? `${model.provider}/${model.modelId}` : "unknown";
	const lines: string[] = ["## fixbot repair summary", "", result.summary, "", "---", ""];
	if (submission.githubActionsRunId !== undefined) {
		lines.push(`**CI run:** #${submission.githubActionsRunId}`);
	}
	lines.push(
		`**Task:** ${result.taskClass}`,
		`**Changed files:** ${result.diagnostics.changedFileCount}`,
		`**Model:** ${modelStr}`,
		`**Job:** \`${jobId}\``,
		"",
		"---",
		"",
		`*Automated repair by [fixbot](${botUrl}). Review before merging.*`,
	);
	return lines.join("\n");
}

function taskAwareContextText(result: JobResultV1, submission: DaemonSubmissionSourceV1): string {
	if (submission.githubActionsRunId !== undefined) {
		return `for CI run #${submission.githubActionsRunId}`;
	}
	return `for ${result.taskClass.replace(/_/g, " ")} task`;
}

export function buildFailureCommentBody(
	result: JobResultV1,
	jobId: string,
	submission: DaemonSubmissionSourceV1,
): string {
	const context = taskAwareContextText(result, submission);
	return [
		"<!-- fixbot-result -->",
		`🔴 **fixbot repair failed** ${context}`,
		"",
		`**Reason:** ${result.failureReason || result.summary}`,
		"",
		`**Job ID:** \`${jobId}\``,
		`**Artifacts:** \`${result.artifacts.rootDir}\``,
		"",
		"*See job artifacts for full execution log.*",
	].join("\n");
}

export function buildNoPatchCommentBody(
	result: JobResultV1,
	jobId: string,
	submission: DaemonSubmissionSourceV1,
): string {
	const context = taskAwareContextText(result, submission);
	return [
		"<!-- fixbot-result -->",
		`⚪ **fixbot completed with no changes** ${context}`,
		"",
		result.summary,
		"",
		`**Job ID:** \`${jobId}\``,
		`**Artifacts:** \`${result.artifacts.rootDir}\``,
		"",
		"*No code changes were produced. The issue may require manual investigation.*",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function reportJobResult(
	envelope: DaemonJobEnvelopeV1,
	result: JobResultV1,
	config: NormalizedDaemonConfigV1,
	logger?: (message: string) => void,
): Promise<void> {
	// Guard: only github-label submissions
	if (envelope.submission.kind !== "github-label") {
		logger?.("[fixbot] github-report: skipping — not github-label");
		return;
	}

	// Guard: need a token
	const token = config.github?.token;
	if (!token) {
		logger?.("[fixbot] github-report: skipping — no token");
		return;
	}

	// Guard: need repo + issue number
	const githubRepo = envelope.submission.githubRepo;
	const issueNumber = envelope.submission.githubIssueNumber;
	if (!githubRepo || !issueNumber) {
		logger?.("[fixbot] github-report: skipping — missing githubRepo or githubIssueNumber");
		return;
	}

	const { owner, repo } = parseOwnerRepo(githubRepo);

	// Success with changed files → branch + PR
	if (result.status === "success" && result.diagnostics.changedFileCount > 0) {
		// Guard: workspace must still exist for git push
		if (!existsSync(result.execution.workspaceDir)) {
			logger?.(`[fixbot] github-report: skipping push — workspace missing: ${result.execution.workspaceDir}`);
			// Fall through to post a comment instead
			const body = buildNoPatchCommentBody(result, envelope.jobId, envelope.submission);
			await postIssueComment(owner, repo, issueNumber, body, token, logger);
			logger?.(`[fixbot] github-report: posted comment on ${owner}/${repo}#${issueNumber}`);
			return;
		}

		const branchName = `fixbot/${envelope.jobId}`;

		// Find baseBranch from config repos, fall back to "main"
		let baseBranch = "main";
		if (config.github?.repos) {
			for (const repoConfig of config.github.repos) {
				try {
					const parsed = parseOwnerRepo(repoConfig.url);
					if (parsed.owner === owner && parsed.repo === repo) {
						baseBranch = repoConfig.baseBranch;
						break;
					}
				} catch {
					// skip malformed URLs
				}
			}
		}

		await createAndPushBranch(result.execution.workspaceDir, branchName, githubRepo, token, logger);

		const title = buildPRTitle(result, envelope.submission);
		const prBody = buildPRBody(result, envelope.jobId, envelope.submission, config.identity.botUrl);
		const pr = await createPullRequest(owner, repo, title, prBody, branchName, baseBranch, token, logger);
		logger?.(`[fixbot] github-report: opened PR #${pr.number}`);
		return;
	}

	// Failure or no-patch success → comment
	const body =
		result.status === "success"
			? buildNoPatchCommentBody(result, envelope.jobId, envelope.submission)
			: buildFailureCommentBody(result, envelope.jobId, envelope.submission);

	await postIssueComment(owner, repo, issueNumber, body, token, logger);
	logger?.(`[fixbot] github-report: posted comment on ${owner}/${repo}#${issueNumber}`);
}
