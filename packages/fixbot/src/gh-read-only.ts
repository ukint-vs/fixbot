import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

function quoteShellValue(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function findExecutableInPath(
	executable: string,
	pathValue: string | undefined = process.env.PATH,
): string | undefined {
	if (!pathValue) {
		return undefined;
	}

	for (const entry of pathValue.split(delimiter)) {
		if (!entry) {
			continue;
		}
		const candidate = join(entry, executable);
		if (!existsSync(candidate)) {
			continue;
		}
		if (!statSync(candidate).isFile()) {
			continue;
		}
		return candidate;
	}

	return undefined;
}

export function buildGhReadOnlyWrapperScript(realGhPath: string): string {
	const quotedRealGhPath = quoteShellValue(realGhPath);

	return [
		"#!/bin/sh",
		"set -eu",
		`REAL_GH=${quotedRealGhPath}`,
		"deny() {",
		'  echo "fixbot read-only gh wrapper blocked: gh $*" >&2',
		"  exit 1",
		"}",
		"cmd=$" + "{1-}",
		"sub=$" + "{2-}",
		'case "$cmd" in',
		"  run)",
		'    case "$sub" in',
		'      view|list|download|watch) exec "$REAL_GH" "$@" ;;',
		'      *) deny "$@" ;;',
		"    esac ;;",
		"  workflow)",
		'    case "$sub" in',
		'      view|list) exec "$REAL_GH" "$@" ;;',
		'      *) deny "$@" ;;',
		"    esac ;;",
		"  repo)",
		'    case "$sub" in',
		'      view|list) exec "$REAL_GH" "$@" ;;',
		'      *) deny "$@" ;;',
		"    esac ;;",
		"  issue)",
		'    case "$sub" in',
		'      view|list|status) exec "$REAL_GH" "$@" ;;',
		'      *) deny "$@" ;;',
		"    esac ;;",
		"  pr)",
		'    case "$sub" in',
		'      view|list|status|checks|diff) exec "$REAL_GH" "$@" ;;',
		'      *) deny "$@" ;;',
		"    esac ;;",
		"  auth)",
		'    case "$sub" in',
		'      status) exec "$REAL_GH" "$@" ;;',
		'      *) deny "$@" ;;',
		"    esac ;;",
		"  search|help|version)",
		'    exec "$REAL_GH" "$@" ;;',
		"  *)",
		'    deny "$@" ;;',
		"esac",
		"",
	].join("\n");
}

export interface GhReadOnlyEnvironment {
	env: NodeJS.ProcessEnv;
	wrapperPath?: string;
	realGhPath?: string;
}

export function createGhReadOnlyEnvironment(
	wrapperDir: string,
	env: NodeJS.ProcessEnv = process.env,
): GhReadOnlyEnvironment {
	const realGhPath = findExecutableInPath("gh", env.PATH);
	if (!realGhPath) {
		return {
			env: {
				...env,
				GH_PAGER: "cat",
				GH_NO_UPDATE_NOTIFIER: "1",
				GH_PROMPT_DISABLED: "1",
			},
		};
	}

	mkdirSync(wrapperDir, { recursive: true });
	const wrapperPath = join(wrapperDir, "gh");
	writeFileSync(wrapperPath, buildGhReadOnlyWrapperScript(realGhPath), {
		encoding: "utf-8",
		mode: 0o755,
	});

	return {
		env: {
			...env,
			PATH: env.PATH ? `${wrapperDir}${delimiter}${env.PATH}` : wrapperDir,
			GH_PAGER: "cat",
			GH_NO_UPDATE_NOTIFIER: "1",
			GH_PROMPT_DISABLED: "1",
		},
		wrapperPath,
		realGhPath,
	};
}
