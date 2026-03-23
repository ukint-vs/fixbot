import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCommandOrThrow } from "./command";

export async function cloneRepository(url: string, baseBranch: string, workspaceDir: string): Promise<void> {
	await spawnCommandOrThrow("git", [
		"clone",
		"--progress",
		"--depth",
		"1",
		"--branch",
		baseBranch,
		"--single-branch",
		url,
		workspaceDir,
	]);
}

export async function configureLocalGitIdentity(
	workspaceDir: string,
	identity?: { name: string; email: string },
): Promise<void> {
	// Fall back to a neutral bot identity when no GitHub identity is available.
	const name = identity?.name ?? "fixbot";
	const email = identity?.email ?? "fixbot@local.invalid";
	await spawnCommandOrThrow("git", ["config", "user.name", name], { cwd: workspaceDir });
	await spawnCommandOrThrow("git", ["config", "user.email", email], { cwd: workspaceDir });
}

/**
 * Attempt to configure GPG commit signing for the workspace.
 * Returns true when signing is successfully enabled, false otherwise.
 * Callers should log the result and continue without signing when this returns false.
 */
export async function tryEnableGpgSigning(
	workspaceDir: string,
	keyId?: string,
	logger?: (message: string) => void,
): Promise<boolean> {
	// Verify gpg binary is reachable before touching any config.
	try {
		await spawnCommandOrThrow("gpg", ["--version"]);
	} catch {
		logger?.("[fixbot] git: gpg not found — commit signing skipped");
		return false;
	}

	// Prefer the explicitly configured key; fall back to the global git signing key.
	let signingKey = keyId;
	if (!signingKey) {
		try {
			const result = await spawnCommandOrThrow("git", ["config", "--global", "user.signingKey"]);
			signingKey = result.stdout.trim() || undefined;
		} catch {
			// No global signing key configured — not an error.
		}
	}

	if (!signingKey) {
		logger?.("[fixbot] git: no GPG signing key configured — commit signing skipped");
		return false;
	}

	// Configure local overrides so they apply only to this workspace clone.
	await spawnCommandOrThrow("git", ["config", "user.signingKey", signingKey], { cwd: workspaceDir });
	await spawnCommandOrThrow("git", ["config", "commit.gpgSign", "true"], { cwd: workspaceDir });
	logger?.(`[fixbot] git: GPG signing enabled with key ${signingKey}`);
	return true;
}

export async function getHeadCommit(workspaceDir: string): Promise<string> {
	const result = await spawnCommandOrThrow("git", ["rev-parse", "HEAD"], { cwd: workspaceDir });
	return result.stdout.trim();
}

export async function capturePatch(workspaceDir: string, baseCommit: string, patchFile: string): Promise<string> {
	await spawnCommandOrThrow("git", ["add", "--intent-to-add", "--all", "."], { cwd: workspaceDir });
	const result = await spawnCommandOrThrow("git", ["diff", "--binary", "--no-color", baseCommit], {
		cwd: workspaceDir,
	});
	writeFileSync(patchFile, result.stdout, "utf-8");
	return result.stdout;
}

export async function captureGitStatus(workspaceDir: string, gitStatusFile: string): Promise<string> {
	const result = await spawnCommandOrThrow("git", ["status", "--short", "--branch", "--untracked-files=all"], {
		cwd: workspaceDir,
	});
	writeFileSync(gitStatusFile, result.stdout, "utf-8");
	return result.stdout;
}

export function countChangedFilesFromStatus(statusText: string): number {
	// Count uncommitted working-tree changes from `git status --short`
	return statusText
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("##")).length;
}

/**
 * Count files changed between baseCommit and HEAD (committed changes).
 * Falls back to 0 on error.
 */
export async function countCommittedChangedFiles(workspaceDir: string, baseCommit: string): Promise<number> {
	try {
		const result = await spawnCommandOrThrow(
			"git",
			["diff", "--name-only", baseCommit, "HEAD"],
			{ cwd: workspaceDir },
		);
		return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "").length;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Bare-clone / worktree helpers (repo-cache)
// ---------------------------------------------------------------------------

/**
 * Create a bare clone of a repository.
 * A bare clone contains only the .git directory objects and refs — no working tree.
 * This is the long-lived cache object that worktrees are created from.
 */
export async function bareCloneRepo(url: string, bareDir: string): Promise<void> {
	await spawnCommandOrThrow("git", ["clone", "--bare", url, bareDir]);
}

/**
 * After a bare clone, `remote.origin.fetch` is unset because there is no
 * default refspec in bare repos.  Configure it so that `git fetch` pulls
 * all remote branches into `refs/remotes/origin/*`.
 */
export async function configureBareFetchRefspec(bareDir: string): Promise<void> {
	await spawnCommandOrThrow(
		"git",
		["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
		{ cwd: bareDir },
	);
}

/**
 * Fetch a specific branch (or all branches when `branch` is `"*"`)
 * inside a bare repository.
 */
export async function fetchBranch(bareDir: string, branch: string): Promise<void> {
	if (branch === "*") {
		await spawnCommandOrThrow("git", ["fetch", "origin"], { cwd: bareDir });
	} else {
		await spawnCommandOrThrow("git", ["fetch", "origin", branch], { cwd: bareDir });
	}
}

/**
 * Add a new worktree checked out at `origin/{baseBranch}` on a new
 * local branch `localBranch`.
 */
export async function addWorktree(
	bareDir: string,
	worktreeDir: string,
	localBranch: string,
	baseBranch: string,
): Promise<void> {
	await spawnCommandOrThrow(
		"git",
		["worktree", "add", worktreeDir, "-b", localBranch, `origin/${baseBranch}`],
		{ cwd: bareDir },
	);
}

/**
 * Remove a worktree and delete its local branch.
 * Non-fatal: logs a warning when the worktree directory has already been deleted.
 */
export async function removeWorktree(
	bareDir: string,
	worktreeDir: string,
	localBranch: string,
	logger?: (message: string) => void,
): Promise<void> {
	try {
		await spawnCommandOrThrow("git", ["worktree", "remove", "--force", worktreeDir], { cwd: bareDir });
	} catch (err) {
		logger?.(`[fixbot] git: worktree remove failed for ${worktreeDir}: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		await spawnCommandOrThrow("git", ["branch", "-D", localBranch], { cwd: bareDir });
	} catch {
		// Branch may not exist if worktree creation failed partway.
	}
}

/**
 * Prune stale worktree bookkeeping entries that point to directories
 * that no longer exist on disk.
 */
export async function pruneWorktrees(bareDir: string): Promise<void> {
	await spawnCommandOrThrow("git", ["worktree", "prune"], { cwd: bareDir });
}

export function copyOptionalWorkspaceArtifact(
	workspaceDir: string,
	relativePath: string,
	destination: string,
): boolean {
	const source = join(workspaceDir, relativePath);
	if (!existsSync(source)) {
		return false;
	}
	copyFileSync(source, destination);
	return true;
}
