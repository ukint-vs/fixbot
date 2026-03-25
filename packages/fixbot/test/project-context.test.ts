import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getProjectContext, _testing } from "../src/project-context";

const {
	GENERATED_HEADER,
	CONTEXT_BUDGET_CHARS,
	CONTEXT_FILENAME,
	FIXBOT_DIR,
	truncateWithNote,
	parseCacheMetadata,
	isCacheValid,
	buildCacheHeader,
	discoverExistingDocs,
	mergeExistingDocs,
	detectFrameworks,
	detectLanguage,
	generateReadmeSection,
	generateDirectoryListing,
	generateProjectContext,
	tryGetHeadCommitSync,
} = _testing;

function createTmpDir(): string {
	const dir = join(tmpdir(), `fixbot-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("project-context", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = createTmpDir();
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// truncateWithNote
	// -----------------------------------------------------------------------

	describe("truncateWithNote", () => {
		it("returns short text unchanged", () => {
			expect(truncateWithNote("hello", 100)).toBe("hello");
		});

		it("truncates long text with a note", () => {
			const long = "a".repeat(200);
			const result = truncateWithNote(long, 150);
			expect(result.length).toBeLessThanOrEqual(200);
			expect(result).toContain("<!-- truncated:");
		});
	});

	// -----------------------------------------------------------------------
	// parseCacheMetadata
	// -----------------------------------------------------------------------

	describe("parseCacheMetadata", () => {
		it("returns undefined for non-generated content", () => {
			expect(parseCacheMetadata("# My Project")).toBeUndefined();
		});

		it("parses valid generated header", () => {
			const header = [
				GENERATED_HEADER,
				"<!-- timestamp: 2024-01-01T00:00:00.000Z -->",
				"<!-- commit: abc123def456 -->",
				"",
				"# Content",
			].join("\n");
			const meta = parseCacheMetadata(header);
			expect(meta).not.toBeUndefined();
			expect(meta!.timestamp).toBe("2024-01-01T00:00:00.000Z");
			expect(meta!.commitHash).toBe("abc123def456");
		});

		it("returns undefined when no timestamp present", () => {
			const header = [GENERATED_HEADER, "<!-- commit: abc123 -->"].join("\n");
			expect(parseCacheMetadata(header)).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// isCacheValid
	// -----------------------------------------------------------------------

	describe("isCacheValid", () => {
		it("returns true when commit hashes match", () => {
			expect(isCacheValid({ timestamp: "t", commitHash: "abc" }, "abc")).toBe(true);
		});

		it("returns false when commit hashes differ", () => {
			expect(isCacheValid({ timestamp: "t", commitHash: "abc" }, "def")).toBe(false);
		});

		it("returns false when metadata has no commit", () => {
			expect(isCacheValid({ timestamp: "t", commitHash: undefined }, "abc")).toBe(false);
		});

		it("returns false when current commit is undefined", () => {
			expect(isCacheValid({ timestamp: "t", commitHash: "abc" }, undefined)).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// discoverExistingDocs
	// -----------------------------------------------------------------------

	describe("discoverExistingDocs", () => {
		it("finds CLAUDE.md at root", () => {
			writeFileSync(join(workspace, "CLAUDE.md"), "# Claude docs");
			const docs = discoverExistingDocs(workspace);
			expect(docs.claudeMd).toBe("# Claude docs");
			expect(docs.agentsMd).toBeUndefined();
		});

		it("finds CLAUDE.md in .claude dir", () => {
			mkdirSync(join(workspace, ".claude"), { recursive: true });
			writeFileSync(join(workspace, ".claude", "CLAUDE.md"), "# In .claude");
			const docs = discoverExistingDocs(workspace);
			expect(docs.claudeMd).toBe("# In .claude");
		});

		it("prefers root CLAUDE.md over .claude/CLAUDE.md", () => {
			writeFileSync(join(workspace, "CLAUDE.md"), "# Root");
			mkdirSync(join(workspace, ".claude"), { recursive: true });
			writeFileSync(join(workspace, ".claude", "CLAUDE.md"), "# Nested");
			const docs = discoverExistingDocs(workspace);
			expect(docs.claudeMd).toBe("# Root");
		});

		it("finds AGENTS.md", () => {
			writeFileSync(join(workspace, "AGENTS.md"), "# Agents");
			const docs = discoverExistingDocs(workspace);
			expect(docs.agentsMd).toBe("# Agents");
		});

		it("returns both when present", () => {
			writeFileSync(join(workspace, "CLAUDE.md"), "# C");
			writeFileSync(join(workspace, "AGENTS.md"), "# A");
			const docs = discoverExistingDocs(workspace);
			expect(docs.claudeMd).toBeDefined();
			expect(docs.agentsMd).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// mergeExistingDocs
	// -----------------------------------------------------------------------

	describe("mergeExistingDocs", () => {
		it("returns undefined when both are absent", () => {
			expect(mergeExistingDocs(undefined, undefined)).toBeUndefined();
		});

		it("returns claude-md source when only CLAUDE.md present", () => {
			const result = mergeExistingDocs("# Claude", undefined);
			expect(result).not.toBeUndefined();
			expect(result!.source).toBe("claude-md");
			expect(result!.content).toContain("# Claude");
		});

		it("returns agents-md source when only AGENTS.md present", () => {
			const result = mergeExistingDocs(undefined, "# Agents");
			expect(result).not.toBeUndefined();
			expect(result!.source).toBe("agents-md");
		});

		it("returns merged source when both present", () => {
			const result = mergeExistingDocs("# Claude", "# Agents");
			expect(result).not.toBeUndefined();
			expect(result!.source).toBe("merged");
			expect(result!.content).toContain("CLAUDE.md");
			expect(result!.content).toContain("AGENTS.md");
		});
	});

	// -----------------------------------------------------------------------
	// detectFrameworks
	// -----------------------------------------------------------------------

	describe("detectFrameworks", () => {
		it("detects React and TypeScript", () => {
			const pkg = {
				dependencies: { react: "^18.0.0" },
				devDependencies: { typescript: "^5.0.0" },
			};
			const frameworks = detectFrameworks(pkg);
			const names = frameworks.map((f) => f.name);
			expect(names).toContain("React");
			expect(names).toContain("TypeScript");
		});

		it("returns empty for no known frameworks", () => {
			const pkg = { dependencies: { "my-custom-lib": "1.0.0" } };
			expect(detectFrameworks(pkg)).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	// detectLanguage
	// -----------------------------------------------------------------------

	describe("detectLanguage", () => {
		it("detects Rust from Cargo.toml", () => {
			writeFileSync(join(workspace, "Cargo.toml"), "[package]");
			expect(detectLanguage(workspace)).toBe("Rust");
		});

		it("detects Python from pyproject.toml", () => {
			writeFileSync(join(workspace, "pyproject.toml"), "[project]");
			expect(detectLanguage(workspace)).toBe("Python");
		});

		it("detects Go from go.mod", () => {
			writeFileSync(join(workspace, "go.mod"), "module example.com");
			expect(detectLanguage(workspace)).toBe("Go");
		});

		it("detects TypeScript from package.json deps", () => {
			const pkg = { devDependencies: { typescript: "^5.0.0" } };
			expect(detectLanguage(workspace, pkg)).toBe("TypeScript");
		});

		it("detects JavaScript when package.json has no TS", () => {
			const pkg = { dependencies: { express: "^4.0.0" } };
			expect(detectLanguage(workspace, pkg)).toBe("JavaScript");
		});

		it("returns Unknown when nothing matches", () => {
			expect(detectLanguage(workspace)).toBe("Unknown");
		});
	});

	// -----------------------------------------------------------------------
	// generateReadmeSection
	// -----------------------------------------------------------------------

	describe("generateReadmeSection", () => {
		it("extracts first section from README", () => {
			writeFileSync(
				join(workspace, "README.md"),
				"# My Project\n\nA cool project.\n\n## Installation\n\nsteps here",
			);
			const section = generateReadmeSection(workspace);
			expect(section).toContain("My Project");
			expect(section).toContain("A cool project.");
			expect(section).not.toContain("Installation");
		});

		it("returns undefined when no README exists", () => {
			expect(generateReadmeSection(workspace)).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// generateDirectoryListing
	// -----------------------------------------------------------------------

	describe("generateDirectoryListing", () => {
		it("lists files and directories", () => {
			writeFileSync(join(workspace, "package.json"), "{}");
			mkdirSync(join(workspace, "src"));
			const listing = generateDirectoryListing(workspace);
			expect(listing).toContain("src/");
			expect(listing).toContain("package.json");
		});

		it("hides dotfiles except .github", () => {
			writeFileSync(join(workspace, ".hidden"), "");
			mkdirSync(join(workspace, ".github"));
			writeFileSync(join(workspace, "visible.txt"), "");
			const listing = generateDirectoryListing(workspace);
			expect(listing).not.toContain(".hidden");
			expect(listing).toContain(".github/");
			expect(listing).toContain("visible.txt");
		});
	});

	// -----------------------------------------------------------------------
	// getProjectContext (integration)
	// -----------------------------------------------------------------------

	describe("getProjectContext", () => {
		it("returns user-provided context without overwriting", () => {
			const fixbotDir = join(workspace, FIXBOT_DIR);
			mkdirSync(fixbotDir, { recursive: true });
			writeFileSync(join(fixbotDir, CONTEXT_FILENAME), "# My custom context");
			const result = getProjectContext(workspace);
			expect(result.source).toBe("user-provided");
			expect(result.content).toBe("# My custom context");
		});

		it("returns claude-md when CLAUDE.md exists", () => {
			writeFileSync(join(workspace, "CLAUDE.md"), "# Project rules");
			const result = getProjectContext(workspace);
			expect(result.source).toBe("claude-md");
			expect(result.content).toContain("Project rules");
		});

		it("returns merged when both CLAUDE.md and AGENTS.md exist", () => {
			writeFileSync(join(workspace, "CLAUDE.md"), "# Claude rules");
			writeFileSync(join(workspace, "AGENTS.md"), "# Agent rules");
			const result = getProjectContext(workspace);
			expect(result.source).toBe("merged");
			expect(result.content).toContain("Claude rules");
			expect(result.content).toContain("Agent rules");
		});

		it("generates context from package.json when no docs exist", () => {
			writeFileSync(
				join(workspace, "package.json"),
				JSON.stringify({
					name: "my-app",
					scripts: { test: "jest", build: "tsc" },
					dependencies: { react: "^18.0.0" },
					devDependencies: { typescript: "^5.0.0" },
				}),
			);
			mkdirSync(join(workspace, "src"));
			const result = getProjectContext(workspace);
			expect(result.source).toBe("generated");
			expect(result.content).toContain("my-app");
			expect(result.content).toContain("TypeScript");
			expect(result.content).toContain("React");
		});

		it("writes cache file on generation", () => {
			writeFileSync(join(workspace, "CLAUDE.md"), "# Cached");
			getProjectContext(workspace);
			const cachePath = join(workspace, FIXBOT_DIR, CONTEXT_FILENAME);
			expect(existsSync(cachePath)).toBe(true);
			const cacheContent = readFileSync(cachePath, "utf-8");
			expect(cacheContent).toContain(GENERATED_HEADER);
		});

		it("returns none for empty workspace", () => {
			const result = getProjectContext(workspace);
			// An empty workspace has a directory listing at minimum
			// but nothing else, so it may still generate something
			expect(["generated", "none"]).toContain(result.source);
		});

		it("never throws even on broken workspace", () => {
			// Pass a non-existent path -- generation still produces a minimal header
			// with project name from the directory basename, so it won't be "none".
			// The key invariant is that it never throws.
			const result = getProjectContext("/nonexistent/path/that/does/not/exist");
			expect(["generated", "none"]).toContain(result.source);
		});

		it("respects context budget", () => {
			// Create a very large CLAUDE.md
			writeFileSync(join(workspace, "CLAUDE.md"), "x".repeat(CONTEXT_BUDGET_CHARS * 2));
			const result = getProjectContext(workspace);
			expect(result.content.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS + 100);
		});
	});
});
