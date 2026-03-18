---
name: solve-issue
description: Resolve a single GitHub issue with the minimum viable code change.
disable-model-invocation: true
---

# Solve Issue

Use this skill only for a single GitHub issue. Implement only the minimum change required to address the issue — bugfix or bounded small feature. Do not refactor unrelated code. If the fix requires more than a bounded implementation, explain why and return GITFIX_RESULT: failed.

## Goals

1. Read the injected issue context (number, title, body).
2. Understand what the issue is asking for.
3. Implement the smallest correct fix or bounded feature that resolves the issue.
4. Leave the repository in a reviewable state with a clear final summary.

## Workflow

1. Read the injected context first. It contains the issue number, title, body, and final response requirements.
2. Inspect the issue description to understand the expected behavior and reproduction steps.
3. Locate the relevant code using search, file reads, and language tooling.
4. Implement the fix directly. Do not ask for interactive approval.
5. Verify the fix when practical — run tests, lint, or type-check as appropriate.
6. If you create a `TODO.md`, keep it short and actionable.

## Constraints

1. Work only inside the current repository checkout.
2. One issue at a time — do not address unrelated issues.
3. No unrelated refactoring. Prefer minimal, targeted changes.
4. Keep the diff bounded. If the change grows beyond a reasonable scope, fail with a clear explanation.
5. Do not rely on user-global skills, prompts, themes, or extensions.

## Final Response

End with exactly one line for each marker:

- `GITFIX_RESULT: success` or `GITFIX_RESULT: failed`
- `GITFIX_SUMMARY: <single-line summary>`
- `GITFIX_FAILURE_REASON: <reason or none>`
