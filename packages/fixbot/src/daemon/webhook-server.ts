import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getArtifactPaths } from "../artifacts";
import { normalizeJobSpec } from "../contracts";
import { parseOwnerRepo } from "../github-utils";
import type { Logger } from "../logger";
import {
	DAEMON_JOB_ENVELOPE_VERSION_V1,
	type DaemonJobEnvelopeV1,
	type NormalizedDaemonConfigV1,
	type NormalizedDaemonGitHubRepoConfig,
	type NormalizedDaemonWebhookConfig,
	type NormalizedJobSpecV1,
	type TaskClass,
	type WebhookHealthMetrics,
} from "../types";
import { DuplicateDaemonJobError, enqueueDaemonJob } from "./job-store";

// ---------------------------------------------------------------------------
// Rate limiter (sliding window, per-repo)
// ---------------------------------------------------------------------------

interface RateLimitBucket {
	timestamps: number[];
}

export class SlidingWindowRateLimiter {
	private readonly buckets = new Map<string, RateLimitBucket>();
	private readonly windowMs: number;
	private readonly limit: number;

	constructor(limit: number, windowMs: number = 60_000) {
		this.limit = limit;
		this.windowMs = windowMs;
	}

	/** Returns true if the request is allowed (within rate limit). */
	allow(key: string): boolean {
		const now = Date.now();
		const cutoff = now - this.windowMs;
		let bucket = this.buckets.get(key);
		if (!bucket) {
			bucket = { timestamps: [] };
			this.buckets.set(key, bucket);
		}
		// Prune old entries
		bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
		if (bucket.timestamps.length >= this.limit) {
			return false;
		}
		bucket.timestamps.push(now);
		return true;
	}

	reset(): void {
		this.buckets.clear();
	}
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export function verifyWebhookSignature(payload: string, signatureHeader: string, secret: string): boolean {
	if (!signatureHeader.startsWith("sha256=")) {
		return false;
	}
	const receivedHex = signatureHeader.slice("sha256=".length);
	const expectedHex = createHmac("sha256", secret).update(payload).digest("hex");
	const expected = Buffer.from(expectedHex, "hex");
	const received = Buffer.from(receivedHex, "hex");
	if (expected.length !== received.length) {
		return false;
	}
	return timingSafeEqual(expected, received);
}

// ---------------------------------------------------------------------------
// Helpers shared with github-poller
// ---------------------------------------------------------------------------

export function findRepoConfig(
	config: NormalizedDaemonConfigV1,
	repoFullName: string,
): NormalizedDaemonGitHubRepoConfig | undefined {
	const fullNameLower = repoFullName.toLowerCase();
	return config.github?.repos.find((r) => {
		try {
			const parsed = parseOwnerRepo(r.url);
			return `${parsed.owner}/${parsed.repo}`.toLowerCase() === fullNameLower;
		} catch {
			return r.url.toLowerCase() === fullNameLower;
		}
	});
}

export function deriveWebhookJobId(repoUrl: string, issueNumber: number, deliveryId: string): string {
	const hex = createHash("sha256")
		.update(`${repoUrl}/${issueNumber}/webhook/${deliveryId}`)
		.digest("hex")
		.slice(0, 16);
	return `wh-${hex}`;
}

export function buildWebhookJobSpec(
	repoUrl: string,
	baseBranch: string,
	issueNumber: number,
	deliveryId: string,
	taskClass: TaskClass = "solve_issue",
	issueTitle?: string,
	issueBody?: string,
): NormalizedJobSpecV1 {
	const jobId = deriveWebhookJobId(repoUrl, issueNumber, deliveryId);
	const spec: Record<string, unknown> = {
		version: "fixbot.job/v1",
		jobId,
		taskClass,
		repo: { url: repoUrl, baseBranch },
		execution: { mode: "process", timeoutMs: 1_800_000, memoryLimitMb: 4096 },
	};
	if (taskClass === "fix_ci") {
		spec.fixCi = { githubActionsRunId: 1 };
	} else if (taskClass === "solve_issue") {
		spec.solveIssue = {
			issueNumber,
			...(issueTitle ? { issueTitle } : {}),
			...(issueBody ? { issueBody } : {}),
		};
	}
	return normalizeJobSpec(spec, "webhook job");
}

export function createGitHubEnvelope(
	jobSpec: NormalizedJobSpecV1,
	repoFullName: string,
	issueNumber: number,
	deliveryId: string,
	resultsDir: string,
	labelName?: string,
): DaemonJobEnvelopeV1 {
	const artifactPaths = getArtifactPaths(resultsDir, jobSpec.jobId);
	return {
		version: DAEMON_JOB_ENVELOPE_VERSION_V1,
		jobId: jobSpec.jobId,
		job: jobSpec,
		submission: {
			kind: "github-webhook",
			githubRepo: repoFullName,
			githubIssueNumber: issueNumber,
			...(labelName ? { githubLabelName: labelName } : {}),
			githubDeliveryId: deliveryId,
		},
		enqueuedAt: new Date().toISOString(),
		artifacts: {
			artifactDir: artifactPaths.artifactDir,
			resultFile: artifactPaths.resultFile,
		},
	};
}

// ---------------------------------------------------------------------------
// Webhook event handlers
// ---------------------------------------------------------------------------

interface WebhookPayload {
	action: string;
	issue?: {
		number: number;
		title: string;
		body: string | null;
	};
	assignee?: { login: string };
	label?: { name: string };
	comment?: { body: string };
	pull_request?: { number: number; title: string; body: string | null };
	repository: { full_name: string };
	sender?: { login: string };
}

function handleIssuesLabeled(
	payload: WebhookPayload,
	config: NormalizedDaemonConfigV1,
	deliveryId: string,
	logger?: Logger,
): DaemonJobEnvelopeV1 | null {
	if (!payload.issue || !payload.label) {
		logger?.warn("webhook: issues.labeled event missing issue or label");
		return null;
	}

	const repoFullName = payload.repository.full_name;
	const repoConfig = findRepoConfig(config, repoFullName);
	if (!repoConfig) {
		logger?.info(`webhook: ignoring event for unconfigured repo ${repoFullName}`);
		return null;
	}

	const labelName = payload.label.name;
	const allLabels = new Set([repoConfig.triggerLabel]);
	if (repoConfig.taskClassOverrides) {
		for (const label of Object.keys(repoConfig.taskClassOverrides)) {
			allLabels.add(label);
		}
	}
	if (!allLabels.has(labelName)) {
		logger?.info(`webhook: ignoring label "${labelName}" for ${repoFullName}`);
		return null;
	}

	const taskClass: TaskClass = repoConfig.taskClassOverrides?.[labelName] ?? "solve_issue";
	const jobSpec = buildWebhookJobSpec(
		repoConfig.url,
		repoConfig.baseBranch,
		payload.issue.number,
		deliveryId,
		taskClass,
		payload.issue.title,
		payload.issue.body ?? undefined,
	);

	return createGitHubEnvelope(
		jobSpec,
		repoFullName,
		payload.issue.number,
		deliveryId,
		config.paths.resultsDir,
		labelName,
	);
}

function handleIssuesAssigned(
	payload: WebhookPayload,
	config: NormalizedDaemonConfigV1,
	deliveryId: string,
	logger?: Logger,
): DaemonJobEnvelopeV1 | null {
	if (!payload.issue) {
		logger?.warn("webhook: issues.assigned event missing issue");
		return null;
	}

	// Only trigger when the issue is assigned to the configured bot user.
	const botUsername = config.github?.botUsername;
	const assigneeLogin = payload.assignee?.login;
	if (!botUsername) {
		logger?.info("webhook: ignoring issues.assigned — no github.botUsername configured");
		return null;
	}
	if (assigneeLogin?.toLowerCase() !== botUsername.toLowerCase()) {
		logger?.info(`webhook: ignoring issues.assigned — assignee "${assigneeLogin}" is not bot user "${botUsername}"`);
		return null;
	}

	const repoFullName = payload.repository.full_name;
	const repoConfig = findRepoConfig(config, repoFullName);
	if (!repoConfig) {
		logger?.info(`webhook: ignoring event for unconfigured repo ${repoFullName}`);
		return null;
	}

	const jobSpec = buildWebhookJobSpec(
		repoConfig.url,
		repoConfig.baseBranch,
		payload.issue.number,
		deliveryId,
		"solve_issue",
		payload.issue.title,
		payload.issue.body ?? undefined,
	);

	return createGitHubEnvelope(
		jobSpec,
		repoFullName,
		payload.issue.number,
		deliveryId,
		config.paths.resultsDir,
	);
}

function handlePRReviewComment(
	payload: WebhookPayload,
	config: NormalizedDaemonConfigV1,
	deliveryId: string,
	logger?: Logger,
): DaemonJobEnvelopeV1 | null {
	if (!payload.pull_request || !payload.comment) {
		logger?.warn("webhook: pull_request_review_comment.created event missing PR or comment");
		return null;
	}

	const repoFullName = payload.repository.full_name;
	const repoConfig = findRepoConfig(config, repoFullName);
	if (!repoConfig) {
		logger?.info(`webhook: ignoring event for unconfigured repo ${repoFullName}`);
		return null;
	}

	const jobSpec = buildWebhookJobSpec(
		repoConfig.url,
		repoConfig.baseBranch,
		payload.pull_request.number,
		deliveryId,
		"solve_issue",
		payload.pull_request.title,
		payload.pull_request.body ?? undefined,
	);

	return createGitHubEnvelope(
		jobSpec,
		repoFullName,
		payload.pull_request.number,
		deliveryId,
		config.paths.resultsDir,
	);
}

// ---------------------------------------------------------------------------
// Webhook event routing
// ---------------------------------------------------------------------------

export function routeWebhookEvent(
	eventType: string,
	payload: WebhookPayload,
	config: NormalizedDaemonConfigV1,
	deliveryId: string,
	logger?: Logger,
): DaemonJobEnvelopeV1 | null {
	const action = payload.action;
	const eventAction = `${eventType}.${action}`;

	switch (eventAction) {
		case "issues.labeled":
			return handleIssuesLabeled(payload, config, deliveryId, logger);
		case "issues.assigned":
			return handleIssuesAssigned(payload, config, deliveryId, logger);
		case "pull_request_review_comment.created":
			return handlePRReviewComment(payload, config, deliveryId, logger);
		default:
			logger?.info(`webhook: ignoring unhandled event ${eventAction}`);
			return null;
	}
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface WebhookServer {
	readonly port: number;
	readonly metrics: WebhookHealthMetrics;
	stop(): Promise<void>;
}

export interface WebhookServerOptions {
	config: NormalizedDaemonConfigV1;
	webhookConfig: NormalizedDaemonWebhookConfig;
	logger?: Logger;
}

export function createWebhookServer(options: WebhookServerOptions): WebhookServer {
	const { config, webhookConfig, logger } = options;

	const metrics: WebhookHealthMetrics = {
		receivedCount: 0,
		acceptedCount: 0,
		rejectedCount: 0,
		rateLimitedCount: 0,
		lastReceivedAt: null,
	};

	const rateLimiter = new SlidingWindowRateLimiter(webhookConfig.rateLimitPerRepoPerMin);

	const server = Bun.serve({
		port: webhookConfig.port,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);

			// Health endpoint
			if (req.method === "GET" && url.pathname === "/healthz") {
				return Response.json({ status: "ok", ...metrics });
			}

			// Only accept POST to /webhook
			if (req.method !== "POST" || url.pathname !== "/webhook") {
				return new Response("Not Found", { status: 404 });
			}

			metrics.receivedCount++;
			metrics.lastReceivedAt = new Date().toISOString();

			const body = await req.text();

			// Verify signature
			const signatureHeader = req.headers.get("x-hub-signature-256") ?? "";
			if (!verifyWebhookSignature(body, signatureHeader, webhookConfig.secret)) {
				metrics.rejectedCount++;
				logger?.warn("webhook: signature verification failed");
				return new Response("Unauthorized", { status: 401 });
			}

			const eventType = req.headers.get("x-github-event") ?? "";
			const deliveryId = req.headers.get("x-github-delivery") ?? `unknown-${Date.now()}`;

			if (!eventType) {
				metrics.rejectedCount++;
				return new Response("Missing X-GitHub-Event header", { status: 400 });
			}

			let payload: WebhookPayload;
			try {
				payload = JSON.parse(body) as WebhookPayload;
			} catch {
				metrics.rejectedCount++;
				return new Response("Invalid JSON", { status: 400 });
			}

			const repoFullName = payload.repository?.full_name;
			if (!repoFullName) {
				metrics.rejectedCount++;
				return new Response("Missing repository.full_name", { status: 400 });
			}

			if (!rateLimiter.allow(repoFullName)) {
				metrics.rateLimitedCount++;
				logger?.warn(`webhook: rate limited for ${repoFullName}`);
				return new Response("Rate Limited", { status: 429 });
			}

			const envelope = routeWebhookEvent(eventType, payload, config, deliveryId, logger);
			if (!envelope) {
				return Response.json({ status: "ignored", deliveryId });
			}

			try {
				enqueueDaemonJob(config, envelope);
				metrics.acceptedCount++;
				logger?.info(
					`webhook: enqueued ${envelope.job.taskClass} job ${envelope.jobId} for ${repoFullName} (delivery: ${deliveryId})`,
				);
				return Response.json({ status: "queued", jobId: envelope.jobId, deliveryId });
			} catch (error) {
				if (error instanceof DuplicateDaemonJobError) {
					logger?.info(`webhook: duplicate job skipped for ${repoFullName} (delivery: ${deliveryId})`);
					return Response.json({ status: "duplicate", jobId: envelope.jobId, deliveryId });
				}
				const msg = error instanceof Error ? error.message : String(error);
				logger?.error(`webhook: enqueue failed for ${repoFullName}: ${msg}`);
				return new Response("Internal Server Error", { status: 500 });
			}
		},
	});

	logger?.info(`webhook: server listening on port ${webhookConfig.port}`);

	return {
		get port() {
			return server.port;
		},
		get metrics() {
			return { ...metrics };
		},
		async stop() {
			server.stop(true);
			rateLimiter.reset();
			logger?.info("webhook: server stopped");
		},
	};
}
