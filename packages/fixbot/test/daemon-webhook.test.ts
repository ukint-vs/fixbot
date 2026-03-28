import { createHmac } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { normalizeDaemonConfig } from "../src/config";
import type { NormalizedDaemonConfigV1, NormalizedDaemonWebhookConfig } from "../src/types";
import {
	createWebhookServer,
	deriveWebhookJobId,
	findRepoConfig,
	routeWebhookEvent,
	SlidingWindowRateLimiter,
	verifyWebhookSignature,
	type WebhookServer,
} from "../src/daemon/webhook-server";
import { createCapturingLogger } from "../src/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret-abc123";

function signPayload(payload: string, secret: string): string {
	return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

function makeTestConfig(overrides?: Partial<NormalizedDaemonWebhookConfig>): NormalizedDaemonConfigV1 {
	const tempDir = join(tmpdir(), `fixbot-webhook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempDir, "state", "queue"), { recursive: true });
	mkdirSync(join(tempDir, "state", "active"), { recursive: true });
	mkdirSync(join(tempDir, "results"), { recursive: true });

	const baseConfig = normalizeDaemonConfig(
		{
			version: "fixbot.daemon-config/v1",
			paths: {
				stateDir: join(tempDir, "state"),
				resultsDir: join(tempDir, "results"),
			},
			github: {
				repos: [
					{
						url: "https://github.com/testowner/testrepo",
						baseBranch: "main",
						triggerLabel: "fixbot",
						taskClassOverrides: {
							"fixbot:ci": "fix_ci",
						},
					},
					{
						url: "https://github.com/other/project",
						baseBranch: "develop",
						triggerLabel: "autofix",
					},
				],
				token: "ghp_testtoken",
				botUsername: "fixbot-app",
			},
			webhook: {
				enabled: true,
				port: 19876,
				secret: overrides?.secret ?? TEST_SECRET,
				...(overrides?.rateLimitPerRepoPerMin
					? { rateLimitPerRepoPerMin: overrides.rateLimitPerRepoPerMin }
					: {}),
			},
		},
		"<inline>",
	);
	// Override port to 0 so Bun picks a random available port (bypass config validation)
	if (baseConfig.webhook) {
		(baseConfig.webhook as any).port = 0;
	}
	return baseConfig;
}

function cleanupDir(config: NormalizedDaemonConfigV1): void {
	try {
		rmSync(config.paths.stateDir, { recursive: true, force: true });
		rmSync(config.paths.resultsDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup failures in tests
	}
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature", () => {
	it("accepts valid HMAC-SHA256 signature", () => {
		const payload = '{"action":"labeled"}';
		const sig = signPayload(payload, TEST_SECRET);
		expect(verifyWebhookSignature(payload, sig, TEST_SECRET)).toBe(true);
	});

	it("rejects invalid signature", () => {
		const payload = '{"action":"labeled"}';
		const sig = signPayload(payload, "wrong-secret");
		expect(verifyWebhookSignature(payload, sig, TEST_SECRET)).toBe(false);
	});

	it("rejects missing sha256= prefix", () => {
		const payload = '{"action":"labeled"}';
		const hex = createHmac("sha256", TEST_SECRET).update(payload).digest("hex");
		expect(verifyWebhookSignature(payload, hex, TEST_SECRET)).toBe(false);
	});

	it("rejects empty signature", () => {
		expect(verifyWebhookSignature("{}", "", TEST_SECRET)).toBe(false);
	});

	it("rejects tampered payload", () => {
		const payload = '{"action":"labeled"}';
		const sig = signPayload(payload, TEST_SECRET);
		expect(verifyWebhookSignature('{"action":"opened"}', sig, TEST_SECRET)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe("SlidingWindowRateLimiter", () => {
	it("allows requests within limit", () => {
		const limiter = new SlidingWindowRateLimiter(3, 60_000);
		expect(limiter.allow("repo-a")).toBe(true);
		expect(limiter.allow("repo-a")).toBe(true);
		expect(limiter.allow("repo-a")).toBe(true);
	});

	it("rejects requests over limit", () => {
		const limiter = new SlidingWindowRateLimiter(2, 60_000);
		expect(limiter.allow("repo-a")).toBe(true);
		expect(limiter.allow("repo-a")).toBe(true);
		expect(limiter.allow("repo-a")).toBe(false);
	});

	it("tracks repos independently", () => {
		const limiter = new SlidingWindowRateLimiter(1, 60_000);
		expect(limiter.allow("repo-a")).toBe(true);
		expect(limiter.allow("repo-b")).toBe(true);
		expect(limiter.allow("repo-a")).toBe(false);
		expect(limiter.allow("repo-b")).toBe(false);
	});

	it("reset clears all buckets", () => {
		const limiter = new SlidingWindowRateLimiter(1, 60_000);
		expect(limiter.allow("repo-a")).toBe(true);
		expect(limiter.allow("repo-a")).toBe(false);
		limiter.reset();
		expect(limiter.allow("repo-a")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// findRepoConfig
// ---------------------------------------------------------------------------

describe("findRepoConfig", () => {
	it("finds repo config by full name", () => {
		const config = makeTestConfig();
		const found = findRepoConfig(config, "testowner/testrepo");
		expect(found).toBeDefined();
		expect(found!.url).toBe("https://github.com/testowner/testrepo");
		cleanupDir(config);
	});

	it("finds repo config case-insensitively", () => {
		const config = makeTestConfig();
		const found = findRepoConfig(config, "TestOwner/TestRepo");
		expect(found).toBeDefined();
		expect(found!.url).toBe("https://github.com/testowner/testrepo");
		cleanupDir(config);
	});

	it("returns undefined for unconfigured repo", () => {
		const config = makeTestConfig();
		const found = findRepoConfig(config, "unknown/repo");
		expect(found).toBeUndefined();
		cleanupDir(config);
	});
});

// ---------------------------------------------------------------------------
// deriveWebhookJobId
// ---------------------------------------------------------------------------

describe("deriveWebhookJobId", () => {
	it("produces deterministic IDs with wh- prefix", () => {
		const id = deriveWebhookJobId("https://github.com/o/r", 42, "delivery-123");
		expect(id).toMatch(/^wh-[a-f0-9]{16}$/);
	});

	it("produces different IDs for different delivery IDs", () => {
		const id1 = deriveWebhookJobId("https://github.com/o/r", 42, "delivery-1");
		const id2 = deriveWebhookJobId("https://github.com/o/r", 42, "delivery-2");
		expect(id1).not.toBe(id2);
	});

	it("produces different IDs for different issues", () => {
		const id1 = deriveWebhookJobId("https://github.com/o/r", 1, "delivery-1");
		const id2 = deriveWebhookJobId("https://github.com/o/r", 2, "delivery-1");
		expect(id1).not.toBe(id2);
	});
});

// ---------------------------------------------------------------------------
// routeWebhookEvent
// ---------------------------------------------------------------------------

describe("routeWebhookEvent", () => {
	it("routes issues.labeled to enqueue", () => {
		const config = makeTestConfig();
		const logger = createCapturingLogger();
		const envelope = routeWebhookEvent(
			"issues",
			{
				action: "labeled",
				issue: { number: 10, title: "Fix bug", body: "Details here" },
				label: { name: "fixbot" },
				repository: { full_name: "testowner/testrepo" },
			},
			config,
			"delivery-abc",
			logger,
		);

		expect(envelope).not.toBeNull();
		expect(envelope!.submission.kind).toBe("github-webhook");
		expect(envelope!.submission.githubRepo).toBe("testowner/testrepo");
		expect(envelope!.submission.githubIssueNumber).toBe(10);
		expect(envelope!.submission.githubDeliveryId).toBe("delivery-abc");
		expect(envelope!.submission.githubLabelName).toBe("fixbot");
		expect(envelope!.job.taskClass).toBe("solve_issue");
		cleanupDir(config);
	});

	it("routes issues.labeled with taskClassOverride", () => {
		const config = makeTestConfig();
		const envelope = routeWebhookEvent(
			"issues",
			{
				action: "labeled",
				issue: { number: 10, title: "CI broken", body: null },
				label: { name: "fixbot:ci" },
				repository: { full_name: "testowner/testrepo" },
			},
			config,
			"delivery-def",
		);

		expect(envelope).not.toBeNull();
		expect(envelope!.job.taskClass).toBe("fix_ci");
		cleanupDir(config);
	});

	it("ignores issues.labeled for non-matching label", () => {
		const config = makeTestConfig();
		const envelope = routeWebhookEvent(
			"issues",
			{
				action: "labeled",
				issue: { number: 10, title: "Bug", body: null },
				label: { name: "unrelated-label" },
				repository: { full_name: "testowner/testrepo" },
			},
			config,
			"delivery-ghi",
		);

		expect(envelope).toBeNull();
		cleanupDir(config);
	});

	it("ignores events for unconfigured repos", () => {
		const config = makeTestConfig();
		const envelope = routeWebhookEvent(
			"issues",
			{
				action: "labeled",
				issue: { number: 10, title: "Bug", body: null },
				label: { name: "fixbot" },
				repository: { full_name: "unknown/repo" },
			},
			config,
			"delivery-jkl",
		);

		expect(envelope).toBeNull();
		cleanupDir(config);
	});

	it("routes issues.assigned when assignee matches botUsername", () => {
		const config = makeTestConfig();
		const envelope = routeWebhookEvent(
			"issues",
			{
				action: "assigned",
				issue: { number: 5, title: "Assigned bug", body: "Fix this" },
				assignee: { login: "fixbot-app" },
				repository: { full_name: "testowner/testrepo" },
			},
			config,
			"delivery-mno",
		);

		expect(envelope).not.toBeNull();
		expect(envelope!.submission.kind).toBe("github-webhook");
		expect(envelope!.job.taskClass).toBe("solve_issue");
		cleanupDir(config);
	});

	it("ignores issues.assigned when assignee does not match botUsername", () => {
		const config = makeTestConfig();
		const logger = createCapturingLogger();
		const envelope = routeWebhookEvent(
			"issues",
			{
				action: "assigned",
				issue: { number: 5, title: "Assigned bug", body: "Fix this" },
				assignee: { login: "some-human" },
				repository: { full_name: "testowner/testrepo" },
			},
			config,
			"delivery-mno-skip",
			logger,
		);

		expect(envelope).toBeNull();
		expect(logger.lines.some((l) => l.includes("not bot user"))).toBe(true);
		cleanupDir(config);
	});

	it("ignores issues.assigned when botUsername is not configured", () => {
		const config = makeTestConfig();
		// Remove botUsername
		if (config.github) {
			(config.github as any).botUsername = undefined;
		}
		const logger = createCapturingLogger();
		const envelope = routeWebhookEvent(
			"issues",
			{
				action: "assigned",
				issue: { number: 5, title: "Assigned bug", body: "Fix this" },
				assignee: { login: "fixbot-app" },
				repository: { full_name: "testowner/testrepo" },
			},
			config,
			"delivery-mno-nobot",
			logger,
		);

		expect(envelope).toBeNull();
		expect(logger.lines.some((l) => l.includes("no github.botUsername configured"))).toBe(true);
		cleanupDir(config);
	});

	it("routes pull_request_review_comment.created", () => {
		const config = makeTestConfig();
		const envelope = routeWebhookEvent(
			"pull_request_review_comment",
			{
				action: "created",
				pull_request: { number: 99, title: "PR title", body: "PR body" },
				comment: { body: "Please fix this" },
				repository: { full_name: "testowner/testrepo" },
			},
			config,
			"delivery-pqr",
		);

		expect(envelope).not.toBeNull();
		expect(envelope!.submission.kind).toBe("github-webhook");
		expect(envelope!.submission.githubIssueNumber).toBe(99);
		cleanupDir(config);
	});

	it("ignores unhandled event types", () => {
		const config = makeTestConfig();
		const logger = createCapturingLogger();
		const envelope = routeWebhookEvent(
			"push",
			{
				action: "completed",
				repository: { full_name: "testowner/testrepo" },
			},
			config,
			"delivery-stu",
			logger,
		);

		expect(envelope).toBeNull();
		expect(logger.lines.some((l) => l.includes("ignoring unhandled event"))).toBe(true);
		cleanupDir(config);
	});

	it("routes issues.labeled for second configured repo", () => {
		const config = makeTestConfig();
		const envelope = routeWebhookEvent(
			"issues",
			{
				action: "labeled",
				issue: { number: 7, title: "Other project bug", body: null },
				label: { name: "autofix" },
				repository: { full_name: "other/project" },
			},
			config,
			"delivery-vwx",
		);

		expect(envelope).not.toBeNull();
		expect(envelope!.submission.githubRepo).toBe("other/project");
		cleanupDir(config);
	});
});

// ---------------------------------------------------------------------------
// HTTP server integration tests
// ---------------------------------------------------------------------------

describe("webhook HTTP server", () => {
	let server: WebhookServer;
	let config: NormalizedDaemonConfigV1;
	let baseUrl: string;

	beforeEach(() => {
		config = makeTestConfig();
		const logger = createCapturingLogger();
		server = createWebhookServer({
			config,
			webhookConfig: config.webhook!,
			logger,
		});
		baseUrl = `http://localhost:${server.port}`;
	});

	afterEach(async () => {
		await server.stop();
		cleanupDir(config);
	});

	it("responds to /healthz with metrics", async () => {
		const res = await fetch(`${baseUrl}/healthz`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
		expect(body.receivedCount).toBe(0);
	});

	it("rejects GET to /webhook", async () => {
		const res = await fetch(`${baseUrl}/webhook`);
		expect(res.status).toBe(404);
	});

	it("rejects POST to unknown path", async () => {
		const res = await fetch(`${baseUrl}/unknown`, { method: "POST" });
		expect(res.status).toBe(404);
	});

	it("rejects POST with invalid signature", async () => {
		const payload = JSON.stringify({
			action: "labeled",
			issue: { number: 1, title: "t", body: null },
			label: { name: "fixbot" },
			repository: { full_name: "testowner/testrepo" },
		});
		const res = await fetch(`${baseUrl}/webhook`, {
			method: "POST",
			body: payload,
			headers: {
				"x-hub-signature-256": "sha256=invalid",
				"x-github-event": "issues",
				"x-github-delivery": "test-delivery",
			},
		});
		expect(res.status).toBe(401);
		expect(server.metrics.rejectedCount).toBe(1);
	});

	it("rejects POST with missing event header", async () => {
		const payload = JSON.stringify({
			action: "labeled",
			repository: { full_name: "testowner/testrepo" },
		});
		const sig = signPayload(payload, TEST_SECRET);
		const res = await fetch(`${baseUrl}/webhook`, {
			method: "POST",
			body: payload,
			headers: {
				"x-hub-signature-256": sig,
			},
		});
		expect(res.status).toBe(400);
	});

	it("accepts valid issues.labeled and enqueues job", async () => {
		const payload = JSON.stringify({
			action: "labeled",
			issue: { number: 42, title: "Fix memory leak", body: "Details" },
			label: { name: "fixbot" },
			repository: { full_name: "testowner/testrepo" },
		});
		const sig = signPayload(payload, TEST_SECRET);
		const res = await fetch(`${baseUrl}/webhook`, {
			method: "POST",
			body: payload,
			headers: {
				"x-hub-signature-256": sig,
				"x-github-event": "issues",
				"x-github-delivery": "delivery-001",
			},
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("queued");
		expect(body.jobId).toBeDefined();
		expect(body.deliveryId).toBe("delivery-001");
		expect(server.metrics.acceptedCount).toBe(1);
	});

	it("returns duplicate for same delivery replayed", async () => {
		const payload = JSON.stringify({
			action: "labeled",
			issue: { number: 42, title: "Fix memory leak", body: "Details" },
			label: { name: "fixbot" },
			repository: { full_name: "testowner/testrepo" },
		});
		const sig = signPayload(payload, TEST_SECRET);
		const headers = {
			"x-hub-signature-256": sig,
			"x-github-event": "issues",
			"x-github-delivery": "delivery-dup",
		};

		const res1 = await fetch(`${baseUrl}/webhook`, { method: "POST", body: payload, headers });
		expect(res1.status).toBe(200);
		const body1 = await res1.json();
		expect(body1.status).toBe("queued");

		// Same delivery ID produces same job ID → duplicate
		const res2 = await fetch(`${baseUrl}/webhook`, { method: "POST", body: payload, headers });
		expect(res2.status).toBe(200);
		const body2 = await res2.json();
		expect(body2.status).toBe("duplicate");
	});

	it("returns ignored for unmatched event", async () => {
		const payload = JSON.stringify({
			action: "opened",
			repository: { full_name: "testowner/testrepo" },
		});
		const sig = signPayload(payload, TEST_SECRET);
		const res = await fetch(`${baseUrl}/webhook`, {
			method: "POST",
			body: payload,
			headers: {
				"x-hub-signature-256": sig,
				"x-github-event": "push",
				"x-github-delivery": "delivery-ignored",
			},
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ignored");
	});

	it("rate limits excessive requests per repo", async () => {
		// Create server with very low rate limit
		await server.stop();
		cleanupDir(config);
		config = makeTestConfig({ rateLimitPerRepoPerMin: 2 });
		server = createWebhookServer({
			config,
			webhookConfig: config.webhook!,
		});
		baseUrl = `http://localhost:${server.port}`;

		async function sendEvent(deliveryId: string): Promise<Response> {
			const payload = JSON.stringify({
				action: "labeled",
				issue: { number: 100, title: "Rate test", body: null },
				label: { name: "fixbot" },
				repository: { full_name: "testowner/testrepo" },
			});
			return fetch(`${baseUrl}/webhook`, {
				method: "POST",
				body: payload,
				headers: {
					"x-hub-signature-256": signPayload(payload, TEST_SECRET),
					"x-github-event": "issues",
					"x-github-delivery": deliveryId,
				},
			});
		}

		const r1 = await sendEvent("rl-1");
		expect(r1.status).toBe(200);

		const r2 = await sendEvent("rl-2");
		expect(r2.status).toBe(200);

		// Third should be rate limited
		const r3 = await sendEvent("rl-3");
		expect(r3.status).toBe(429);
		expect(server.metrics.rateLimitedCount).toBe(1);
	});

	it("tracks metrics across multiple requests", async () => {
		// Valid request
		const payload = JSON.stringify({
			action: "labeled",
			issue: { number: 1, title: "t", body: null },
			label: { name: "fixbot" },
			repository: { full_name: "testowner/testrepo" },
		});
		await fetch(`${baseUrl}/webhook`, {
			method: "POST",
			body: payload,
			headers: {
				"x-hub-signature-256": signPayload(payload, TEST_SECRET),
				"x-github-event": "issues",
				"x-github-delivery": "metrics-1",
			},
		});

		// Invalid signature
		await fetch(`${baseUrl}/webhook`, {
			method: "POST",
			body: payload,
			headers: {
				"x-hub-signature-256": "sha256=bad",
				"x-github-event": "issues",
				"x-github-delivery": "metrics-2",
			},
		});

		const m = server.metrics;
		expect(m.receivedCount).toBe(2);
		expect(m.acceptedCount).toBe(1);
		expect(m.rejectedCount).toBe(1);
		expect(m.lastReceivedAt).not.toBeNull();
	});
});
