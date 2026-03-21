---
name: fix-cve
description: Remediate a known CVE by updating the vulnerable dependency to a safe version.
disable-model-invocation: true
---

# Fix CVE

Use this skill only for remediating a single CVE by updating the vulnerable dependency. Do not make unrelated changes. If the update cannot be completed safely, explain why and return FIXBOT_RESULT: failed.

## Goals

1. Update the vulnerable dependency to at least the target version (if specified) or to the latest safe version.
2. Verify the vulnerable version is absent from the resolved dependency tree.
3. Run the test suite to confirm nothing broke after the update.
4. Leave the repository in a reviewable state with a clear final summary.

## Workflow

1. Read the injected CVE context first. It contains the CVE ID, vulnerable package name, and optional target version.
2. Identify where the vulnerable package appears in `package.json`, `package-lock.json`, or equivalent manifests.
3. Update the dependency version constraint. Use the target version when provided; otherwise choose the minimum safe version that resolves the CVE.
4. Run the package manager install/update to regenerate the lockfile.
5. Run `npm ls <package>` (or the equivalent command for the project's package manager) to verify the vulnerable version is no longer present in the dependency tree.
6. Run the test suite to confirm the update does not introduce regressions.
7. If you create a `TODO.md`, keep it short and actionable.

## Constraints

1. Work only inside the current repository checkout.
2. Do not suppress test failures or bypass security checks.
3. Network access may be required for dependency resolution — this is expected.
4. Prefer exact version match over broad version range updates when possible.
5. Do not make unrelated dependency bumps or refactors.
6. Do not rely on user-global skills, prompts, themes, or extensions.

## Final Response

End with exactly one line for each marker:

- `FIXBOT_RESULT: success` or `FIXBOT_RESULT: failed`
- `FIXBOT_SUMMARY: <single-line summary>`
- `FIXBOT_FAILURE_REASON: <reason or none>`
