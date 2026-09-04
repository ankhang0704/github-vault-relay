# Contributing to GitHub Vault Relay

Thank you for your interest in contributing to GitHub Vault Relay!

GitHub Vault Relay is a conservative, mobile-first GitHub bridge for Obsidian Mobile (iOS/Android) and Desktop. Our core priority is **data integrity over convenience**: when state is ambiguous, we halt and preserve both versions rather than guessing or silently overwriting user notes.

---

## 🛠️ Development Prerequisites

- **Node.js**: v20.x or v22.x LTS
- **npm**: v10+

### Setup & Quality Gates

```bash
# 1. Clean install exact dependencies
npm ci

# 2. Run ESLint (0 errors, 0 warnings required)
npm run lint

# 3. Run TypeScript typecheck
npm run typecheck

# 4. Run test suite
npm run test

# 5. Build production bundle
npm run build

# 6. Run the unified verification pipeline
npm run verify
```

Every Pull Request must pass `npm run verify` with zero warnings and zero errors.

---

## 🛡️ Core Safety Invariants

All contributions must respect the following core safety guarantees:
1. **Zero Force Push (`force: false`)**: Branch ref updates must never pass `force: true`.
2. **Zero DELETE / PUT contents**: Remote writes use exclusively approved Git Data API endpoints (`/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`).
3. **No Hidden Mutations**: All mutations must be explicitly initiated by the user (no background sync daemons, no sync-on-save).
4. **SecretStorage Exclusively**: Personal Access Tokens must reside strictly in Obsidian `SecretStorage` (`github-vault-relay-pat`). Tokens are never written to `data.json` or `localStorage`.
5. **Conflict Preservation**: Conflicted notes must never be overwritten automatically.
6. **Mobile Environment Safety**: Zero Node.js-only runtime APIs (`child_process`, `fs`). Communications must use Obsidian's `requestUrl()` API.

---

## 🚫 Feature Freeze (MVP Scope)

To maintain stability and safety, the project operates under a strict feature freeze. Please do **not** submit PRs implementing:
- Background or scheduled sync
- Sync-on-save
- Automatic file deletions
- Alternative Git hosts (GitLab, Gitea, WebDAV)
- Native Git / isomorphic-git dependencies

Allowed contributions focus on: correctness, error recovery, performance, security, accessibility, and documentation.

---

## 🤖 AI-Assisted Development Policy

GitHub Vault Relay welcomes the responsible use of AI tools under a human-in-the-loop engineering model:
- **Maintainer Ownership**: System architecture, safety invariants, and release authorizations are strictly human-owned and directed.
- **Verification Requirement**: AI-assisted code is held to the identical standards as human-authored code: it must pass all linting, typechecking, deterministic unit tests, and security reviews.
- **Transparency**: Contributors using AI coding assistants should note this in PR descriptions and ensure they have personally reviewed and verified all submitted changes.

---

## 🔒 Security Disclosures

Please do **not** open public issues for security vulnerabilities. Review our [SECURITY.md](SECURITY.md) for private disclosure instructions via GitHub Security Advisories.
