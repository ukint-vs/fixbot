/**
 * Shared validation helpers for parsing untrusted JSON input.
 * Used by contracts.ts, config.ts, and job-store.ts.
 */

type UnknownRecord = Record<string, unknown>;

export function assertObject(value: unknown, label: string): UnknownRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as UnknownRecord;
}

export function assertNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value.trim();
}

export function assertPositiveInteger(value: unknown, label: string): number {
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value as number;
}

export function assertNonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return value as number;
}

export function assertBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`);
	}
	return value;
}

export function assertTimestamp(value: unknown, label: string): string {
	const timestamp = assertNonEmptyString(value, label);
	if (!Number.isFinite(Date.parse(timestamp))) {
		throw new Error(`${label} must be a valid timestamp`);
	}
	return timestamp;
}
