/**
 * PR comment tracker and poller for the comment-addressing feature.
 *
 * Maintains a JSON-persisted list of PRs that fixbot has opened. On each poll
 * cycle it fetches new review comments since the last check and returns them
 * grouped per PR for the comment-addresser to process.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubApiFetch } from "./github-api";
import type { PRTrackerEntry, PRTrackerState } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PR_TRACKER_VERSION = "fixbot.pr-tracker/v1" as const;
const PR_TRACKER_FILENAME = "pr-tracker.json";
const MAX_COMMENTS_PER_CYCLE = 10;
const MAX_CYCLES_PER_PR = 5;
const BLOCKED_EXPIRY_DAYS = 7;
const UNBLOCK_PHRASES = ["fixbot continue", "fixbot retry"];

// ---------------------------------------------------------------------------
// Comment types
// ---------------------------------------------------------------------------

export interface PRReviewComment {
	id: number;
	body: string;
	user: string;
	path?: string;
	line?: number;
	createdAt: string;
}

export interface PRCommentPollResult {
	entry: PRTrackerEntry;
	comments: PRReviewComment[];
	hasMore: boolean;
}

// ---------------------------------------------------------------------------
// PR Tracker persistence
// ---------------------------------------------------------------------------

export function loadPRTracker(stateDir: string): PRTrackerState {
	const filePath = join(stateDir, PR_TRACKER_FILENAME);
	if (!existsSync(filePath)) {
		return { version: PR_TRACKER_VERSION, entries: [] };
	}
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as PRTrackerState;
		if (parsed.version !== PR_TRACKER_VERSION) {
			return { version: PR_TRACKER_VERSION, entries: [] };
		}
		return parsed;
	} catch {
		return { version: PR_TRACKER_VERSION, entries: [] };
	}
}

export function savePRTracker(stateDir: string, state: PRTrackerState): void {
	mkdirSync(stateDir, { recursive: true });
	const filePath = join(stateDir, PR_TRACKER_FILENAME);
	writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export function registerPR(
	stateDir: string,
	entry: Omit<PRTrackerEntry, "lastCheckedAt" | "lastProcessedCommentId" | "cycleCount" | "createdAt">,
): void {
	const state = loadPRTracker(stateDir);
	const existing = state.entries.find(
		(e) => e.owner === entry.owner && e.repo === entry.repo && e.prNumber === entry.prNumber,
	);
	if (existing) {
		return;
	}
	const now = new Date().toISOString();
	state.entries.push({
		...entry,
		createdAt: now,
		lastCheckedAt: now,
		lastProcessedCommentId: 0,
		cycleCount: 0,
	});
	savePRTracker(stateDir, state);
}

// ---------------------------------------------------------------------------
// Comment sanitisation
// ---------------------------------------------------------------------------

const HTML_TAG_RE = /<\/?[^>]+(>|$)/g;
const MAX_COMMENT_BODY_CHARS = 4_000;

export function sanitizeCommentBody(body: string): string {
	return body.replace(HTML_TAG_RE, "").slice(0, MAX_COMMENT_BODY_CHARS).trim();
}

// ---------------------------------------------------------------------------
// Blocked-state helpers
// ---------------------------------------------------------------------------

function isBlocked(entry: PRTrackerEntry): boolean {
	if (!entry.blockedAt) return false;
	const blockedAt = new Date(entry.blockedAt).getTime();
	const expiryMs = BLOCKED_EXPIRY_DAYS * 24 * 60 * 60 * 1_000;
	if (Date.now() - blockedAt > expiryMs) {
		return false;
	}
	return true;
}

function containsUnblockPhrase(body: string): boolean {
	const lower = body.toLowerCase();
	return UNBLOCK_PHRASES.some((phrase) => lower.includes(phrase));
}

// ---------------------------------------------------------------------------
// Comment fetching
// ---------------------------------------------------------------------------

interface GitHubReviewComment {
	id: number;
	body: string;
	user?: { login?: string };
	path?: string;
	line?: number | null;
	created_at: string;
}

interface GitHubIssueComment {
	id: number;
	body?: string;
	user?: { login?: string };
	created_at: string;
}

/**
 * Fetch review comments on a pull request, filtering to those newer than
 * `sinceCommentId`.  Returns at most `MAX_COMMENTS_PER_CYCLE` comments and
 * a flag indicating whether more remain.
 */
export async function fetchNewPRComments(
	owner: string,
	repo: string,
	prNumber: number,
	sinceCommentId: number,
	token: string,
	botUsername?: string,
	logger?: (message: string) => void,
): Promise<{ comments: PRReviewComment[]; hasMore: boolean }> {
	const [reviewRes, issueRes] = await Promise.all([
		githubApiFetch(
			`/repos/${owner}/${repo}/pulls/${prNumber}/comments?sort=created&direction=asc&per_page=100`,
			{},
			token,
			logger,
		),
		githubApiFetch(
			`/repos/${owner}/${repo}/issues/${prNumber}/comments?sort=created&direction=asc&per_page=100`,
			{},
			token,
			logger,
		),
	]);

	const allComments: PRReviewComment[] = [];

	if (reviewRes.ok) {
		const reviewComments = (await reviewRes.json()) as GitHubReviewComment[];
		for (const c of reviewComments) {
			if (c.id <= sinceCommentId) continue;
			if (botUsername && c.user?.login === botUsername) continue;
			if (c.body?.includes("<!-- fixbot-")) continue;
			allComments.push({
				id: c.id,
				body: sanitizeCommentBody(c.body ?? ""),
				user: c.user?.login ?? "unknown",
				path: c.path,
				line: c.line ?? undefined,
				createdAt: c.created_at,
			});
		}
	}

	if (issueRes.ok) {
		const issueComments = (await issueRes.json()) as GitHubIssueComment[];
		for (const c of issueComments) {
			if (c.id <= sinceCommentId) continue;
			if (botUsername && c.user?.login === botUsername) continue;
			if (c.body?.includes("<!-- fixbot-")) continue;
			allComments.push({
				id: c.id,
				body: sanitizeCommentBody(c.body ?? ""),
				user: c.user?.login ?? "unknown",
				createdAt: c.created_at,
			});
		}
	}

	allComments.sort((a, b) => a.id - b.id);

	const hasMore = allComments.length > MAX_COMMENTS_PER_CYCLE;
	const comments = allComments.slice(0, MAX_COMMENTS_PER_CYCLE);

	return { comments, hasMore };
}

// ---------------------------------------------------------------------------
// Main poll function
// ---------------------------------------------------------------------------

export interface CommentPollCycleResult {
	actionable: PRCommentPollResult[];
	skipped: number;
	unblocked: number;
	errors: number;
}

export async function pollPRComments(
	stateDir: string,
	token: string,
	botUsername?: string,
	logger?: (message: string) => void,
): Promise<CommentPollCycleResult> {
	const state = loadPRTracker(stateDir);
	const actionable: PRCommentPollResult[] = [];
	let skipped = 0;
	let unblocked = 0;
	let errors = 0;

	const now = Date.now();
	state.entries = state.entries.filter((entry) => {
		if (entry.blockedAt) {
			const blockedAt = new Date(entry.blockedAt).getTime();
			const expiryMs = BLOCKED_EXPIRY_DAYS * 24 * 60 * 60 * 1_000;
			if (now - blockedAt > expiryMs) {
				logger?.(`[fixbot] comment-poll: removing expired blocked PR ${entry.owner}/${entry.repo}#${entry.prNumber}`);
				return false;
			}
		}
		return true;
	});

	for (const entry of state.entries) {
		try {
			const { comments, hasMore } = await fetchNewPRComments(
				entry.owner,
				entry.repo,
				entry.prNumber,
				entry.lastProcessedCommentId,
				token,
				botUsername,
				logger,
			);

			if (isBlocked(entry)) {
				const unblockComment = comments.find((c) => containsUnblockPhrase(c.body));
				if (unblockComment) {
					entry.blockedAt = undefined;
					entry.blockedReason = undefined;
					unblocked++;
					logger?.(
						`[fixbot] comment-poll: unblocked PR ${entry.owner}/${entry.repo}#${entry.prNumber} by ${unblockComment.user}`,
					);
					entry.lastProcessedCommentId = unblockComment.id;
					entry.lastCheckedAt = new Date().toISOString();
					const refetch = await fetchNewPRComments(
						entry.owner,
						entry.repo,
						entry.prNumber,
						entry.lastProcessedCommentId,
						token,
						botUsername,
						logger,
					);
					if (refetch.comments.length > 0) {
						actionable.push({ entry, comments: refetch.comments, hasMore: refetch.hasMore });
					} else {
						skipped++;
					}
				} else {
					skipped++;
				}
				continue;
			}

			if (comments.length === 0) {
				entry.lastCheckedAt = new Date().toISOString();
				skipped++;
				continue;
			}

			if (entry.cycleCount >= MAX_CYCLES_PER_PR) {
				entry.blockedAt = new Date().toISOString();
				entry.blockedReason = `max cycles (${MAX_CYCLES_PER_PR}) reached`;
				logger?.(
					`[fixbot] comment-poll: blocking PR ${entry.owner}/${entry.repo}#${entry.prNumber} — max cycles reached`,
				);
				skipped++;
				continue;
			}

			entry.lastCheckedAt = new Date().toISOString();
			actionable.push({ entry, comments, hasMore });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger?.(
				`[fixbot] comment-poll error: ${entry.owner}/${entry.repo}#${entry.prNumber}: ${msg}`,
			);
			errors++;
		}
	}

	savePRTracker(stateDir, state);
	return { actionable, skipped, unblocked, errors };
}

export function markCycleComplete(
	stateDir: string,
	owner: string,
	repo: string,
	prNumber: number,
	lastProcessedCommentId: number,
): void {
	const state = loadPRTracker(stateDir);
	const entry = state.entries.find(
		(e) => e.owner === owner && e.repo === repo && e.prNumber === prNumber,
	);
	if (entry) {
		entry.lastProcessedCommentId = lastProcessedCommentId;
		entry.cycleCount++;
		entry.lastCheckedAt = new Date().toISOString();
	}
	savePRTracker(stateDir, state);
}

export function markPRBlocked(
	stateDir: string,
	owner: string,
	repo: string,
	prNumber: number,
	reason: string,
): void {
	const state = loadPRTracker(stateDir);
	const entry = state.entries.find(
		(e) => e.owner === owner && e.repo === repo && e.prNumber === prNumber,
	);
	if (entry) {
		entry.blockedAt = new Date().toISOString();
		entry.blockedReason = reason;
	}
	savePRTracker(stateDir, state);
}
