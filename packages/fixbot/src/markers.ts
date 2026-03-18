import type { ParsedResultMarkers, ResultStatus } from "./types";

const RESULT_PATTERN = /^GITFIX_RESULT:\s*(success|failed)\s*$/m;
const SUMMARY_PATTERN = /^GITFIX_SUMMARY:\s*(.+)\s*$/m;
const FAILURE_REASON_PATTERN = /^GITFIX_FAILURE_REASON:\s*(.+)\s*$/m;

export function parseResultMarkers(text: string): ParsedResultMarkers {
	const resultMatch = RESULT_PATTERN.exec(text);
	const summaryMatch = SUMMARY_PATTERN.exec(text);
	const failureReasonMatch = FAILURE_REASON_PATTERN.exec(text);

	return {
		result: resultMatch?.[1] as Exclude<ResultStatus, "timeout"> | undefined,
		summary: summaryMatch?.[1]?.trim(),
		failureReason: failureReasonMatch?.[1]?.trim(),
		hasResult: resultMatch !== null,
		hasSummary: summaryMatch !== null,
		hasFailureReason: failureReasonMatch !== null,
	};
}

function firstUsefulLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(
			(line) =>
				line !== "" &&
				!line.startsWith("GITFIX_RESULT:") &&
				!line.startsWith("GITFIX_SUMMARY:") &&
				!line.startsWith("GITFIX_FAILURE_REASON:"),
		);
}

export function deriveResultStatus(input: {
	assistantFinalText: string;
	patchText: string;
	parsedMarkers: ParsedResultMarkers;
	assistantError?: string;
	executionError?: string;
}): { status: Exclude<ResultStatus, "timeout">; summary: string; failureReason?: string } {
	const { assistantFinalText, patchText, parsedMarkers, assistantError, executionError } = input;
	const hasPatch = patchText.trim() !== "";
	const resolvedError = assistantError ?? executionError;

	const status = parsedMarkers.result ?? (resolvedError ? "failed" : hasPatch ? "success" : "failed");
	const summary =
		parsedMarkers.summary ??
		firstUsefulLine(assistantFinalText) ??
		(status === "success"
			? "Applied repository changes."
			: (resolvedError ?? "No repository changes were produced."));

	if (status === "success") {
		return {
			status,
			summary,
			failureReason:
				parsedMarkers.failureReason && parsedMarkers.failureReason !== "none"
					? parsedMarkers.failureReason
					: undefined,
		};
	}

	return {
		status,
		summary,
		failureReason:
			parsedMarkers.failureReason && parsedMarkers.failureReason !== "none"
				? parsedMarkers.failureReason
				: (resolvedError ?? summary),
	};
}
