import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JobArtifactPaths } from "./types";

export function getArtifactPaths(resultsDir: string, jobId: string): JobArtifactPaths {
	const resolvedResultsDir = resolve(resultsDir);
	const artifactName = `job-${jobId}`;
	const artifactDir = join(resolvedResultsDir, artifactName);

	return {
		resultsDir: resolvedResultsDir,
		resultFile: join(resolvedResultsDir, `${artifactName}.json`),
		artifactDir,
		jobSpecFile: join(artifactDir, "job-spec.json"),
		executionPlanFile: join(artifactDir, "execution-plan.json"),
		executionOutputFile: join(artifactDir, "execution-output.json"),
		workspaceDir: join(artifactDir, "workspace"),
		patchFile: join(artifactDir, "patch.diff"),
		traceFile: join(artifactDir, "trace.jsonl"),
		assistantFinalFile: join(artifactDir, "assistant-final.txt"),
		injectedContextFile: join(artifactDir, "injected-context.md"),
		isolatedAgentDir: join(artifactDir, "agent"),
		gitStatusFile: join(artifactDir, "git-status.txt"),
		todoFile: join(artifactDir, "TODO.md"),
		ciLogFile: join(artifactDir, "ci-log.txt"),
	};
}

export function resetArtifactDirectories(paths: JobArtifactPaths): void {
	mkdirSync(paths.resultsDir, { recursive: true });
	if (existsSync(paths.artifactDir)) {
		rmSync(paths.artifactDir, { recursive: true, force: true });
	}
	if (existsSync(paths.resultFile)) {
		rmSync(paths.resultFile, { force: true });
	}
	mkdirSync(paths.artifactDir, { recursive: true });
}
