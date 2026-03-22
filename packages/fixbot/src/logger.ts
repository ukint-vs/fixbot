import chalk from "chalk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error" | "success";

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	success(message: string): void;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTimestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function levelLabel(level: LogLevel): string {
	switch (level) {
		case "info":
			return chalk.cyan("[INFO]");
		case "warn":
			return chalk.yellow("[WARN]");
		case "error":
			return chalk.red("[ERROR]");
		case "success":
			return chalk.green("[SUCCESS]");
	}
}

/**
 * Format a structured log line: [YYYY-MM-DD HH:MM:SS] [LEVEL] [component] message
 *
 * Exported for use in tests without chalk interaction.
 */
export function formatLogLine(level: LogLevel, component: string, message: string): string {
	return `[${formatTimestamp()}] ${levelLabel(level)} [${component}] ${message}`;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Creates a logger that writes structured, colored output to stderr.
 * Colors respect NO_COLOR and FORCE_COLOR environment variables via chalk.
 */
export function createStderrLogger(component: string): Logger {
	function emit(level: LogLevel, message: string): void {
		process.stderr.write(formatLogLine(level, component, message) + "\n");
	}
	return {
		info: (msg) => emit("info", msg),
		warn: (msg) => emit("warn", msg),
		error: (msg) => emit("error", msg),
		success: (msg) => emit("success", msg),
	};
}

/**
 * Creates a logger that discards all output.
 * Use in unit tests that don't assert on log side-effects.
 */
export function createNoopLogger(): Logger {
	return { info: () => {}, warn: () => {}, error: () => {}, success: () => {} };
}

/**
 * Creates a logger that records lines for later inspection.
 * Lines are stored as "[LEVEL] message" with no timestamp so assertions
 * remain deterministic regardless of wall-clock time.
 */
/**
 * Converts a Logger to a plain callback `(msg: string) => void` for use
 * with functions that still accept the legacy logger signature.
 * Messages are routed by prefix: "[fixbot] *warn*" → warn, "[fixbot] *error*" → error, else → info.
 */
export function toLogCallback(logger: Logger): (message: string) => void {
	return (message: string) => {
		if (message.includes("error") || message.includes("ERROR")) {
			logger.error(message);
		} else if (message.includes("warn") || message.includes("WARN")) {
			logger.warn(message);
		} else {
			logger.info(message);
		}
	};
}

export function createCapturingLogger(): Logger & { lines: string[] } {
	const lines: string[] = [];
	function record(level: string, message: string): void {
		lines.push(`[${level.toUpperCase()}] ${message}`);
	}
	return {
		lines,
		info: (msg) => record("info", msg),
		warn: (msg) => record("warn", msg),
		error: (msg) => record("error", msg),
		success: (msg) => record("success", msg),
	};
}
