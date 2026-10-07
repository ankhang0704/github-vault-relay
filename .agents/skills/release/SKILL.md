---
name: release
description: Standardized release workflow for GitHub Vault Relay. Bumps versions across package/manifest/lockfile/versions/docs, verifies supply-chain security gates, checks pre-release alignment, and deploys Git tags/GitHub Releases with attestation. Use when releasing a new version, bumping versions, publishing a release, or preparing release artifacts.
---

# Release — GitHub Vault Relay Release Protocol

Standardized, quality-gated procedure for releasing a new version of GitHub Vault Relay with full supply-chain security and provenance.

## 1. Pre-flight Checks
- Ensure the working directory is clean (`git status`).
- Check current test suite baseline (`npm test`) to determine the exact number of test files and passing tests.

## 2. Version Synchronization
Synchronize the new version `X.Y.Z` across all configuration, lockfile, and security files:
- `package.json`: Update `"version": "X.Y.Z"`
- `package-lock.json`: Run `npm install --package-lock-only` to strictly synchronize lockfile root and packages metadata.
- `manifest.json`: Update `"version": "X.Y.Z"`
- `versions.json`: Prepend `"X.Y.Z": "<minAppVersion>"` (matching manifest `minAppVersion`)
- `SECURITY.md`: Update supported release clause: `The current supported release is \`X.Y.Z\`; ...`

## 3. Documentation Updates
Update documentation with the new version and latest verification metrics:
- `CHANGELOG.md`:
  - Update top header with current test file & test counts and today's date (`YYYY-MM-DD`).
  - Prepend `## [X.Y.Z] - YYYY-MM-DD` detailing changes (features, fixes, security, cleanups, verification status).
- `README.md`:
  - Update version badge: `[![Version](https://img.shields.io/badge/version-X.Y.Z-blue.svg)]`
  - Update canonical baseline section: Release version, automated evidence test counts, and quality gate date.
- `docs/PROJECT_SOURCE_OF_TRUTH.md`:
  - Update release version, test files, passing tests, and quality gate date.
- `docs/ARCHITECTURE.md`:
  - Update tree version reference if applicable.

## 4. Pre-release Verification & Quality Gates
Execute deterministic alignment check and full quality/security gates:
```bash
# 1. Deterministic version alignment check
node .agents/skills/release/scripts/verify-release.mjs

# 2. Production dependency security audit (0 vulnerabilities tolerated)
npm audit --omit=dev

# 3. Full quality gates (lint, typecheck, tests, production build)
npm run verify
```

Must pass with:
- `verify-release.mjs` => PASS (all files synchronized)
- `npm audit --omit=dev` => PASS (0 vulnerabilities)
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
Create an annotated Git tag matching the release version (e.g. `vX.Y.Z` or `X.Y.Z` per repo convention):
```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
```
Push the branch and the new tag to GitHub:
```bash
git push origin main
git push origin vX.Y.Z
```

## 6. GitHub Actions Release & Attestation Verification
The tag push triggers `.github/workflows/release.yml`. Monitor workflow and verify asset provenance:
```bash
gh run list --limit 3
gh run watch <run-id> --exit-status
```
After workflow completion:
1. Verify GitHub release assets and build attestation:
   ```bash
   gh release view vX.Y.Z
   gh attestation verify main.js -R "<owner>/<repo>"
   ```
2. Update release notes if necessary:
   ```bash
   gh release edit vX.Y.Z --notes "<formatted release notes from CHANGELOG.md>"
   ```
