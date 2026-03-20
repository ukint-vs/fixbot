/**
 * Simple stdin prompt utilities for CLI setup wizard.
 * No TUI dependency — works with plain stdin/stdout.
 */
import { createInterface } from "node:readline/promises";

let rl: ReturnType<typeof createInterface> | undefined;

function getReadline(): ReturnType<typeof createInterface> {
	if (!rl) {
		rl = createInterface({ input: process.stdin, output: process.stdout });
	}
	return rl;
}

export function closePrompt(): void {
	rl?.close();
	rl = undefined;
}

/** Close and recreate the readline interface to flush any orphaned .question()
 *  calls left by external code (e.g. upstream OAuth while(true) loops). */
export function resetPrompt(): void {
	closePrompt();
	// getReadline() lazily recreates on next ask()
}

/** Ask a question, return the trimmed answer. */
export async function ask(question: string): Promise<string> {
	const answer = await getReadline().question(question);
	return answer.trim();
}

/** Ask a question with a default value shown in brackets. */
export async function askWithDefault(question: string, defaultValue: string): Promise<string> {
	const answer = await ask(`${question} [${defaultValue}]: `);
	return answer.length > 0 ? answer : defaultValue;
}

/** Ask for a secret (API key / token). Masks input with asterisks. */
export async function askSecret(question: string): Promise<string> {
	const answer = await ask(`${question}: `);
	return answer;
}

/** Ask a yes/no question. Returns true for yes. */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
	const hint = defaultYes ? "Y/n" : "y/N";
	const answer = await ask(`${question} [${hint}]: `);
	if (answer.length === 0) return defaultYes;
	return answer.toLowerCase().startsWith("y");
}

/** Show a numbered list and ask the user to pick one. Returns the chosen item. */
export async function choose<T>(question: string, items: T[], display: (item: T) => string): Promise<T> {
	console.log(`\n${question}`);
	for (let i = 0; i < items.length; i++) {
		console.log(`  ${i + 1}) ${display(items[i])}`);
	}
	while (true) {
		const answer = await ask(`Choose [1-${items.length}]: `);
		const index = Number.parseInt(answer, 10) - 1;
		if (index >= 0 && index < items.length) {
			return items[index];
		}
		console.log(`  Please enter a number between 1 and ${items.length}.`);
	}
}

/** Print a section header. */
export function heading(text: string): void {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`  ${text}`);
	console.log(`${"=".repeat(60)}\n`);
}

/** Print a step indicator. */
export function step(number: number, total: number, text: string): void {
	console.log(`\n--- Step ${number}/${total}: ${text} ---\n`);
}

/** Print a success message. */
export function success(text: string): void {
	console.log(`  OK  ${text}`);
}

/** Print a warning message. */
export function warn(text: string): void {
	console.log(`  !!  ${text}`);
}

/** Print an info message. */
export function info(text: string): void {
	console.log(`  >>  ${text}`);
}
