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

export function deriveGitHubJobId(repoUrl: string, issueNumber: number, labelName: string): string {
	const hex = createHash("sha256").update(`${repoUrl}/${issueNumber}/${labelName}`).digest("hex").slice(0, 16);
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

export async function fetchLabeledIssues(
	owner: string,
	repo: string,
	label: string,
	token?: string,
	logger?: (message: string) => void,
): Promise<Array<{ number: number; title: string; body: string | null }>> {
	const path = `/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`;
	let response: Response;
	try {
		response = await githubApiFetch(path, token);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(`[fixbot] github-poll warn: fetchLabeledIssues network error for ${owner}/${repo}: ${msg}`);
		return [];
	}
	if (response.status !== 200) {
		logger?.(`[fixbot] github-poll warn: fetchLabeledIssues ${owner}/${repo} returned ${response.status}`);
		return [];
	}
	let data: Array<{ number: number; title: string; body: string | null }>;
	try {
		data = (await response.json()) as Array<{ number: number; title: string; body: string | null }>;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(`[fixbot] github-poll warn: fetchLabeledIssues ${owner}/${repo} malformed JSON: ${msg}`);
		return [];
	}
	return data.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body ?? null }));
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

export async function hasAckComment(
	owner: string,
	repo: string,
	issueNumber: number,
	token?: string,
	logger?: (message: string) => void,
): Promise<boolean> {
	const path = `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
	let response: Response;
	try {
		response = await githubApiFetch(path, token);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(
			`[fixbot] github-poll warn: hasAckComment network error for ${owner}/${repo}#${issueNumber}: ${msg}`,
		);
		return false;
	}
	if (response.status !== 200) {
		logger?.(
			`[fixbot] github-poll warn: hasAckComment ${owner}/${repo}#${issueNumber} returned ${response.status}`,
		);
		return false;
	}
	let comments: Array<{ body?: string }>;
	try {
		comments = (await response.json()) as Array<{ body?: string }>;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger?.(
			`[fixbot] github-poll warn: hasAckComment ${owner}/${repo}#${issueNumber} malformed JSON: ${msg}`,
		);
		return false;
	}
	return comments.some((comment) => comment.body?.includes("<!-- fixbot-ack -->"));
}

// ---------------------------------------------------------------------------
// Job spec builder
// ---------------------------------------------------------------------------

export function buildGitHubJobSpec(
	repoUrl: string,
	baseBranch: string,
	issueNumber: number,
	runId: number,
	labelName: string,
	taskClass: TaskClass = "solve_issue",
	issueTitle?: string,
	issueBody?: string,
): NormalizedJobSpecV1 {
	const jobId = deriveGitHubJobId(repoUrl, issueNumber, labelName);
	const spec: Record<string, unknown> = {
		version: "fixbot.job/v1",
		jobId,
		taskClass,
		repo: { url: repoUrl, baseBranch },
		execution: { mode: "process", timeoutMs: 600_000, memoryLimitMb: 4096 },
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
}

export type GitHubEnqueueFn = (envelope: DaemonJobEnvelopeV1) => void;

export async function pollGitHubRepos(
	githubConfig: NormalizedDaemonGitHubConfig,
	resultsDir: string,
	enqueueFn: GitHubEnqueueFn,
	logger?: (message: string) => void,
): Promise<GitHubPollResult> {
	const enqueued: string[] = [];
	let skipped = 0;
	let errors = 0;

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
				const acked = await hasAckComment(owner, repo, issue.number, githubConfig.token, logger);
				if (acked) {
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
	}

	logger?.(
		`[fixbot] github-poll repos=${githubConfig.repos.length} enqueued=${enqueued.length} skipped=${skipped} errors=${errors}`,
	);

	return { enqueued, skipped, errors };
}
