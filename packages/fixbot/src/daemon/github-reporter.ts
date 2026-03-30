import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCommandOrThrow } from "../command";
import { configureLocalGitIdentity, tryEnableGpgSigning } from "../git";
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
// GitHub user identity
// ---------------------------------------------------------------------------

/**
 * Fetch the authenticated user's name and email from the GitHub API.
 * Returns null when the API call fails — callers must fall back gracefully.
 *
 * GitHub users who set their email to private will have a null email in
 * the API response. In that case we use the `ID+login@users.noreply.github.com`
 * format, which is still linked to the account and avoids leaking a private
 * email into commit metadata.
 */
export async function fetchGitHubUserIdentity(
	token: string,
	logger?: (message: string) => void,
): Promise<{ name: string; email: string } | null> {
	let data: { login: string; id?: number; name?: string | null; email?: string | null };
	try {
		const response = await githubApiFetch("/user", {}, token, logger);
		if (!response.ok) {
			logger?.(`[fixbot] github-reporter: GET /user returned ${response.status} — falling back to generic identity`);
			return null;
		}
		data = (await response.json()) as typeof data;
	} catch (err) {
		logger?.(`[fixbot] github-reporter: could not fetch user identity — ${String(err)}`);
		return null;
	}
	const name = data.name?.trim() || data.login;
	// Prefer the public email; fall back to the GitHub noreply address so the
	// commit is still linked to the account even when the email is private.
	const email = data.email?.trim();
	if (email) {
		return { name, email };
	}
	if (data.id !== undefined) {
		return { name, email: `${data.id}+${data.login}@users.noreply.github.com` };
	}
	logger?.(
		`[fixbot] github-reporter: user ID not available to construct noreply email — falling back to generic identity`,
	);
	return null;
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
	gpgKeyId?: string,
): Promise<void> {
	// Use the real GitHub user identity so commits are linked to the account
	// and show the correct avatar on GitHub.
	const identity = await fetchGitHubUserIdentity(token, logger);
	if (identity) {
		logger?.(`[fixbot] github-reporter: configuring git identity as ${identity.name} <${identity.email}>`);
	} else {
		logger?.("[fixbot] github-reporter: using fallback git identity");
	}
	await configureLocalGitIdentity(workspaceDir, identity ?? undefined);

	// Enable GPG signing when a key is available. Non-fatal: log and continue.
	await tryEnableGpgSigning(workspaceDir, gpgKeyId, logger);

	await spawnCommandOrThrow("git", ["checkout", "-b", branchName], { cwd: workspaceDir });

	// Stage and commit any uncommitted changes. The agent may have already committed,
	// so allow `git commit` to exit with code 1 (nothing to commit).
	await spawnCommandOrThrow("git", ["add", "-A"], { cwd: workspaceDir });
	try {
		await spawnCommandOrThrow("git", ["commit", "-m", "fixbot: automated repair"], { cwd: workspaceDir });
	} catch {
		// Nothing to commit — the agent already committed its changes. That's fine.
		logger?.("[fixbot] github-report: no uncommitted changes to commit (agent already committed)");
	}

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
	// Use the agent's summary as the title when available — it's more descriptive.
	const summaryTitle = result.summary?.split("\n")[0]?.trim();
	const hasUsefulSummary = summaryTitle && summaryTitle.length > 10 && summaryTitle.length < 120;

	switch (result.taskClass) {
		case "fix_ci":
			return `fixbot: automated CI repair for run #${submission.githubActionsRunId}`;
		case "fix_lint":
			return hasUsefulSummary ? summaryTitle : `fixbot: lint fixes`;
		case "fix_tests":
			return hasUsefulSummary ? summaryTitle : `fixbot: test fixes`;
		case "solve_issue":
			return hasUsefulSummary ? summaryTitle : `fixbot: fix for issue #${submission.githubIssueNumber}`;
		case "fix_cve":
			return hasUsefulSummary ? summaryTitle : "fixbot: CVE remediation";
		default:
			return hasUsefulSummary ? summaryTitle : "fixbot: automated repair";
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

	const lines: string[] = [];

	// Link to the originating issue when available
	if (submission.githubIssueNumber && submission.githubRepo) {
		lines.push(`Closes ${submission.githubRepo}#${submission.githubIssueNumber}`, "");
	}

	// Agent's full explanation
	lines.push("## Summary", "");
	if (result.summary) {
		lines.push(result.summary, "");
	}

	// Include the full agent output when it's longer than the summary (has explanation/table/etc.)
	let fullText = "";
	try {
		fullText = result.artifacts.assistantFinalFile ? readFileSync(result.artifacts.assistantFinalFile, "utf-8") : "";
	} catch {
		// Best-effort — file may not exist
	}
	if (fullText.length > (result.summary?.length ?? 0) + 20) {
		lines.push("## Agent Analysis", "", "<details>", "<summary>Full agent output</summary>", "");
		// Strip the marker lines from the output
		const cleaned = fullText
			.split("\n")
			.filter(l => !/^(?:FIXBOT|GITFIX)_(?:RESULT|SUMMARY|FAILURE_REASON):/.test(l))
			.join("\n")
			.trim();
		lines.push(cleaned, "", "</details>", "");
	}

	lines.push("---", "");
	if (submission.githubActionsRunId !== undefined) {
		lines.push(`**CI run:** #${submission.githubActionsRunId}`);
	}
	lines.push(
		`**Task:** ${result.taskClass}`,
		`**Changed files:** ${result.diagnostics.changedFileCount}`,
		`**Model:** ${modelStr}`,
		`**Job:** \`${jobId}\``,
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

export function buildFinalFailureCommentBody(
	envelope: DaemonJobEnvelopeV1,
	failureReason: string,
	attemptCount: number,
	result?: JobResultV1,
): string {
	const classification = envelope.lastFailureClassification ?? "unknown";
	const originalJobId = envelope.originalJobId ?? envelope.jobId;
	const lines: string[] = [
		"<!-- fixbot-result -->",
		`\u{1f534} **fixbot repair failed after ${attemptCount + 1} attempt(s)**`,
		"",
		`**Last error:** ${failureReason}`,
		`**Failure type:** ${classification}`,
		`**Original job:** \`${originalJobId}\``,
	];
	if (result?.artifacts?.rootDir) {
		lines.push(`**Artifacts:** \`${result.artifacts.rootDir}\``);
	}
	lines.push("", "*All retry attempts have been exhausted. Manual investigation is required.*");
	return lines.join("\n");
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

		await createAndPushBranch(
			result.execution.workspaceDir,
			branchName,
			githubRepo,
			token,
			logger,
			config.github?.gpgKeyId,
		);

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
