---
name: fix-lint
description: Find and fix lint violations in the current repository checkout.
disable-model-invocation: true
---

# Fix Lint

Use this skill to resolve lint errors and warnings in the current repository clone.

## Goals

1. Identify the lint tool and configuration used by the project.
2. Run the lint command and collect all violations.
3. Fix each violation with the smallest defensible change.
4. Re-run the lint command and confirm all violations are resolved.
5. Leave the repository in a reviewable state with a clear final summary.

## Workflow

1. Read the injected run context first. It contains execution constraints and final response requirements.
2. Inspect `package.json`, config files, or build scripts to identify the lint tool (ESLint, Biome, etc.).
3. If the injected context includes a `lintCommand`, use it. Otherwise infer from project config.
4. Run the linter, collect output, and fix violations file by file.
5. Re-run the linter to verify all violations are resolved.
6. If any violations remain that cannot be fixed, explain precisely why.

## Constraints

1. Work only inside the current repository checkout.
2. Do not modify lint configuration to suppress warnings unless the config itself is the bug.
3. Prefer minimal fixes over broad refactors.
4. Do not fix unrelated code issues — only lint violations.
5. If the fix is blocked, explain the blocker precisely.

## Final Response

End with exactly one line for each marker:

- `FIXBOT_RESULT: success` or `FIXBOT_RESULT: failed`
- `FIXBOT_SUMMARY: <single-line summary>`
- `FIXBOT_FAILURE_REASON: <reason or none>`
