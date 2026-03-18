import { afterEach, beforeEach, describe, expect, it, vi, mock } from "bun:test";
import { runLoginCommand, runLogoutCommand } from "../../src/cli/login-cli";

// Mock discoverAuthStorage
const mockHas = vi.fn<(provider: string) => boolean>();
const mockGet = vi.fn();
const mockGetOAuthCredential = vi.fn();
const mockLogin = vi.fn();
const mockLogout = vi.fn();

const mockAuthStorage = {
	has: mockHas,
	get: mockGet,
	getOAuthCredential: mockGetOAuthCredential,
	login: mockLogin,
	logout: mockLogout,
};

mock.module("../../src/sdk", () => ({
	discoverAuthStorage: vi.fn().mockResolvedValue(mockAuthStorage),
}));

// Mock openPath to prevent browser opening during tests
mock.module("../../src/utils/open", () => ({
	openPath: vi.fn(),
}));

// Mock theme
mock.module("../../src/modes/theme/theme", () => ({
	theme: { status: { success: "✓", error: "✗", warning: "⚠" } },
	initTheme: vi.fn(),
}));

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("process.exit called");
	});
	mockHas.mockReset();
	mockGet.mockReset();
	mockGetOAuthCredential.mockReset();
	mockLogin.mockReset();
	mockLogout.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// =============================================================================
// Login --status
// =============================================================================

describe("login --status", () => {
	it("shows 'not logged in' for all providers when no credentials", async () => {
		mockHas.mockReturnValue(false);

		await runLoginCommand({ flags: { status: true } });

		const output = logSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(output).toContain("Provider authentication status");
		// Should list at least anthropic
		expect(output).toContain("Anthropic");
	});

	it("shows logged-in providers with expiry info", async () => {
		mockHas.mockImplementation((id: string) => id === "anthropic");
		mockGetOAuthCredential.mockImplementation((id: string) => {
			if (id === "anthropic") {
				return { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 2 * 60 * 60 * 1000 };
			}
			return undefined;
		});

		await runLoginCommand({ flags: { status: true } });

		const output = logSpy.mock.calls.map(c => String(c[0])).join("\n");
		// Anthropic should show success marker
		expect(output).toContain("Anthropic");
		// Should show expiry
		expect(output).toMatch(/expires in/);
	});

	it("shows expired credentials", async () => {
		mockHas.mockImplementation((id: string) => id === "anthropic");
		mockGetOAuthCredential.mockImplementation((id: string) => {
			if (id === "anthropic") {
				return { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() - 1000 };
			}
			return undefined;
		});

		await runLoginCommand({ flags: { status: true } });

		const output = logSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(output).toContain("expired");
	});
});

// =============================================================================
// Login with provider
// =============================================================================

describe("login with provider", () => {
	it("calls authStorage.login for a valid provider", async () => {
		mockHas.mockReturnValue(false);
		mockLogin.mockResolvedValue(undefined);

		await runLoginCommand({ provider: "anthropic", flags: {} });

		expect(mockLogin).toHaveBeenCalledTimes(1);
		const [providerId, ctrl] = mockLogin.mock.calls[0];
		expect(providerId).toBe("anthropic");
		expect(typeof ctrl.onAuth).toBe("function");
		expect(typeof ctrl.onPrompt).toBe("function");
		expect(typeof ctrl.onProgress).toBe("function");
		expect(typeof ctrl.onManualCodeInput).toBe("function");
	});

	it("shows success message after login", async () => {
		mockHas.mockReturnValue(false);
		mockLogin.mockResolvedValue(undefined);

		await runLoginCommand({ provider: "anthropic", flags: {} });

		const output = logSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(output).toContain("Successfully logged in");
		expect(output).toContain("Credentials saved");
	});

	it("warns when already logged in then re-authenticates", async () => {
		mockHas.mockReturnValue(true);
		mockLogin.mockResolvedValue(undefined);

		await runLoginCommand({ provider: "anthropic", flags: {} });

		const output = logSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(output).toContain("Already logged in");
		expect(output).toContain("Re-authenticating");
		expect(mockLogin).toHaveBeenCalledTimes(1);
	});

	it("exits with error for unknown provider", async () => {
		await expect(
			runLoginCommand({ provider: "nonexistent-provider-xyz", flags: {} }),
		).rejects.toThrow("process.exit called");

		const errOutput = errorSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(errOutput).toContain("Unknown provider");
	});

	it("exits with error when login fails", async () => {
		mockHas.mockReturnValue(false);
		mockLogin.mockRejectedValue(new Error("Token exchange failed"));

		await expect(
			runLoginCommand({ provider: "anthropic", flags: {} }),
		).rejects.toThrow("process.exit called");

		const errOutput = errorSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(errOutput).toContain("Login failed");
		expect(errOutput).toContain("Token exchange failed");
	});
});

// =============================================================================
// Logout
// =============================================================================

describe("logout", () => {
	it("calls authStorage.logout for a logged-in provider", async () => {
		mockHas.mockReturnValue(true);
		mockLogout.mockResolvedValue(undefined);

		await runLogoutCommand({ provider: "anthropic" });

		expect(mockLogout).toHaveBeenCalledWith("anthropic");
		const output = logSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(output).toContain("Successfully logged out");
	});

	it("shows 'not logged in' for a provider without credentials", async () => {
		mockHas.mockReturnValue(false);

		await runLogoutCommand({ provider: "anthropic" });

		expect(mockLogout).not.toHaveBeenCalled();
		const output = logSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(output).toContain("Not logged in");
	});

	it("exits with error for unknown provider", async () => {
		await expect(
			runLogoutCommand({ provider: "nonexistent-provider-xyz" }),
		).rejects.toThrow("process.exit called");

		const errOutput = errorSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(errOutput).toContain("Unknown provider");
	});

	it("exits with error when no provider specified", async () => {
		await expect(
			runLogoutCommand({}),
		).rejects.toThrow("process.exit called");

		const errOutput = errorSpy.mock.calls.map(c => String(c[0])).join("\n");
		expect(errOutput).toContain("Usage:");
	});
});
