---
name: release
description: Standardized release workflow for GitHub Vault Relay. Bumps versions across package/manifest/versions files, synchronizes docs, executes full quality gates, and deploys Git tags/GitHub Releases. Use when releasing a new version, bumping versions, publishing a release, or preparing release artifacts.
---

# Release — GitHub Vault Relay Release Protocol

Standardized, quality-gated procedure for releasing a new version of GitHub Vault Relay.

## 1. Pre-flight Checks
- Ensure the working directory is clean (`git status`).
- Check current test suite baseline (`npm test`) to determine the exact number of test files and passing tests.

## 2. Version Synchronization
Synchronize the new version `X.Y.Z` across all configuration files:
- `package.json`: Update `"version": "X.Y.Z"`
- `manifest.json`: Update `"version": "X.Y.Z"`
- `versions.json`: Prepend `"X.Y.Z": "<minAppVersion>"` (matching manifest `minAppVersion`)

## 3. Documentation Updates
Update documentation with the new version and latest verification metrics:
- `CHANGELOG.md`:
  - Update top header with current test file & test counts and today's date (`YYYY-MM-DD`).
  - Prepend `## [X.Y.Z] - YYYY-MM-DD` detailing changes (features, fixes, performance, cleanups, verification status).
- `README.md`:
  - Update version badge: `[![Version](https://img.shields.io/badge/version-X.Y.Z-blue.svg)]`
  - Update canonical baseline section: Release version, automated evidence test counts, and quality gate date.
- `docs/PROJECT_SOURCE_OF_TRUTH.md`:
  - Update release version, test files, passing tests, and quality gate date.
- `docs/ARCHITECTURE.md`:
  - Update tree version reference if applicable.

## 4. Quality Gate Execution
Execute full project quality gates as mandated by `AGENTS.md`:
```bash
npm run verify
```
Must pass with:
- `npm run lint` => PASS (0 warnings, 0 errors)
- `npm run typecheck` => PASS
- `npm run test` => PASS (all unit/integration tests)
- `npm run build` => PASS (production esbuild bundle generated)

## 5. Commit, Tag & Push
Stage all modified files and commit:
```bash
git add -A
git commit -m "chore(release): bump version to X.Y.Z and <summary>"
```
Create an annotated Git tag matching the release version:
```bash
git tag -a X.Y.Z -m "Release X.Y.Z"
```
Push the branch and the new tag to GitHub:
```bash
git push origin main
git push origin X.Y.Z
```

## 6. GitHub Actions Release Verification
The tag push triggers `.github/workflows/release.yml`. Monitor and complete the release:
```bash
gh run list --limit 3
gh run watch <run-id> --exit-status
```
After workflow completion:
1. Verify the release assets and attestation: `gh release view X.Y.Z`
2. Update release notes if necessary:
   ```bash
   gh release edit X.Y.Z --notes "<formatted release notes from CHANGELOG.md>"
   ```
