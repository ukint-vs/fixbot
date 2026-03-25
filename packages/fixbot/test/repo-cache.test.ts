import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseOwnerRepo } from "../src/github-utils";
import {
	cleanupWorktree,
	DEFAULT_REPO_CACHE_CONFIG,
	evictLRU,
	getCacheStats,
	getOrCreateWorkspace,
	repair,
	type WorkspaceResult,
} from "../src/repo-cache";
import type { RepoCacheConfig } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpRoot(): string {
	const dir = join(tmpdir(), `fixbot-repo-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Create a local git repo that can be used as a remote origin. */
function createOriginRepo(rootDir: string, name = "origin-repo"): string {
	const repoDir = join(rootDir, name);
	mkdirSync(repoDir, { recursive: true });
	execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
	execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: repoDir });
	writeFileSync(join(repoDir, "README.md"), "# hello\n");
	execFileSync("git", ["add", "."], { cwd: repoDir });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });
	return repoDir;
}

function makeConfig(rootDir: string, overrides?: Partial<RepoCacheConfig>): RepoCacheConfig {
	return {
		...DEFAULT_REPO_CACHE_CONFIG,
		dir: join(rootDir, "cache"),
		maxRepos: 5,
		maxDiskMb: 5000,
		staleBranchDays: 7,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// parseOwnerRepo (from github-utils)
// ---------------------------------------------------------------------------

describe("parseOwnerRepo", () => {
	it("parses HTTPS URL", () => {
		expect(parseOwnerRepo("https://github.com/acme/widgets")).toEqual({
			owner: "acme",
			repo: "widgets",
		});
	});

	it("parses HTTPS URL with .git suffix", () => {
		expect(parseOwnerRepo("https://github.com/acme/widgets.git")).toEqual({
			owner: "acme",
			repo: "widgets",
		});
	});

	it("parses owner/repo shorthand", () => {
		expect(parseOwnerRepo("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
	});

	it("throws on invalid URL", () => {
		expect(() => parseOwnerRepo("https://github.com/only-one")).toThrow();
	});

	it("throws on single segment shorthand", () => {
		expect(() => parseOwnerRepo("only-one")).toThrow();
	});
});

// ---------------------------------------------------------------------------
// getOrCreateWorkspace
// ---------------------------------------------------------------------------

describe("getOrCreateWorkspace", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = tmpRoot();
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("creates a bare clone and worktree for a new repo", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		const result = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "test-001",
			config,
			logger: () => {},
		});

		expect(result.fromCache).toBe(false);
		expect(existsSync(result.workspaceDir)).toBe(true);
		expect(existsSync(join(result.workspaceDir, "README.md"))).toBe(true);
		expect(result.worktreeBranch).toBe("_worktree/job-test-001");
	});

	it("reuses bare clone on second call (fromCache=true)", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		const first = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "job-a",
			config,
			logger: () => {},
		});
		expect(first.fromCache).toBe(false);

		const second = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "job-b",
			config,
			logger: () => {},
		});
		expect(second.fromCache).toBe(true);
		expect(second.bareDir).toBe(first.bareDir);
		expect(second.workspaceDir).not.toBe(first.workspaceDir);
	});

	it("worktree has correct content from base branch", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		const result = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "content-check",
			config,
			logger: () => {},
		});

		const readme = readFileSync(join(result.workspaceDir, "README.md"), "utf-8");
		expect(readme).toBe("# hello\n");
	});

	it("fetches latest changes when reusing bare clone", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		// First call to seed cache
		await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "seed",
			config,
			logger: () => {},
		});

		// Push new content to origin
		writeFileSync(join(origin, "NEW.md"), "new file\n");
		execFileSync("git", ["add", "."], { cwd: origin });
		execFileSync("git", ["commit", "-m", "add NEW.md"], { cwd: origin });

		// Second call should see new content
		const result = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "updated",
			config,
			logger: () => {},
		});
		expect(existsSync(join(result.workspaceDir, "NEW.md"))).toBe(true);
	});

	it("auto-repairs corrupted bare clone", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		// Seed cache
		const first = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "before-corrupt",
			config,
			logger: () => {},
		});

		// Corrupt the bare repo by deleting HEAD
		const headFile = join(first.bareDir, "HEAD");
		if (existsSync(headFile)) {
			rmSync(headFile);
		}

		// Next call should repair and still succeed
		const result = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "after-corrupt",
			config,
			logger: () => {},
		});
		expect(existsSync(result.workspaceDir)).toBe(true);
		expect(result.fromCache).toBe(false); // was re-cloned
	});
});

// ---------------------------------------------------------------------------
// cleanupWorktree
// ---------------------------------------------------------------------------

describe("cleanupWorktree", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = tmpRoot();
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("removes a worktree created by getOrCreateWorkspace", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		const result = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "to-cleanup",
			config,
			logger: () => {},
		});
		expect(existsSync(result.workspaceDir)).toBe(true);

		await cleanupWorktree(result.bareDir, "to-cleanup", () => {});
		expect(existsSync(result.workspaceDir)).toBe(false);
	});

	it("is safe to call twice (idempotent)", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		const result = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "double-cleanup",
			config,
			logger: () => {},
		});

		await cleanupWorktree(result.bareDir, "double-cleanup", () => {});
		// Second call should not throw
		await cleanupWorktree(result.bareDir, "double-cleanup", () => {});
	});
});

// ---------------------------------------------------------------------------
// evictLRU
// ---------------------------------------------------------------------------

describe("evictLRU", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = tmpRoot();
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("evicts oldest repos when cache exceeds maxRepos", async () => {
		const config = makeConfig(rootDir, { maxRepos: 2 });

		// Create 3 origin repos
		const repos: string[] = [];
		for (let i = 0; i < 3; i++) {
			repos.push(createOriginRepo(rootDir, `repo-${i}`));
		}

		// Populate cache with 3 repos
		for (let i = 0; i < 3; i++) {
			await getOrCreateWorkspace({
				repoUrl: repos[i],
				baseBranch: "main",
				jobId: `evict-${i}`,
				config,
				logger: () => {},
			});
		}

		// After the 3rd, eviction should have removed the first repo
		// (since maxRepos=2, the oldest should be evicted)
		const stats = getCacheStats(config);
		expect(stats.repos).toBeLessThanOrEqual(2);
	});

	it("does nothing when under the limit", async () => {
		const config = makeConfig(rootDir, { maxRepos: 10 });
		const origin = createOriginRepo(rootDir);

		await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "no-evict",
			config,
			logger: () => {},
		});

		const stats = getCacheStats(config);
		expect(stats.repos).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// repair
// ---------------------------------------------------------------------------

describe("repair", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = tmpRoot();
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("re-clones a bare repo after deletion", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		const result = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "pre-repair",
			config,
			logger: () => {},
		});

		await repair(result.bareDir, origin, () => {});
		expect(existsSync(result.bareDir)).toBe(true);

		// Verify it's a working bare repo by creating a new worktree
		const result2 = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "post-repair",
			config,
			logger: () => {},
		});
		expect(existsSync(result2.workspaceDir)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getCacheStats
// ---------------------------------------------------------------------------

describe("getCacheStats", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = tmpRoot();
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("returns zeros for empty cache", () => {
		const config = makeConfig(rootDir);
		const stats = getCacheStats(config);
		expect(stats.repos).toBe(0);
		expect(stats.activeWorktrees).toBe(0);
	});

	it("counts repos and worktrees", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "stat-1",
			config,
			logger: () => {},
		});
		await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "stat-2",
			config,
			logger: () => {},
		});

		const stats = getCacheStats(config);
		expect(stats.repos).toBe(1);
		expect(stats.activeWorktrees).toBe(2);
	});

	it("decrements worktree count after cleanup", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		const result = await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "stat-cleanup",
			config,
			logger: () => {},
		});

		await cleanupWorktree(result.bareDir, "stat-cleanup", () => {});

		const stats = getCacheStats(config);
		expect(stats.repos).toBe(1);
		expect(stats.activeWorktrees).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe("DEFAULT_REPO_CACHE_CONFIG", () => {
	it("has sensible defaults", () => {
		expect(DEFAULT_REPO_CACHE_CONFIG.enabled).toBe(true);
		expect(DEFAULT_REPO_CACHE_CONFIG.maxRepos).toBeGreaterThan(0);
		expect(DEFAULT_REPO_CACHE_CONFIG.maxDiskMb).toBeGreaterThan(0);
		expect(DEFAULT_REPO_CACHE_CONFIG.staleBranchDays).toBeGreaterThan(0);
		expect(DEFAULT_REPO_CACHE_CONFIG.dir).toContain(".fixbot");
	});
});

// ---------------------------------------------------------------------------
// Cache metadata persistence
// ---------------------------------------------------------------------------

describe("cache metadata", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = tmpRoot();
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("persists metadata across calls", async () => {
		const origin = createOriginRepo(rootDir);
		const config = makeConfig(rootDir);

		await getOrCreateWorkspace({
			repoUrl: origin,
			baseBranch: "main",
			jobId: "meta-1",
			config,
			logger: () => {},
		});

		const metaFile = join(config.dir, "cache-meta.json");
		expect(existsSync(metaFile)).toBe(true);
		const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
		expect(meta.version).toBe(1);
		expect(meta.entries.length).toBeGreaterThan(0);
	});
});
