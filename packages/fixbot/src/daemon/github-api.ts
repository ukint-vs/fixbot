/**
 * Shared GitHub API fetch wrapper with exponential backoff for 429/5xx responses.
 *
 * Used by comment-poller, comment-addresser, and github-reporter.
 * The github-poller keeps its own lightweight wrapper for backward compatibility.
 */

const GITHUB_API_BASE = "https://api.github.com";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;

/**
 * Perform a GitHub API request with exponential backoff on 429 and 5xx.
 *
 * On retryable status codes the call sleeps for `INITIAL_BACKOFF_MS * 2^attempt`
 * before retrying, up to `MAX_RETRIES` times.  Non-retryable errors (4xx other
 * than 429) are returned immediately.
 */
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

	let lastResponse: Response | undefined;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		lastResponse = await fetch(fullUrl, init);
		const status = lastResponse.status;

		// Non-retryable success or client error (except 429)
		if (status < 500 && status !== 429) {
			if (status < 200 || status >= 300) {
				logger?.(`[fixbot] github-api warn: ${options.method ?? "GET"} ${url} returned ${status}`);
			}
			return lastResponse;
		}

		// Retryable: 429 or 5xx
		if (attempt < MAX_RETRIES) {
			const backoffMs = INITIAL_BACKOFF_MS * 2 ** attempt;
			logger?.(
				`[fixbot] github-api warn: ${options.method ?? "GET"} ${url} returned ${status}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
			);
			await sleep(backoffMs);
		}
	}

	// Exhausted retries — return last response as-is
	logger?.(
		`[fixbot] github-api warn: ${options.method ?? "GET"} ${url} returned ${lastResponse!.status} after ${MAX_RETRIES} retries`,
	);
	return lastResponse!;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
