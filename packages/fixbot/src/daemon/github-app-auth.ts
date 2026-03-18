import { createSign } from "node:crypto";

export interface TokenCache {
	token: string;
	expiresAt: Date;
}

function toBase64Url(obj: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function createAppJWT(appId: number, privateKeyPem: string, nowSec?: number): string {
	const now = nowSec ?? Math.floor(Date.now() / 1000);
	const header = toBase64Url({ alg: "RS256", typ: "JWT" });
	const payload = toBase64Url({ iss: appId, iat: now - 60, exp: now + 600 });
	const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem, "base64url");
	return `${header}.${payload}.${signature}`;
}

export function isTokenExpiringSoon(cache: TokenCache, thresholdMs?: number): boolean {
	return cache.expiresAt.getTime() - Date.now() < (thresholdMs ?? 300_000);
}

export async function exchangeInstallationToken(
	appId: number,
	privateKeyPem: string,
	installationId: number,
	fetchFn?: typeof fetch,
): Promise<TokenCache> {
	const jwt = createAppJWT(appId, privateKeyPem);
	const doFetch = fetchFn ?? fetch;
	const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
	const response = await doFetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "fixbot",
		},
	});
	if (response.status !== 201) {
		const body = await response.text();
		throw new Error(`GitHub App token exchange failed (HTTP ${response.status}): ${body}`);
	}
	const data = (await response.json()) as { token: string; expires_at: string };
	return { token: data.token, expiresAt: new Date(data.expires_at) };
}
