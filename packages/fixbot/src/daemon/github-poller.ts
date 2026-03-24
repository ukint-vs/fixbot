import { createHash } from "node:crypto";
import { getArtifactPaths } from "../artifacts";
import { normalizeJobSpec } from "../contracts";
import {
	DAEMON_JOB_ENVELOPE_VERSION_V1,
	type DaemonJobEnvelopeV1,
	type NormalizedDaemonGitHubConfig,
	type NormalizedJobSpecV1,
	type TaskClass,
} from "../types";
import { parseOwnerRepo } from "./github-reporter";
import { DuplicateDaemonJobError } from "./job-store";

// ---------------------------------------------------------------------------
// Deterministic job ID
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic job ID from repo URL, issue number, and a trigger
 * discriminator. The discriminator prevents collisions when the same issue is
 * triggered by different mechanisms (e.g. label vs assignment).
 */
export function deriveGitHubJobId(repoUrl: string, issueNumber: number, trigger: string): string {
	const hex = createHash("sha256").update(`${repoUrl}/${issueNumber}/${trigger}`).digest("hex").slice(0, 16);
	return `gh-${hex}`;
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";

function githubApiFetch(path: string, token?: string, method?: string, body?: unknown): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "fixbot",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const init: RequestInit = { method: method ?? "GET", headers };
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	return fetch(`${GITHUB_API_BASE}${path}`, init);
}

/** Shared issue shape returned by GitHub issues list endpoints. */
export interface GitHubIssueSummary {
	number: number;
	title: string;
	body: string | null;
}

/**
 * Generic helper that fetches issues from the GitHub Issues API with an
 * arbitrary query-string filter. Both `fetchLabeledIssues` and
 * `fetchAssignedIssues` delegate to this function.
 */
export async function fetchIssuesWithFilter(
	owner: string,
	repo: string,
	filter: string,
	token?: string,
	logger?: (message: string) => void,
	fnName: string = "fetchIssuesWithFilter",
): Promise<GitHubIssueSummary[]> {
	const path = `/repos/${owner}/${repo}/issues?${filter}&state=open&per_page=100`;
	let response: Response;
	try {
		response = await githubApiFetch(path, token);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(`[fixbot] github-poll warn: ${fnName} network error for ${owner}/${repo}: ${msg}`);
		return [];
	}
	if (response.status !== 200) {
		logger?.(`[fixbot] github-poll warn: ${fnName} ${owner}/${repo} returned ${response.status}`);
		return [];
	}
	let data: Array<{ number: number; title: string; body: string | null }>;
	try {
		data = (await response.json()) as Array<{ number: number; title: string; body: string | null }>;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(`[fixbot] github-poll warn: ${fnName} ${owner}/${repo} malformed JSON: ${msg}`);
		return [];
	}
	return data.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body ?? null }));
}

export async function fetchLabeledIssues(
	owner: string,
	repo: string,
	label: string,
	token?: string,
	logger?: (message: string) => void,
): Promise<GitHubIssueSummary[]> {
	return fetchIssuesWithFilter(
		owner,
		repo,
		`labels=${encodeURIComponent(label)}`,
		token,
		logger,
		"fetchLabeledIssues",
	);
}

export async function fetchAssignedIssues(
	owner: string,
	repo: string,
	assignee: string,
	token?: string,
	logger?: (message: string) => void,
): Promise<GitHubIssueSummary[]> {
	return fetchIssuesWithFilter(
		owner,
		repo,
		`assignee=${encodeURIComponent(assignee)}`,
		token,
		logger,
		"fetchAssignedIssues",
	);
}

export async function fetchLatestFailedRun(
	owner: string,
	repo: string,
	branch: string,
	token?: string,
	logger?: (message: string) => void,
): Promise<number | null> {
	const path = `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&status=failure&per_page=1`;
	let response: Response;
	try {
		response = await githubApiFetch(path, token);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(`[fixbot] github-poll warn: fetchLatestFailedRun network error for ${owner}/${repo}: ${msg}`);
		return null;
	}
	if (response.status !== 200) {
		logger?.(`[fixbot] github-poll warn: fetchLatestFailedRun ${owner}/${repo} returned ${response.status}`);
		return null;
	}
	let data: { workflow_runs: Array<{ id: number }> };
	try {
		data = (await response.json()) as { workflow_runs: Array<{ id: number }> };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(`[fixbot] github-poll warn: fetchLatestFailedRun ${owner}/${repo} malformed JSON: ${msg}`);
		return null;
	}
	if (!data.workflow_runs || data.workflow_runs.length === 0) {
		return null;
	}
	return data.workflow_runs[0].id;
}

export async function postAckComment(
	owner: string,
	repo: string,
	issueNumber: number,
	jobId: string,
	token: string,
	logger?: (message: string) => void,
): Promise<boolean> {
	const path = `/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
	const body = { body: `<!-- fixbot-ack -->\n🤖 fixbot job \`${jobId}\` has been queued.` };
	let response: Response;
	try {
		response = await githubApiFetch(path, token, "POST", body);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(
			`[fixbot] github-poll warn: postAckComment network error for ${owner}/${repo}#${issueNumber}: ${msg}`,
		);
		return false;
	}
	return response.status === 201;
}

// ---------------------------------------------------------------------------
// Ack comment detection (returns comment ID for deletion support)
// ---------------------------------------------------------------------------

export interface AckCommentResult {
	found: boolean;
	commentId: number | null;
}

export async function hasAckComment(
	owner: string,
	repo: string,
	issueNumber: number,
	token?: string,
	logger?: (message: string) => void,
): Promise<AckCommentResult> {
	const path = `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
	let response: Response;
	try {
		response = await githubApiFetch(path, token);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(
			`[fixbot] github-poll warn: hasAckComment network error for ${owner}/${repo}#${issueNumber}: ${msg}`,
		);
		return { found: false, commentId: null };
	}
	if (response.status !== 200) {
		logger?.(
			`[fixbot] github-poll warn: hasAckComment ${owner}/${repo}#${issueNumber} returned ${response.status}`,
		);
		return { found: false, commentId: null };
	}
	let comments: Array<{ id?: number; body?: string }>;
	try {
		comments = (await response.json()) as Array<{ id?: number; body?: string }>;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(
			`[fixbot] github-poll warn: hasAckComment ${owner}/${repo}#${issueNumber} malformed JSON: ${msg}`,
		);
		return { found: false, commentId: null };
	}
	const ack = comments.find((comment) => comment.body?.includes("<!-- fixbot-ack -->"));
	if (ack) {
		return { found: true, commentId: ack.id ?? null };
	}
	return { found: false, commentId: null };
}

/**
 * Delete an ack comment by its ID.  Used when unassigning cancels a queued job
 * so that the issue is eligible for re-triggering in a future poll cycle.
 */
export async function deleteAckComment(
	owner: string,
	repo: string,
	commentId: number,
	token: string,
	logger?: (message: string) => void,
): Promise<boolean> {
	const path = `/repos/${owner}/${repo}/issues/comments/${commentId}`;
	let response: Response;
	try {
		response = await githubApiFetch(path, token, "DELETE");
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(
			`[fixbot] github-poll warn: deleteAckComment network error for ${owner}/${repo} comment ${commentId}: ${msg}`,
		);
		return false;
	}
	return response.status === 204;
}

// ---------------------------------------------------------------------------
// Bot username validation
// ---------------------------------------------------------------------------

/**
 * Validate that botUsername is configured when assignment polling is requested.
 * Returns the trimmed, lowercased username or undefined when not configured.
 */
export function validateBotUsername(botUsername: string | undefined): string | undefined {
	if (botUsername === undefined || botUsername.trim() === "") {
		return undefined;
	}
	return botUsername.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Job spec builder
// ---------------------------------------------------------------------------

export function buildGitHubJobSpec(
	repoUrl: string,
	baseBranch: string,
	issueNumber: number,
	runId: number,
	trigger: string,
	taskClass: TaskClass = "solve_issue",
	issueTitle?: string,
	issueBody?: string,
): NormalizedJobSpecV1 {
	const jobId = deriveGitHubJobId(repoUrl, issueNumber, trigger);
	const spec: Record<string, unknown> = {
		version: "fixbot.job/v1",
		jobId,
		taskClass,
		repo: { url: repoUrl, baseBranch },
		execution: { mode: "process", timeoutMs: 1_800_000, memoryLimitMb: 4096 },
	};
	if (taskClass === "fix_ci") {
		spec.fixCi = { githubActionsRunId: runId };
	} else if (taskClass === "solve_issue") {
		spec.solveIssue = { issueNumber, ...(issueTitle ? { issueTitle } : {}), ...(issueBody ? { issueBody } : {}) };
	}
	return normalizeJobSpec(spec, "github-poll job");
}

// ---------------------------------------------------------------------------
// Main poller
// ---------------------------------------------------------------------------

export interface GitHubPollResult {
	enqueued: string[];
	skipped: number;
	errors: number;
	cancelled: number;
}

export type GitHubEnqueueFn = (envelope: DaemonJobEnvelopeV1) => void;
export type GitHubCancelFn = (jobId: string) => boolean;

export async function pollGitHubRepos(
	githubConfig: NormalizedDaemonGitHubConfig,
	resultsDir: string,
	enqueueFn: GitHubEnqueueFn,
	logger?: (message: string) => void,
	cancelFn?: GitHubCancelFn,
): Promise<GitHubPollResult> {
	const enqueued: string[] = [];
	let skipped = 0;
	let errors = 0;
	let cancelled = 0;

	for (const repoConfig of githubConfig.repos) {
		let owner: string;
		let repo: string;
		try {
			({ owner, repo } = parseOwnerRepo(repoConfig.url));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger?.(`[fixbot] github-poll error: ${msg}`);
			errors++;
			continue;
		}

		// ---------------------------------------------------------------
		// 1. Label-triggered polling (existing behavior)
		// ---------------------------------------------------------------

		// Collect all labels to query: triggerLabel + any taskClassOverride keys
		const labelsToQuery = new Set<string>([repoConfig.triggerLabel]);
		if (repoConfig.taskClassOverrides) {
			for (const label of Object.keys(repoConfig.taskClassOverrides)) {
				labelsToQuery.add(label);
			}
		}

		for (const labelName of labelsToQuery) {
			// Determine task class for this label
			const taskClass: TaskClass = repoConfig.taskClassOverrides?.[labelName] ?? "solve_issue";

			const issues = await fetchLabeledIssues(owner, repo, labelName, githubConfig.token, logger);

			for (const issue of issues) {
				// Dedup: skip if ack comment already exists
				const ackResult = await hasAckComment(owner, repo, issue.number, githubConfig.token, logger);
				if (ackResult.found) {
					skipped++;
					continue;
				}

				// For fix_ci tasks, resolve latest failing run; skip if none found
				let runId = 0;
				if (taskClass === "fix_ci") {
					const fetchedRunId = await fetchLatestFailedRun(
						owner,
						repo,
						repoConfig.baseBranch,
						githubConfig.token,
						logger,
					);
					if (fetchedRunId === null) {
						logger?.(
							`[fixbot] github-poll skip: no failing run for ${owner}/${repo}#${issue.number} on branch ${repoConfig.baseBranch}`,
						);
						skipped++;
						continue;
					}
					runId = fetchedRunId;
				}

				// Build job spec and envelope
				const jobSpec = buildGitHubJobSpec(
					repoConfig.url,
					repoConfig.baseBranch,
					issue.number,
					runId,
					labelName,
					taskClass,
					issue.title,
					issue.body ?? undefined,
				);
				const artifactPaths = getArtifactPaths(resultsDir, jobSpec.jobId);
				const envelope: DaemonJobEnvelopeV1 = {
					version: DAEMON_JOB_ENVELOPE_VERSION_V1,
					jobId: jobSpec.jobId,
					job: jobSpec,
					submission: {
						kind: "github-label",
						githubRepo: `${owner}/${repo}`,
						githubIssueNumber: issue.number,
						githubLabelName: labelName,
						...(runId > 0 ? { githubActionsRunId: runId } : {}),
					},
					enqueuedAt: new Date().toISOString(),
					artifacts: {
						artifactDir: artifactPaths.artifactDir,
						resultFile: artifactPaths.resultFile,
					},
				};

				try {
					enqueueFn(envelope);
					enqueued.push(jobSpec.jobId);
					logger?.(
						`[fixbot] github-poll: enqueued ${taskClass} job for ${owner}/${repo}#${issue.number} (label: ${labelName})`,
					);
				} catch (error) {
					if (error instanceof DuplicateDaemonJobError) {
						skipped++;
						continue;
					}
					const msg = error instanceof Error ? error.message : String(error);
					logger?.(
						`[fixbot] github-poll error: enqueue failed for ${owner}/${repo}#${issue.number}: ${msg}`,
					);
					errors++;
					continue;
				}

				// Post ack comment if token is available
				if (githubConfig.token) {
					await postAckComment(owner, repo, issue.number, jobSpec.jobId, githubConfig.token, logger);
				}
			}
		}

		// ---------------------------------------------------------------
		// 2. Assignment-triggered polling
		// ---------------------------------------------------------------

		const botUser = validateBotUsername(githubConfig.botUsername);
		if (botUser) {
			const assignedIssues = await fetchAssignedIssues(owner, repo, botUser, githubConfig.token, logger);

			for (const issue of assignedIssues) {
				const trigger = `assign:${botUser}`;

				// Dedup: skip if ack comment already exists for this issue
				const ackResult = await hasAckComment(owner, repo, issue.number, githubConfig.token, logger);
				if (ackResult.found) {
					skipped++;
					continue;
				}

				const jobSpec = buildGitHubJobSpec(
					repoConfig.url,
					repoConfig.baseBranch,
					issue.number,
					0,
					trigger,
					"solve_issue",
					issue.title,
					issue.body ?? undefined,
				);
				const artifactPaths = getArtifactPaths(resultsDir, jobSpec.jobId);
				const envelope: DaemonJobEnvelopeV1 = {
					version: DAEMON_JOB_ENVELOPE_VERSION_V1,
					jobId: jobSpec.jobId,
					job: jobSpec,
					submission: {
						kind: "github-assignment",
						githubRepo: `${owner}/${repo}`,
						githubIssueNumber: issue.number,
					},
					enqueuedAt: new Date().toISOString(),
					artifacts: {
						artifactDir: artifactPaths.artifactDir,
						resultFile: artifactPaths.resultFile,
					},
				};

				try {
					enqueueFn(envelope);
					enqueued.push(jobSpec.jobId);
					logger?.(
						`[fixbot] github-poll: enqueued solve_issue job for ${owner}/${repo}#${issue.number} (assignment: ${botUser})`,
					);
				} catch (error) {
					if (error instanceof DuplicateDaemonJobError) {
						skipped++;
						continue;
					}
					const msg = error instanceof Error ? error.message : String(error);
					logger?.(
						`[fixbot] github-poll error: enqueue failed for ${owner}/${repo}#${issue.number}: ${msg}`,
					);
					errors++;
					continue;
				}

				// Post ack comment if token is available
				if (githubConfig.token) {
					await postAckComment(owner, repo, issue.number, jobSpec.jobId, githubConfig.token, logger);
				}
			}
		}
	}

	logger?.(
		`[fixbot] github-poll repos=${githubConfig.repos.length} enqueued=${enqueued.length} skipped=${skipped} errors=${errors} cancelled=${cancelled}`,
	);

	return { enqueued, skipped, errors, cancelled };
}
