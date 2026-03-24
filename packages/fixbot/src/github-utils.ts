/**
 * Shared GitHub URL utilities.
 *
 * `parseOwnerRepo` was originally defined in `daemon/github-reporter.ts`.
 * It is now re-exported from this module so that both the reporter and the
 * repo-cache can use it without circular dependencies.
 */

/**
 * Extract owner/repo from a GitHub URL like `https://github.com/owner/repo`
 * or `https://github.com/owner/repo.git`, or from an `owner/repo` shorthand.
 *
 * Supported formats:
 * - HTTPS URLs:  `https://github.com/owner/repo[.git]`
 * - HTTP URLs:   `http://github.com/owner/repo[.git]`
 * - SSH URLs:    `git@github.com:owner/repo[.git]`
 * - Shorthand:   `owner/repo`
 */
export function parseOwnerRepo(input: string): { owner: string; repo: string } {
	// SSH URL format: git@github.com:owner/repo.git
	const sshMatch = input.match(/^git@[^:]+:(.+)$/);
	if (sshMatch) {
		const path = sshMatch[1].replace(/\.git$/, "").replace(/\/$/, "");
		const segments = path.split("/").filter(Boolean);
		if (segments.length !== 2) {
			throw new Error(`GitHub SSH URL must have exactly owner/repo path segments: ${input}`);
		}
		return { owner: segments[0], repo: segments[1] };
	}

	// HTTPS / HTTP URL format
	if (input.startsWith("http://") || input.startsWith("https://")) {
		let pathname: string;
		try {
			pathname = new URL(input).pathname;
		} catch {
			throw new Error(`Invalid GitHub repo URL: ${input}`);
		}
		const cleaned = pathname
			.replace(/^\//, "")
			.replace(/\/$/, "")
			.replace(/\.git$/, "");
		const segments = cleaned.split("/").filter(Boolean);
		if (segments.length !== 2) {
			throw new Error(`GitHub repo URL must have exactly owner/repo path segments: ${input}`);
		}
		return { owner: segments[0], repo: segments[1] };
	}

	// Plain owner/repo shorthand (no protocol, no colon)
	const cleaned = input.replace(/\.git$/, "").replace(/\/$/, "");
	const segments = cleaned.split("/").filter(Boolean);
	if (segments.length !== 2) {
		throw new Error(`Expected owner/repo format: ${input}`);
	}
	return { owner: segments[0], repo: segments[1] };
}
