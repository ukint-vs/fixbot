---
name: fix-tests
description: Diagnose and repair failing tests in the current repository checkout.
disable-model-invocation: true
---

# Fix Tests

Use this skill to diagnose and repair failing tests in the current repository clone.

## Goals

1. Identify the test framework and configuration used by the project.
2. Run the test suite and collect all failures.
3. Diagnose the root cause of each failure.
4. Fix the underlying issue — not by skipping, disabling, or weakening tests.
5. Re-run the test suite and confirm all tests pass.
6. Leave the repository in a reviewable state with a clear final summary.

## Workflow

1. Read the injected run context first. It contains execution constraints and final response requirements.
2. Inspect `package.json`, config files, or build scripts to identify the test framework (Vitest, Jest, pytest, etc.).
3. If the injected context includes a `testCommand`, use it. Otherwise infer from project config.
4. Run the tests, collect output, and identify failing tests.
5. For each failure: read the test, read the implementation, diagnose the root cause.
6. Fix the root cause — prefer fixing implementation over modifying tests unless the test itself is wrong.
7. Re-run the full test suite to verify all tests pass.
8. If any tests remain failing that cannot be fixed, explain precisely why.

## Constraints

1. Work only inside the current repository checkout.
2. Never skip, disable, or delete tests to make the suite pass.
3. Prefer fixing the implementation over changing test expectations, unless the test expectation is demonstrably wrong.
4. Prefer minimal fixes over broad refactors.
5. Do not fix unrelated code issues — only test failures.
6. If the fix is blocked, explain the blocker precisely.

## Final Response

End with exactly one line for each marker:

- `FIXBOT_RESULT: success` or `FIXBOT_RESULT: failed`
- `FIXBOT_SUMMARY: <single-line summary>`
- `FIXBOT_FAILURE_REASON: <reason or none>`
