/**
 * Comment addresser — orchestrates the cycle of:
 *   1. Clone the PR's head branch
 *   2. Rebase on base
 *   3. Run the agent with comment context injected
 *   4. Push the result
 *   5. Reply to each addressed comment
 *   6. Post a summary comment
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCommandOrThrow } from "../command";
import { createAskPassScript, fetchAndRebaseOnBase, configureLocalGitIdentity, getHeadCommit } from "../git";
import { parseOwnerRepo } from "../github-utils";
import { githubApiFetch } from "./github-api";
import { fetchGitHubUserIdentity } from "./github-reporter";
import { markCycleComplete, type PRCommentPollResult, type PRReviewComment } from "./comment-poller";
import type { NormalizedDaemonConfigV1, NormalizedJobSpecV1 } from "../types";
import type { DaemonJobRunner, DaemonJobRunnerOptions } from "./service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddressCommentsOptions {
	config: NormalizedDaemonConfigV1;
	pollResult: PRCommentPollResult;
	jobRunner: DaemonJobRunner;
	logger?: (message: string) => void;
}

export interface AddressCommentsResult {
	success: boolean;
	commitSha?: string;
	addressedCount: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Job ID derivation
// ---------------------------------------------------------------------------

export function deriveCommentJobId(
	owner: string,
	repo: string,
	prNumber: number,
	cycleNumber: number,
): string {
	const input = `${owner}/${repo}/${prNumber}/${cycleNumber}`;
	const hex = createHash("sha256").update(input).digest("hex").slice(0, 16);
	return `gh-comment-${hex}`;
}

// ---------------------------------------------------------------------------
// Comment context builder
// ---------------------------------------------------------------------------

function buildCommentContext(comments: PRReviewComment[]): string {
	const lines: string[] = [
		"# Review Comments to Address",
		"",
		"The following review comments have been left on this PR. Address each one with the minimum viable change.",
		"",
	];

	for (const comment of comments) {
		lines.push(`## Comment by @${comment.user}`);
		if (comment.path) {
			lines.push(`**File:** \`${comment.path}\`${comment.line ? ` (line ${comment.line})` : ""}`);
		}
		lines.push("");
		lines.push(comment.body);
		lines.push("");
		lines.push("---");
		lines.push("");
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Clone PR branch
// ---------------------------------------------------------------------------

async function clonePRBranch(
	repoUrl: string,
	headBranch: string,
	workspaceDir: string,
	token: string,
	logger?: (message: string) => void,
): Promise<void> {
	const { owner, repo } = parseOwnerRepo(repoUrl);
	// Use x-access-token@ without the token in the URL; supply via GIT_ASKPASS.
	const cloneUrl = `https://x-access-token@github.com/${owner}/${repo}.git`;
	const askPassScript = createAskPassScript(token);
	try {
		await spawnCommandOrThrow("git", [
			"clone",
			"--progress",
			"--branch",
			headBranch,
			"--single-branch",
			cloneUrl,
			workspaceDir,
		], {
			env: {
				...process.env,
				GIT_ASKPASS: askPassScript,
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	} finally {
		try { unlinkSync(askPassScript); } catch { /* best-effort */ }
	}
	logger?.(`[fixbot] comment-addresser: cloned ${owner}/${repo} branch ${headBranch}`);
}

// ---------------------------------------------------------------------------
// Reply to comments
// ---------------------------------------------------------------------------

async function replyToComment(
	owner: string,
	repo: string,
	prNumber: number,
	comment: PRReviewComment,
	commitSha: string,
	token: string,
	logger?: (message: string) => void,
): Promise<void> {
	const body = `<!-- fixbot-addressed -->\nAddressed in ${commitSha}`;

	if (comment.path) {
		await githubApiFetch(
			`/repos/${owner}/${repo}/pulls/${prNumber}/comments/${comment.id}/replies`,
			{ method: "POST", body: { body } },
			token,
			logger,
		);
	} else {
		await githubApiFetch(
			`/repos/${owner}/${repo}/issues/${prNumber}/comments`,
			{ method: "POST", body: { body } },
			token,
			logger,
		);
	}
}

async function postSummaryComment(
	owner: string,
	repo: string,
	prNumber: number,
	addressedCount: number,
	commitSha: string,
	token: string,
	logger?: (message: string) => void,
): Promise<void> {
	const body = [
		"<!-- fixbot-comment-summary -->",
		`Addressed ${addressedCount} review comment${addressedCount === 1 ? "" : "s"} in ${commitSha}.`,
		"",
		"*Automated by fixbot. Please review the changes.*",
	].join("\n");

	await githubApiFetch(
		`/repos/${owner}/${repo}/issues/${prNumber}/comments`,
		{ method: "POST", body: { body } },
		token,
		logger,
	);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function addressComments(options: AddressCommentsOptions): Promise<AddressCommentsResult> {
	const { config, pollResult, jobRunner, logger } = options;
	const { entry, comments } = pollResult;
	const token = config.github?.token;

	if (!token) {
		return { success: false, addressedCount: 0, error: "no GitHub token" };
	}

	const cycleNumber = entry.cycleCount + 1;
	const jobId = deriveCommentJobId(entry.owner, entry.repo, entry.prNumber, cycleNumber);

	const workspaceBase = join(config.paths.resultsDir, `job-${jobId}`, "workspace");
	mkdirSync(join(config.paths.resultsDir, `job-${jobId}`), { recursive: true });

	try {
		// 1. Clone the PR's head branch
		await clonePRBranch(entry.repoUrl, entry.headBranch, workspaceBase, token, logger);

		// 2. Configure git identity
		const identity = await fetchGitHubUserIdentity(token, logger);
		await configureLocalGitIdentity(workspaceBase, identity ?? undefined);

		// 3. Rebase on base branch
		try {
			await fetchAndRebaseOnBase(workspaceBase, entry.baseBranch);
		} catch (rebaseErr) {
			const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
			logger?.(`[fixbot] comment-addresser: rebase failed for ${entry.owner}/${entry.repo}#${entry.prNumber}: ${msg}`);
			try {
				await spawnCommandOrThrow("git", ["rebase", "--abort"], { cwd: workspaceBase });
			} catch {
				// ignore
			}
			logger?.(`[fixbot] comment-addresser: WARNING — continuing on un-rebased branch for ${entry.owner}/${entry.repo}#${entry.prNumber}; agent will run against potentially stale code`);
		}

		// 4. Write the comment context file for the agent
		const contextFile = join(config.paths.resultsDir, `job-${jobId}`, "injected-context.md");
		const commentContext = buildCommentContext(comments);
		writeFileSync(contextFile, commentContext, "utf-8");

		// 5. Build a job spec for the agent (reuse solve_issue with comment context)
		const jobSpec: NormalizedJobSpecV1 = {
			version: "fixbot.job/v1",
			jobId,
			taskClass: "solve_issue",
			repo: { url: entry.repoUrl, baseBranch: entry.baseBranch },
			solveIssue: {
				issueNumber: entry.prNumber,
				issueTitle: `Address review comments on PR #${entry.prNumber}`,
				issueBody: commentContext,
			},
			execution: {
				mode: "process",
				timeoutMs: 1_800_000,
				memoryLimitMb: 4096,
				sandbox: { mode: "workspace-write", networkAccess: true },
			},
		};

		// 6. Run the agent
		const runnerOptions: DaemonJobRunnerOptions = {
			resultsDir: config.paths.resultsDir,
			configModel: config.model,
		};
		const result = await jobRunner(jobSpec, runnerOptions);

		if (result.status !== "success" || result.diagnostics.changedFileCount === 0) {
			logger?.(
				`[fixbot] comment-addresser: agent produced no changes for ${entry.owner}/${entry.repo}#${entry.prNumber}`,
			);
			const maxCommentId = Math.max(...comments.map((c) => c.id));
			markCycleComplete(config.paths.stateDir, entry.owner, entry.repo, entry.prNumber, maxCommentId);
			return { success: false, addressedCount: 0, error: "agent produced no changes" };
		}

		// 7. Get the commit SHA after agent changes
		const commitSha = await getHeadCommit(result.execution.workspaceDir);
		const shortSha = commitSha.slice(0, 7);

		// 8. Force-push to the existing PR branch
		if (existsSync(result.execution.workspaceDir)) {
			const pushAskPassScript = createAskPassScript(token);
			try {
				await spawnCommandOrThrow(
					"git",
					["push", "origin", `HEAD:${entry.headBranch}`, "--force-with-lease"],
					{
						cwd: result.execution.workspaceDir,
						env: {
							...process.env,
							GIT_ASKPASS: pushAskPassScript,
							GIT_TERMINAL_PROMPT: "0",
						},
					},
				);
			} finally {
				try { unlinkSync(pushAskPassScript); } catch { /* best-effort */ }
			}
			logger?.(`[fixbot] comment-addresser: pushed changes to ${entry.headBranch}`);
		}

		// 9. Reply to each comment
		let addressedCount = 0;
		for (const comment of comments) {
			try {
				await replyToComment(entry.owner, entry.repo, entry.prNumber, comment, shortSha, token, logger);
				addressedCount++;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger?.(`[fixbot] comment-addresser: failed to reply to comment ${comment.id}: ${msg}`);
			}
		}

		// 10. Post summary comment
		await postSummaryComment(entry.owner, entry.repo, entry.prNumber, addressedCount, shortSha, token, logger);

		// 11. Advance the cursor
		const maxCommentId = Math.max(...comments.map((c) => c.id));
		markCycleComplete(config.paths.stateDir, entry.owner, entry.repo, entry.prNumber, maxCommentId);

		logger?.(
			`[fixbot] comment-addresser: addressed ${addressedCount} comments on ${entry.owner}/${entry.repo}#${entry.prNumber} in ${shortSha}`,
		);

		return { success: true, commitSha: shortSha, addressedCount };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(`[fixbot] comment-addresser error: ${entry.owner}/${entry.repo}#${entry.prNumber}: ${msg}`);

		const maxCommentId = comments.length > 0 ? Math.max(...comments.map((c) => c.id)) : entry.lastProcessedCommentId;
		markCycleComplete(config.paths.stateDir, entry.owner, entry.repo, entry.prNumber, maxCommentId);

		return { success: false, addressedCount: 0, error: msg };
	}
}
