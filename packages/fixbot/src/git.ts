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

export async function configureLocalGitIdentity(workspaceDir: string): Promise<void> {
	await spawnCommandOrThrow("git", ["config", "user.name", "fixbot"], { cwd: workspaceDir });
	await spawnCommandOrThrow("git", ["config", "user.email", "fixbot@local.invalid"], { cwd: workspaceDir });
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
