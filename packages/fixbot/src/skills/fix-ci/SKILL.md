---
name: fix-ci
description: Diagnose and repair a failing GitHub Actions run for the current repository checkout.
disable-model-invocation: true
---

# Fix CI

Use this skill only for a single failing CI run in the current repository clone.

## Goals

1. Inspect the failing GitHub Actions run and identify the concrete failure.
2. Reproduce the failure locally when practical.
3. Make the smallest defensible code or config change that fixes the failure.
4. Leave the repository in a reviewable state with a clear final summary.

## Workflow

1. Read the injected run context first. It contains the run ID, base branch, and final response requirements.
2. Use `gh run view <run-id>` and related `gh` commands to inspect failed jobs, steps, and logs.
3. Reproduce locally when the failure mode is clear enough to validate.
4. Edit the repository directly. Do not ask for interactive approval.
5. If you create a `TODO.md`, keep it short and actionable.

## Constraints

1. Work only inside the current repository checkout.
2. Do not rely on user-global skills, prompts, themes, or extensions.
3. Prefer minimal fixes over broad refactors.
4. If the fix is blocked, explain the blocker precisely.

## Final Response

End with exactly one line for each marker:

- `FIXBOT_RESULT: success` or `FIXBOT_RESULT: failed`
- `FIXBOT_SUMMARY: <single-line summary>`
- `FIXBOT_FAILURE_REASON: <reason or none>`
