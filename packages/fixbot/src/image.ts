import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCommand, spawnCommandOrThrow } from "./command";

const DEFAULT_DOCKER_IMAGE = "fixbot-runner:local";
const RUNNER_IMAGE_VERSION = "2026-03-16.4";
const RUNNER_IMAGE_VERSION_LABEL = "io.pi.fixbot.runner-image-version";

interface DockerBuildAsset {
	path: string;
	required: boolean;
}

export interface DockerBuildContext {
	contextDir: string;
	dockerfilePath: string;
	imageName: string;
}

const DOCKER_BUILD_ASSETS: DockerBuildAsset[] = [
	{ path: "package.json", required: true },
	{ path: "package-lock.json", required: true },
	{ path: "packages/ai/package.json", required: true },
	{ path: "packages/ai/dist", required: true },
	{ path: "packages/ai/bedrock-provider.js", required: true },
	{ path: "packages/agent/package.json", required: true },
	{ path: "packages/agent/dist", required: true },
	{ path: "packages/tui/package.json", required: true },
	{ path: "packages/tui/dist", required: true },
	{ path: "packages/coding-agent/package.json", required: true },
	{ path: "packages/coding-agent/dist", required: true },
	{ path: "packages/coding-agent/docs", required: true },
	{ path: "packages/fixbot/package.json", required: true },
	{ path: "packages/fixbot/dist", required: true },
	{ path: "packages/fixbot/Dockerfile", required: true },
];

function logProgress(message: string): void {
	process.stderr.write(`[fixbot] ${message}\n`);
}

function getRepoRoot(): string {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	return join(currentDir, "..", "..", "..");
}

export function getDockerImageName(env: NodeJS.ProcessEnv = process.env): string {
	const configuredImage = env.FIXBOT_DOCKER_IMAGE?.trim();
	return configuredImage && configuredImage !== "" ? configuredImage : DEFAULT_DOCKER_IMAGE;
}

export function getDockerImageBuildCommand(): string {
	return "npm run fixbot -- image build";
}

export function getRunnerImageVersion(): string {
	return RUNNER_IMAGE_VERSION;
}

export function getRunnerImageVersionLabel(): string {
	return RUNNER_IMAGE_VERSION_LABEL;
}

function assertDockerBuildAssetsExist(repoRoot: string): void {
	const missing = DOCKER_BUILD_ASSETS.filter((asset) => asset.required && !existsSync(join(repoRoot, asset.path))).map(
		(asset) => asset.path,
	);

	if (missing.length === 0) {
		return;
	}

	throw new Error(
		[
			"fixbot image build requires prebuilt runtime artifacts before building the runner image.",
			"",
			"Build the required workspace packages first, then rerun `fixbot image build`.",
			"",
			"Missing runtime assets:",
			...missing.map((entry) => `- ${entry}`),
		].join("\n"),
	);
}

function copyBuildAsset(repoRoot: string, contextDir: string, relativePath: string): void {
	const sourcePath = join(repoRoot, relativePath);
	if (!existsSync(sourcePath)) {
		return;
	}

	const targetPath = join(contextDir, relativePath);
	mkdirSync(dirname(targetPath), { recursive: true });
	if (statSync(sourcePath).isDirectory()) {
		cpSync(sourcePath, targetPath, { recursive: true });
		return;
	}
	cpSync(sourcePath, targetPath);
}

export function stageDockerBuildContext(
	repoRoot: string = getRepoRoot(),
	env: NodeJS.ProcessEnv = process.env,
): DockerBuildContext {
	assertDockerBuildAssetsExist(repoRoot);
	const contextDir = mkdtempSync(join(tmpdir(), "fixbot-image-"));

	try {
		for (const asset of DOCKER_BUILD_ASSETS) {
			copyBuildAsset(repoRoot, contextDir, asset.path);
		}
		return {
			contextDir,
			dockerfilePath: join(contextDir, "packages", "fixbot", "Dockerfile"),
			imageName: getDockerImageName(env),
		};
	} catch (error) {
		rmSync(contextDir, { recursive: true, force: true });
		throw error;
	}
}

export function buildMissingDockerImageError(imageName: string): Error {
	return new Error(
		[
			`Runner image ${imageName} is not available.`,
			"",
			"Build it before running docker jobs:",
			`  ${getDockerImageBuildCommand()}`,
		].join("\n"),
	);
}

export function buildStaleDockerImageError(imageName: string, actualVersion: string | undefined): Error {
	const actualVersionLine = actualVersion
		? `Current image version: ${actualVersion}`
		: "Current image version: missing";

	return new Error(
		[
			`Runner image ${imageName} is stale and cannot be used.`,
			actualVersionLine,
			`Expected image version: ${RUNNER_IMAGE_VERSION}`,
			"",
			"Rebuild it before running docker jobs:",
			`  ${getDockerImageBuildCommand()}`,
		].join("\n"),
	);
}

async function readDockerImageVersion(imageName: string): Promise<string | undefined> {
	const inspectResult = await spawnCommand("docker", [
		"image",
		"inspect",
		imageName,
		"--format",
		`{{ index .Config.Labels ${JSON.stringify(RUNNER_IMAGE_VERSION_LABEL)} }}`,
	]);
	if (inspectResult.exitCode !== 0) {
		return undefined;
	}
	const version = inspectResult.stdout.trim();
	return version === "" ? undefined : version;
}

export async function assertDockerImageReady(imageName: string = getDockerImageName()): Promise<string> {
	try {
		await spawnCommandOrThrow("docker", ["image", "inspect", imageName]);
	} catch {
		throw buildMissingDockerImageError(imageName);
	}

	const actualVersion = await readDockerImageVersion(imageName);
	if (actualVersion !== RUNNER_IMAGE_VERSION) {
		throw buildStaleDockerImageError(imageName, actualVersion);
	}

	return imageName;
}

export async function buildDockerImage(
	repoRoot: string = getRepoRoot(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const buildContext = stageDockerBuildContext(repoRoot, env);
	try {
		logProgress(`building Docker image ${buildContext.imageName}`);
		await spawnCommandOrThrow(
			"docker",
			[
				"build",
				"--label",
				`${RUNNER_IMAGE_VERSION_LABEL}=${RUNNER_IMAGE_VERSION}`,
				"-t",
				buildContext.imageName,
				"-f",
				buildContext.dockerfilePath,
				buildContext.contextDir,
			],
			{
				cwd: buildContext.contextDir,
				onStdout: (chunk) => process.stderr.write(chunk),
				onStderr: (chunk) => process.stderr.write(chunk),
			},
		);
		return buildContext.imageName;
	} finally {
		rmSync(buildContext.contextDir, { recursive: true, force: true });
	}
}

export function getDockerBuildAssets(): string[] {
	return DOCKER_BUILD_ASSETS.map((asset) => asset.path);
}
