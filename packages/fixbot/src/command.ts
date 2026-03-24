import { spawn } from "node:child_process";

export interface SpawnCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	input?: string;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface SpawnCommandResult {
	exitCode: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export class CommandExecutionError extends Error {
	command: string;
	args: string[];
	result: SpawnCommandResult;

	constructor(command: string, args: string[], result: SpawnCommandResult) {
		const rendered = [command, ...args].join(" ");
		const stderr = result.stderr.trim();
		super(stderr ? `${rendered} failed: ${stderr}` : `${rendered} failed with exit code ${result.exitCode}`);
		this.name = "CommandExecutionError";
		this.command = command;
		this.args = args;
		this.result = result;
	}
}

export class CommandTimeoutError extends Error {
	command: string;
	args: string[];
	timeoutMs: number;
	stdout: string;
	stderr: string;

	constructor(command: string, args: string[], timeoutMs: number, stdout: string, stderr: string) {
		super(`${[command, ...args].join(" ")} timed out after ${timeoutMs}ms`);
		this.name = "CommandTimeoutError";
		this.command = command;
		this.args = args;
		this.timeoutMs = timeoutMs;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

export async function spawnCommand(
	command: string,
	args: string[],
	options: SpawnCommandOptions = {},
): Promise<SpawnCommandResult> {
	return new Promise<SpawnCommandResult>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: "pipe",
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timer) {
				clearTimeout(timer);
			}
		};

		child.stdout?.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			stdout += text;
			options.onStdout?.(text);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			stderr += text;
			options.onStderr?.(text);
		});
		child.on("error", error => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(error);
		});
		child.on("close", (exitCode, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve({
				exitCode: exitCode ?? (signal ? 1 : 0),
				signal,
				stdout,
				stderr,
			});
		});

		if (options.input !== undefined) {
			child.stdin?.write(options.input);
		}
		child.stdin?.end();

		if (options.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				child.kill("SIGTERM");
				setTimeout(() => {
					child.kill("SIGKILL");
				}, 2000).unref();
				reject(new CommandTimeoutError(command, args, options.timeoutMs as number, stdout, stderr));
			}, options.timeoutMs);
		}
	});
}

export async function spawnCommandOrThrow(
	command: string,
	args: string[],
	options: SpawnCommandOptions = {},
): Promise<SpawnCommandResult> {
	const result = await spawnCommand(command, args, options);
	if (result.exitCode !== 0) {
		throw new CommandExecutionError(command, args, result);
	}
	return result;
}
