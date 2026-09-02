# GitHub Vault Relay

> **A conservative, mobile-first GitHub bridge for Obsidian — without running Git on your phone.**

[![CI](https://github.com/ankhang0704/github-vault-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/ankhang0704/github-vault-relay/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](https://github.com/ankhang0704/github-vault-relay/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GitHub Vault Relay connects your **Obsidian Mobile (iPhone / iPad)** vault directly to your GitHub repository using GitHub's REST and Git Data APIs over HTTPS. It requires **no native Git installation, no command line tools, no isomorphic-git polyfills, and zero background daemons**.

---

## 🏛️ Architecture & Workflow

GitHub Vault Relay is architected around an asymmetric sync model designed for users who work with their notes across desktop and mobile devices.

```
+-------------------------------------------------------------+
|                     GitHub Repository                       |
|          (Central Git Remote / Vault Source of Truth)       |
+-------------------------------------------------------------+
               ^                               ^
               | (Native Git: clone/push/pull) | (GitHub REST / Git Data API: GET / POST / PATCH)
               |                               v
+------------------------------+  +---------------------------+
|        Windows / macOS       |  |          iPhone           |
|      (Obsidian Desktop)      |  |     (Obsidian Mobile)     |
|                              |  |                           |
| • Native Git CLI / GUI       |  | • GitHub Vault Relay      |
| • Standard Git branch/merge  |  | • Direct REST to GitHub   |
| • Full local Git history     |  | • Zero Node.js / CLI req  |
| • Compatible with PC sync    |  | • Safe Pull & Safe Push   |
+------------------------------+  +---------------------------+
```

### Windows / Desktop Workflow
- Your existing Obsidian vault continues using standard native Git (Git CLI, Obsidian Git, or your favorite Git GUI).
- No special plugin is required on Windows or desktop platforms.

### iPhone / Mobile Workflow
- Obsidian on iOS runs in a sandboxed mobile environment where native Git CLI, `child_process`, and Node filesystem APIs (`fs`) do not exist.
- GitHub Vault Relay communicates directly with GitHub's REST and Git Data APIs over HTTPS using Obsidian's native `requestUrl()` API.
- **Safe Pull**: Downloads remote notes locally with pre-write safety and conflict preservation (`_vault-relay/conflicts/`).
- **Safe Push**: Uploads safe local changes (`LOCAL_ONLY`, `LOCAL_CHANGED`) in a single atomic Git commit with optimistic concurrency and zero force-push.

---

## 🔒 Threat Model & Security Decisions

1. **Secure Device Token Storage**:
   - GitHub Vault Relay stores Personal Access Tokens (PAT) exclusively in secure device storage (Obsidian SecretStorage when available, and app-isolated local storage).
   - **PATs are NEVER written to plugin `data.json`**.
   - `data.json` contains only non-sensitive configuration (owner, repo, branch, exclusions).
2. **Zero Leaks & Automatic Redaction**:
   - Tokens are never printed in debug logs, error toasts, console logs, or UI notices.
   - All network errors pass through a sanitization layer (`redactTokens`) that masks PATs (`github_pat_*`, `ghp_*`, `Bearer ...`) before displaying to the user.
3. **Restricted Endpoint Destination**:
   - The token is transmitted exclusively to `https://api.github.com` and nowhere else. No third-party servers, analytics, or telemetry.
4. **Principle of Least Privilege**:
   - Configure your Fine-Grained PAT to have access **only** to your specific vault repository with **Contents: Read and Write** permissions.

---

## ⚙️ Fine-Grained PAT Setup Guide

To create a GitHub Fine-Grained Personal Access Token:

1. Navigate to **GitHub** -> **Settings** -> **Developer Settings** -> **Personal Access Tokens** -> **Fine-grained tokens**.
2. Click **Generate new token**.
3. Set **Token name** (e.g., `Obsidian iPhone GitHub Vault Relay`).
4. Set **Expiration** as desired.
5. Under **Repository access**, select **Only select repositories** and pick your vault repository.
6. Under **Repository permissions**, configure:
   - **Contents**: `Access: Read and write` (Metadata access is automatically granted).
7. Generate and copy the token (`github_pat_...`), then paste it into the GitHub Vault Relay plugin settings in Obsidian and click **Save Token**.

---

## 📊 Sync Preview Categories

When you open the **Sync Preview Modal**, GitHub Vault Relay classifies each note into one of 6 states:

| Category | Description | Safe Pull Action | Safe Push Action |
| :--- | :--- | :--- | :--- |
| **`LOCAL ONLY`** | Exists in local vault, not present on GitHub. | Kept untouched locally. | Created on GitHub (`PUSH_CREATE`). |
| **`REMOTE ONLY`** | Exists in GitHub Git tree, not in local vault. | Safely created locally. | Skipped (not a local change). |
| **`LOCAL CHANGED`** | Modified locally since last sync, remote unchanged. | Kept untouched locally. | Updated on GitHub (`PUSH_UPDATE`). |
| **`REMOTE CHANGED`** | Updated on GitHub since last sync, local unchanged. | Safely updated locally. | Skipped (remote is newer). |
| **`POTENTIAL CONFLICT`** | Both local and remote versions changed independently. | Local untouched; remote saved in `_vault-relay/conflicts/`. | Skipped (blocked from push to protect remote). |
| **`UNCHANGED`** | Local Git blob SHA matches remote Git blob SHA identically. | No operation needed. | No operation needed. |

### Default Exclusions
GitHub Vault Relay automatically ignores internal system files and folders:
- `.obsidian/` (Theme, workspace cache, and plugin settings)
- `.git/` (Native Git repository metadata)
- `_fit/` (Mobile Fit history / sync folders)
- `_vault-relay/` (GitHub Vault Relay internal sync state & conflicts)

---

## 🛡️ Safety & Concurrency Policies

- **Optimistic Concurrency & Zero Force-Push**: Branch ref updates strictly set `force: false`. If remote branch HEAD changes while a push is in flight, Vault Relay aborts immediately (`ABORTED / REMOTE_CHANGED_DURING_PUSH`), preventing history overwrites.
- **Atomic Single Commit**: All eligible local changes in a push are uploaded as blobs, assembled into a single Git tree on top of the base commit tree, and committed as a single atomic Git commit.
- **25 MiB Mobile Safety Ceiling**: Files $>25\text{ MiB}$ are skipped with a user warning to protect against iOS Jetsam memory terminations. (Note: GitHub platform limit is 100 MB).
- **Canonical LF for Text**: `.md`, `.txt`, `.canvas` text files are canonicalized to LF (`\n`) in memory before Git SHA calculation and upload/write operations.
- **Byte-Exact Binary**: Images, PDF, audio, and binary attachments are streamed and uploaded/written **100% byte-exact** without any transformation.
- **Cryptographic Integrity**: Blob raw SHAs are strictly verified against expected Git blob SHAs.
- **Conflict Preservation**: Conflicting remote versions are saved under `_vault-relay/conflicts/<timestamp>/<path>`. Never silently overwritten.
- **Truncated Tree Guard**: If GitHub returns `truncated: true` (>100,000 objects), sync operations are blocked to prevent partial synchronization.
- **Post-Push Verification**: Baseline state in `_vault-relay/state.json` is updated ONLY after verified remote success (re-fetching HEAD and tree).

---

## 🛠️ Installation & Testing in Real Obsidian

### 1. Build the Plugin
```bash
npm run build
```

### 2. Install into Obsidian Vault
Copy `main.js` and `manifest.json` into:
```text
<YourVault>/.obsidian/plugins/github-vault-relay/
```

> [!CAUTION]
> If you previously installed an older build under `.obsidian/plugins/vault-relay/`, delete that directory before enabling `github-vault-relay`.

### 3. Enable and Configure
1. Open Obsidian -> **Settings** -> **Community Plugins** -> Click **Reload plugins** -> Enable **GitHub Vault Relay**.
2. Go to **GitHub Vault Relay Settings**:
   - Paste your GitHub PAT and click **Save Token**.
   - Set **Repository Owner**, **Repository Name**, and **Branch** (`main`).
3. Click **Test GitHub Connection**.
4. Run command `GitHub Vault Relay: Preview sync status (Read-Only)` or click the ribbon icon.
5. Use **Pull Safe Remote Changes** or **Push Safe Local Changes** as needed.

---

## 📄 License

MIT License - Copyright (c) 2026 GitHub Vault Relay Contributors.
