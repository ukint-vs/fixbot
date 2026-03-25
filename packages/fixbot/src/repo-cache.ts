/**
 * Repository cache — reuses bare clones across jobs.
 *
 * Layout on disk:
 *   {cacheDir}/{owner}/{repo}.git/          — bare clone
 *   {cacheDir}/{owner}/{repo}.git/worktrees/ — git-managed worktree metadata
 *   {cacheDir}/{owner}/{repo}.git/_worktrees/ — actual worktree working dirs
 *   {cacheDir}/cache-meta.json               — LRU metadata
 *
 * Each job gets its own worktree:
 *   git worktree add _worktrees/job-{id} -b _worktree/job-{id} origin/{baseBranch}
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	addWorktree,
	bareCloneRepo,
	configureBareFetchRefspec,
	fetchBranch,
	pruneWorktrees,
	removeWorktree,
} from "./git";
import { parseOwnerRepo } from "./github-utils";
import type { RepoCacheConfig, RepoCacheStats } from "./types";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_REPO_CACHE_CONFIG: RepoCacheConfig = {
	enabled: true,
	dir: join(homedir(), ".fixbot", "repos"),
	maxRepos: 20,
	maxDiskMb: 5000,
	staleBranchDays: 7,
};

// ---------------------------------------------------------------------------
// Cache metadata (atomic temp-file + rename)
// ---------------------------------------------------------------------------

interface CacheMetaEntry {
	/** owner/repo */
	key: string;
	lastUsedAt: string;
}

interface CacheMeta {
	version: 1;
	entries: CacheMetaEntry[];
}

function metaPath(cacheDir: string): string {
	return join(cacheDir, "cache-meta.json");
}

function readMeta(cacheDir: string): CacheMeta {
	const p = metaPath(cacheDir);
	if (!existsSync(p)) {
		return { version: 1, entries: [] };
	}
	try {
		const data = JSON.parse(readFileSync(p, "utf-8")) as CacheMeta;
		if (data.version === 1 && Array.isArray(data.entries)) {
			return data;
		}
	} catch {
		// Corrupted — start fresh.
	}
	return { version: 1, entries: [] };
}

function writeMeta(cacheDir: string, meta: CacheMeta): void {
	const p = metaPath(cacheDir);
	mkdirSync(dirname(p), { recursive: true });
	const tmpFile = `${p}.tmp.${process.pid}`;
	writeFileSync(tmpFile, JSON.stringify(meta, null, 2), "utf-8");
	renameSync(tmpFile, p);
}

function touchEntry(meta: CacheMeta, key: string): void {
	const now = new Date().toISOString();
	const idx = meta.entries.findIndex((e) => e.key === key);
	if (idx >= 0) {
		meta.entries[idx].lastUsedAt = now;
	} else {
		meta.entries.push({ key, lastUsedAt: now });
	}
}

// ---------------------------------------------------------------------------
// Bare directory layout
// ---------------------------------------------------------------------------

/**
 * Derive a cache key (owner, repo) from a repo URL.
 * For GitHub URLs: uses the actual owner/repo.
 * For local paths (tests): hashes the path into a synthetic key.
 */
export function deriveRepoCacheKey(repoUrl: string): { owner: string; repo: string; key: string } {
	try {
		const { owner, repo } = parseOwnerRepo(repoUrl);
		return { owner, repo, key: `${owner}/${repo}` };
	} catch {
		// Local filesystem path — derive a deterministic key.
		const hash = createHash("sha256").update(repoUrl).digest("hex").slice(0, 12);
		const name = basename(repoUrl).replace(/\.git$/, "") || "repo";
		return { owner: "_local", repo: `${name}-${hash}`, key: `_local/${name}-${hash}` };
	}
}

function bareDirForRepo(cacheDir: string, owner: string, repo: string): string {
	return join(cacheDir, owner, `${repo}.git`);
}

function worktreeBaseDirForBare(bareDir: string): string {
	return join(bareDir, "_worktrees");
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

export interface GetOrCreateWorkspaceOptions {
	repoUrl: string;
	baseBranch: string;
	jobId: string;
	config: RepoCacheConfig;
	logger?: (message: string) => void;
}

export interface WorkspaceResult {
	workspaceDir: string;
	bareDir: string;
	worktreeBranch: string;
	fromCache: boolean;
}

/**
 * Obtain a fresh worktree for a job, creating or reusing a bare clone.
 *
 * 1. If the bare clone doesn't exist → `git clone --bare`
 * 2. Fetch the latest state of `baseBranch`
 * 3. `git worktree add` a new working directory for this job
 *
 * On any git error the bare clone is deleted and re-cloned once (auto-repair).
 */
export async function getOrCreateWorkspace(opts: GetOrCreateWorkspaceOptions): Promise<WorkspaceResult> {
	const { repoUrl, baseBranch, jobId, config, logger } = opts;
	const { owner, repo, key } = deriveRepoCacheKey(repoUrl);
	const cacheDir = config.dir;
	const bareDir = bareDirForRepo(cacheDir, owner, repo);
	const worktreeBaseDir = worktreeBaseDirForBare(bareDir);
	const worktreeDir = join(worktreeBaseDir, `job-${jobId}`);
	const localBranch = `_worktree/job-${jobId}`;

	mkdirSync(dirname(bareDir), { recursive: true });

	let fromCache = true;

	// --- Ensure bare clone exists ---
	if (!existsSync(bareDir)) {
		logger?.(`[fixbot] repo-cache: bare-cloning ${repoUrl} → ${bareDir}`);
		await bareCloneRepo(repoUrl, bareDir);
		await configureBareFetchRefspec(bareDir);
		fromCache = false;
	}

	// --- Attempt fetch + worktree add (with one retry after repair) ---
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			logger?.(`[fixbot] repo-cache: fetching ${baseBranch} in ${bareDir}`);
			await fetchBranch(bareDir, baseBranch);
			await pruneWorktrees(bareDir);
			mkdirSync(worktreeBaseDir, { recursive: true });
			logger?.(`[fixbot] repo-cache: adding worktree job-${jobId} on ${baseBranch}`);
			await addWorktree(bareDir, worktreeDir, localBranch, baseBranch);

			// Update LRU metadata
			const meta = readMeta(cacheDir);
			touchEntry(meta, key);
			writeMeta(cacheDir, meta);

			// Evict if over limit
			await evictLRU(config, logger);

			return { workspaceDir: worktreeDir, bareDir, worktreeBranch: localBranch, fromCache };
		} catch (err) {
			if (attempt === 0) {
				logger?.(
					`[fixbot] repo-cache: git error, repairing ${bareDir}: ${err instanceof Error ? err.message : String(err)}`,
				);
				await repair(bareDir, repoUrl, logger);
				fromCache = false;
				continue;
			}
			throw err;
		}
	}

	// Unreachable, but satisfies TypeScript.
	throw new Error("repo-cache: unexpected fallthrough in getOrCreateWorkspace");
}

/**
 * Remove a job's worktree and its local branch from the bare repo.
 */
export async function cleanupWorktree(
	bareDir: string,
	jobId: string,
	logger?: (message: string) => void,
): Promise<void> {
	const worktreeDir = join(worktreeBaseDirForBare(bareDir), `job-${jobId}`);
	const localBranch = `_worktree/job-${jobId}`;
	logger?.(`[fixbot] repo-cache: removing worktree job-${jobId}`);
	await removeWorktree(bareDir, worktreeDir, localBranch, logger);
}

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

/**
 * Evict the least-recently-used repos when the cache exceeds `maxRepos`.
 */
export async function evictLRU(config: RepoCacheConfig, logger?: (message: string) => void): Promise<void> {
	const meta = readMeta(config.dir);
	if (meta.entries.length <= config.maxRepos) {
		return;
	}

	// Sort ascending by lastUsedAt so oldest entries are first.
	const sorted = [...meta.entries].sort(
		(a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime(),
	);

	const toEvict = sorted.slice(0, sorted.length - config.maxRepos);
	for (const entry of toEvict) {
		const [owner, repo] = entry.key.split("/");
		const bareDir = bareDirForRepo(config.dir, owner, repo);
		if (existsSync(bareDir)) {
			logger?.(`[fixbot] repo-cache: evicting ${entry.key} (last used ${entry.lastUsedAt})`);
			rmSync(bareDir, { recursive: true, force: true });
		}
		meta.entries = meta.entries.filter((e) => e.key !== entry.key);
	}

	writeMeta(config.dir, meta);
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/**
 * Delete a corrupted bare clone and re-clone from scratch.
 */
export async function repair(bareDir: string, repoUrl: string, logger?: (message: string) => void): Promise<void> {
	logger?.(`[fixbot] repo-cache: deleting corrupted ${bareDir}`);
	rmSync(bareDir, { recursive: true, force: true });
	logger?.(`[fixbot] repo-cache: re-cloning ${repoUrl}`);
	await bareCloneRepo(repoUrl, bareDir);
	await configureBareFetchRefspec(bareDir);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * Compute basic cache statistics for status reporting.
 */
export function getCacheStats(config: RepoCacheConfig): RepoCacheStats {
	const cacheDir = config.dir;
	if (!existsSync(cacheDir)) {
		return { repos: 0, activeWorktrees: 0, diskUsageMb: 0 };
	}

	const meta = readMeta(cacheDir);
	let activeWorktrees = 0;

	for (const entry of meta.entries) {
		const [owner, repo] = entry.key.split("/");
		const wtBase = worktreeBaseDirForBare(bareDirForRepo(cacheDir, owner, repo));
		if (existsSync(wtBase)) {
			try {
				activeWorktrees += readdirSync(wtBase).length;
			} catch {
				// Ignore read errors.
			}
		}
	}

	// Estimate disk usage by walking the cache directory.
	let diskUsageMb = 0;
	try {
		diskUsageMb = estimateDiskUsageMb(cacheDir);
	} catch {
		// Ignore stat errors.
	}

	return {
		repos: meta.entries.length,
		activeWorktrees,
		diskUsageMb,
	};
}

/**
 * Rough disk usage estimate in MB.
 */
function estimateDiskUsageMb(dir: string): number {
	let totalBytes = 0;

	function walkRecursive(d: string): void {
		if (!existsSync(d)) return;
		try {
			for (const entry of readdirSync(d, { withFileTypes: true })) {
				const full = join(d, entry.name);
				if (entry.isFile()) {
					try {
						totalBytes += statSync(full).size;
					} catch {
						// skip
					}
				} else if (entry.isDirectory()) {
					walkRecursive(full);
				}
			}
		} catch {
			// skip
		}
	}

	walkRecursive(dir);
	return Math.round(totalBytes / (1024 * 1024));
}
