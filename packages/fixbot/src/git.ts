import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCommandOrThrow } from "./command";

/**
 * Create a temporary GIT_ASKPASS script that echoes the token.
 * This avoids embedding the token in URLs where it could leak
 * into error messages, logs, or `.git/config`.
 */
export function createAskPassScript(token: string): string {
	const scriptPath = join(tmpdir(), `fixbot-askpass-${process.pid}-${Date.now()}.sh`);
	writeFileSync(scriptPath, `#!/bin/sh\necho "${token}"\n`, { mode: 0o700 });
	return scriptPath;
}

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

/**
 * Fetch the latest remote state and rebase the current branch onto the base branch.
 * Used by the comment-addressing cycle to ensure the PR branch is up-to-date.
 */
export async function fetchAndRebaseOnBase(
	workspaceDir: string,
	baseBranch: string,
	remoteName = "origin",
): Promise<void> {
	await spawnCommandOrThrow("git", ["fetch", remoteName, baseBranch], { cwd: workspaceDir });
	await spawnCommandOrThrow("git", ["rebase", `${remoteName}/${baseBranch}`], { cwd: workspaceDir });
}
