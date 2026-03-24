import { describe, expect, it } from "bun:test";
import { createCapturingLogger, createNoopLogger, toLogCallback } from "../src/logger";

describe("toLogCallback", () => {
	it("routes plain messages to info", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("daemon started successfully");
		expect(logger.lines).toEqual(["[INFO] daemon started successfully"]);
	});

	it("routes 'errors=0' to info, not error (regression guard for fd4eee2f)", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("[fixbot] github-poll repos=1 enqueued=0 skipped=0 errors=0");
		expect(logger.lines).toEqual(["[INFO] [fixbot] github-poll repos=1 enqueued=0 skipped=0 errors=0"]);
	});

	it("routes ' error: detail' to error", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("[fixbot] daemon error: something broke");
		expect(logger.lines).toEqual(["[ERROR] [fixbot] daemon error: something broke"]);
	});

	it("routes message ending with ' error' to error", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("[fixbot] fatal error");
		expect(logger.lines).toEqual(["[ERROR] [fixbot] fatal error"]);
	});

	it("routes '-poll error:' to error", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("[fixbot] -poll error: network timeout");
		expect(logger.lines).toEqual(["[ERROR] [fixbot] -poll error: network timeout"]);
	});

	it("routes '-report error:' to error", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("[fixbot] -report error: push failed");
		expect(logger.lines).toEqual(["[ERROR] [fixbot] -report error: push failed"]);
	});

	it("routes ' warn: detail' to warn", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("[fixbot] warn: deprecated API");
		expect(logger.lines).toEqual(["[WARN] [fixbot] warn: deprecated API"]);
	});

	it("routes '-poll warn:' to warn", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("[fixbot] -poll warn: rate limited");
		expect(logger.lines).toEqual(["[WARN] [fixbot] -poll warn: rate limited"]);
	});

	it("routes '-report warn:' to warn", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("[fixbot] -report warn: slow response");
		expect(logger.lines).toEqual(["[WARN] [fixbot] -report warn: slow response"]);
	});

	it("does not route 'warnings=0' to warn", () => {
		const logger = createCapturingLogger();
		const cb = toLogCallback(logger);
		cb("[fixbot] lint check warnings=0");
		expect(logger.lines).toEqual(["[INFO] [fixbot] lint check warnings=0"]);
	});
});

describe("createCapturingLogger", () => {
	it("captures info/warn/error/success lines with level prefix", () => {
		const logger = createCapturingLogger();
		logger.info("hello");
		logger.warn("careful");
		logger.error("broken");
		logger.success("done");
		expect(logger.lines).toEqual(["[INFO] hello", "[WARN] careful", "[ERROR] broken", "[SUCCESS] done"]);
	});

	it("shares the lines array reference", () => {
		const logger = createCapturingLogger();
		const ref = logger.lines;
		logger.info("test");
		expect(ref).toHaveLength(1);
		expect(ref[0]).toBe("[INFO] test");
	});
});

describe("createNoopLogger", () => {
	it("all four methods are callable without throwing", () => {
		const logger = createNoopLogger();
		expect(() => {
			logger.info("test");
			logger.warn("test");
			logger.error("test");
			logger.success("test");
		}).not.toThrow();
	});
});
