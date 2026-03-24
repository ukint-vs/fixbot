import { describe, expect, it } from "bun:test";
import {
	assertBoolean,
	assertNonEmptyString,
	assertNonNegativeInteger,
	assertObject,
	assertPositiveInteger,
	assertTimestamp,
} from "../src/validation";

describe("assertObject", () => {
	it("accepts a plain object", () => {
		expect(assertObject({ a: 1 }, "test")).toEqual({ a: 1 });
	});

	it("rejects null", () => {
		expect(() => assertObject(null, "test")).toThrow("test must be an object");
	});

	it("rejects undefined", () => {
		expect(() => assertObject(undefined, "test")).toThrow("test must be an object");
	});

	it("rejects an array", () => {
		expect(() => assertObject([1, 2], "test")).toThrow("test must be an object");
	});

	it("rejects a string", () => {
		expect(() => assertObject("hello", "test")).toThrow("test must be an object");
	});

	it("rejects a number", () => {
		expect(() => assertObject(42, "test")).toThrow("test must be an object");
	});
});

describe("assertNonEmptyString", () => {
	it("accepts a non-empty string", () => {
		expect(assertNonEmptyString("hello", "test")).toBe("hello");
	});

	it("trims the returned value", () => {
		expect(assertNonEmptyString("  hello  ", "test")).toBe("hello");
	});

	it("rejects an empty string", () => {
		expect(() => assertNonEmptyString("", "test")).toThrow("test must be a non-empty string");
	});

	it("rejects a whitespace-only string", () => {
		expect(() => assertNonEmptyString("   ", "test")).toThrow("test must be a non-empty string");
	});

	it("rejects a number", () => {
		expect(() => assertNonEmptyString(42, "test")).toThrow("test must be a non-empty string");
	});

	it("rejects null", () => {
		expect(() => assertNonEmptyString(null, "test")).toThrow("test must be a non-empty string");
	});
});

describe("assertPositiveInteger", () => {
	it("accepts 1", () => {
		expect(assertPositiveInteger(1, "test")).toBe(1);
	});

	it("accepts large integers", () => {
		expect(assertPositiveInteger(1_800_000, "test")).toBe(1_800_000);
	});

	it("rejects 0", () => {
		expect(() => assertPositiveInteger(0, "test")).toThrow("test must be a positive integer");
	});

	it("rejects negative integers", () => {
		expect(() => assertPositiveInteger(-1, "test")).toThrow("test must be a positive integer");
	});

	it("rejects floats", () => {
		expect(() => assertPositiveInteger(1.5, "test")).toThrow("test must be a positive integer");
	});

	it("rejects strings", () => {
		expect(() => assertPositiveInteger("1", "test")).toThrow("test must be a positive integer");
	});
});

describe("assertNonNegativeInteger", () => {
	it("accepts 0", () => {
		expect(assertNonNegativeInteger(0, "test")).toBe(0);
	});

	it("accepts positive integers", () => {
		expect(assertNonNegativeInteger(5, "test")).toBe(5);
	});

	it("rejects negative integers", () => {
		expect(() => assertNonNegativeInteger(-1, "test")).toThrow("test must be a non-negative integer");
	});

	it("rejects floats", () => {
		expect(() => assertNonNegativeInteger(1.5, "test")).toThrow("test must be a non-negative integer");
	});
});

describe("assertBoolean", () => {
	it("accepts true", () => {
		expect(assertBoolean(true, "test")).toBe(true);
	});

	it("accepts false", () => {
		expect(assertBoolean(false, "test")).toBe(false);
	});

	it("rejects 0", () => {
		expect(() => assertBoolean(0, "test")).toThrow("test must be a boolean");
	});

	it("rejects string 'true'", () => {
		expect(() => assertBoolean("true", "test")).toThrow("test must be a boolean");
	});
});

describe("assertTimestamp", () => {
	it("accepts ISO 8601 string", () => {
		expect(assertTimestamp("2026-03-24T00:00:00Z", "test")).toBe("2026-03-24T00:00:00Z");
	});

	it("rejects invalid date string", () => {
		expect(() => assertTimestamp("not-a-date", "test")).toThrow("test must be a valid timestamp");
	});

	it("rejects empty string", () => {
		expect(() => assertTimestamp("", "test")).toThrow("test must be a non-empty string");
	});
});
