import { describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
	createAppJWT,
	exchangeInstallationToken,
	isTokenExpiringSoon,
	type TokenCache,
} from "../src/daemon/github-app-auth";

const { privateKey: testPrivateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("createAppJWT", () => {
	it("produces a three-part dot-separated string", () => {
		const jwt = createAppJWT(12345, testPrivateKey);
		const parts = jwt.split(".");
		expect(parts).toHaveLength(3);
		expect(parts[0].length).toBeGreaterThan(0);
		expect(parts[1].length).toBeGreaterThan(0);
		expect(parts[2].length).toBeGreaterThan(0);
	});

	it("header decodes to RS256 JWT", () => {
		const jwt = createAppJWT(12345, testPrivateKey);
		const header = JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString());
		expect(header).toEqual({ alg: "RS256", typ: "JWT" });
	});

	it("payload contains correct iss, iat, and exp", () => {
		const nowSec = 1700000000;
		const jwt = createAppJWT(42, testPrivateKey, nowSec);
		const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
		expect(payload.iss).toBe(42);
		expect(payload.iat).toBe(nowSec - 60);
		expect(payload.exp).toBe(nowSec + 600);
	});

	it("uses provided nowSec parameter", () => {
		const nowSec = 1600000000;
		const jwt = createAppJWT(1, testPrivateKey, nowSec);
		const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
		expect(payload.iat).toBe(nowSec - 60);
		expect(payload.exp).toBe(nowSec + 600);
	});
});

describe("isTokenExpiringSoon", () => {
	it("returns false when token expires in 10 minutes", () => {
		const cache: TokenCache = {
			token: "tok",
			expiresAt: new Date(Date.now() + 10 * 60 * 1000),
		};
		expect(isTokenExpiringSoon(cache)).toBe(false);
	});

	it("returns true when token expires in 4 minutes", () => {
		const cache: TokenCache = {
			token: "tok",
			expiresAt: new Date(Date.now() + 4 * 60 * 1000),
		};
		expect(isTokenExpiringSoon(cache)).toBe(true);
	});

	it("returns true when token is already expired", () => {
		const cache: TokenCache = {
			token: "tok",
			expiresAt: new Date(Date.now() - 60 * 1000),
		};
		expect(isTokenExpiringSoon(cache)).toBe(true);
	});

	it("respects custom threshold parameter", () => {
		const cache: TokenCache = {
			token: "tok",
			expiresAt: new Date(Date.now() + 2 * 60 * 1000),
		};
		// 2 minutes remaining, threshold 1 minute -> not expiring soon
		expect(isTokenExpiringSoon(cache, 60_000)).toBe(false);
		// 2 minutes remaining, threshold 3 minutes -> expiring soon
		expect(isTokenExpiringSoon(cache, 180_000)).toBe(true);
	});
});

describe("exchangeInstallationToken", () => {
	it("calls correct URL with Bearer JWT auth header", async () => {
		const mockFetch = mock((_url: string, _init?: RequestInit) =>
			Promise.resolve({
				status: 201,
				json: async () => ({ token: "ghs_test123", expires_at: "2026-03-16T09:00:00Z" }),
			}),
		);

		await exchangeInstallationToken(100, testPrivateKey, 555, mockFetch as unknown as typeof fetch);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, options] = mockFetch.mock.calls[0]!;
		expect(url).toBe("https://api.github.com/app/installations/555/access_tokens");
		expect(options!.method).toBe("POST");
		const headers = options!.headers as Record<string, string>;
		expect(headers.Authorization).toMatch(/^Bearer /);
		expect(headers.Accept).toBe("application/vnd.github+json");
		expect(headers["User-Agent"]).toBe("fixbot");
	});

	it("returns parsed token and expiresAt Date", async () => {
		const expiresAt = "2026-03-16T09:00:00Z";
		const mockFetch = mock((_url: string, _init?: RequestInit) =>
			Promise.resolve({
				status: 201,
				json: async () => ({ token: "ghs_abc", expires_at: expiresAt }),
			}),
		);

		const result = await exchangeInstallationToken(1, testPrivateKey, 2, mockFetch as unknown as typeof fetch);

		expect(result.token).toBe("ghs_abc");
		expect(result.expiresAt).toEqual(new Date(expiresAt));
	});

	it("throws on non-201 response with status code in error message", async () => {
		const mockFetch = mock((_url: string, _init?: RequestInit) =>
			Promise.resolve({
				status: 403,
				text: async () => "Forbidden: app not installed",
			}),
		);

		await expect(
			exchangeInstallationToken(1, testPrivateKey, 2, mockFetch as unknown as typeof fetch),
		).rejects.toThrow("GitHub App token exchange failed (HTTP 403): Forbidden: app not installed");
	});
});
