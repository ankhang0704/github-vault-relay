# GitHub Vault Relay

> **A conservative, mobile-first GitHub bridge for Obsidian — without running Git on your phone.**

[![CI](https://github.com/ankhang0704/github-vault-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/ankhang0704/github-vault-relay/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](https://github.com/ankhang0704/github-vault-relay/releases)
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
| • Compatible with PC sync    |  | • Unified Safe Sync       |
+------------------------------+  +---------------------------+
```

### Windows / Desktop Workflow
- Your existing Obsidian vault continues using standard native Git (Git CLI, Obsidian Git, or your favorite Git GUI).
- Compatible with GitHub Vault Relay desktop testing or native Git operations.

### iPhone / Mobile Workflow
- Obsidian on iOS runs in a sandboxed mobile environment where native Git CLI, `child_process`, and Node filesystem APIs (`fs`) do not exist.
- GitHub Vault Relay communicates directly with GitHub's REST and Git Data APIs over HTTPS using Obsidian's native `requestUrl()` API.
- **Unified Safe Sync**: Combines Safe Pull and Safe Push into a single `[ Sync ]` action.
- **Clean Vault Storage**: Sync metadata and conflict snapshots are kept completely hidden from your notes in internal plugin storage (`.obsidian/plugins/github-vault-relay/`).

---

## 🚀 Key Features (C4 Unified Sync)

1. **Unified Safe Sync (`[ Sync ]`)**:
   - Single-click action that runs a fresh scan, pulls remote updates safely, revalidates state, and safely pushes local changes in a single atomic Git commit (`force: false`).
2. **GitHub Connection Wizard**:
   - Enter your Fine-Grained PAT and click **Save & Connect**. The plugin automatically discovers accessible repositories and available branches via the GitHub API, setting up your vault in seconds.
3. **Clean Vault Storage & Migration**:
   - No more `_vault-relay/` folder cluttering your notes. State and conflict tracking reside in plugin-private storage inside `.obsidian/plugins/github-vault-relay/`. Existing vaults are migrated automatically and safely on startup.
4. **Immediate Preview Freshness & Fast Scans**:
   - Authoritative Git ref querying with `Cache-Control: no-cache` eliminates the 60-second iOS WebKit cache latency.
   - Built-in `LocalHashCache` leverages file modification times (`mtime`) and sizes to skip redundant hashing, reducing warm scans to under 5ms.
5. **Truthful Progress Model**:
   - Exact phase transitions (`PLANNING`, `DOWNLOADING`, `UPLOADING`, `CREATING_COMMIT`, etc.) and real-time file counts ($x / y$) with zero fake percentages.
6. **Conflict Resolution UI**:
   - Interactive card-based review with three simple choices:
     - **Keep Local**: Revalidates remote state and safely pushes your local version.
     - **Use Remote**: Safely overwrites the local file after verifying the local version hasn't changed.
     - **Keep Both**: Leaves your local note intact and saves the remote version as a conflict copy with a timestamp suffix.

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
7. Generate and copy the token (`github_pat_...`).
8. Open Obsidian -> **Settings** -> **GitHub Vault Relay**, paste your token, and click **Save & Connect**.
9. Select your repository and branch from the dropdown menus.

---

## 📊 Sync Classification Categories

When you open the **Sync Dashboard**, GitHub Vault Relay classifies each note into one of 6 states:

| Category | Description | Safe Pull Action | Safe Push Action |
| :--- | :--- | :--- | :--- |
| **`LOCAL ONLY`** | Exists in local vault, not present on GitHub. | Kept untouched locally. | Created on GitHub (`PUSH_CREATE`). |
| **`REMOTE ONLY`** | Exists in GitHub Git tree, not in local vault. | Safely created locally. | Skipped (not a local change). |
| **`LOCAL CHANGED`** | Modified locally since last sync, remote unchanged. | Kept untouched locally. | Updated on GitHub (`PUSH_UPDATE`). |
| **`REMOTE CHANGED`** | Updated on GitHub since last sync, local unchanged. | Safely updated locally. | Skipped (remote is newer). |
| **`POTENTIAL CONFLICT`** | Both local and remote versions changed independently. | Local untouched; conflict tracked for resolution. | Skipped (blocked from push to protect remote). |
| **`UNCHANGED`** | Local Git blob SHA matches remote Git blob SHA identically. | No operation needed. | No operation needed. |

---

## 🛡️ Safety & Concurrency Policies

- **Optimistic Concurrency & Zero Force-Push**: Branch ref updates strictly set `force: false`. If remote branch HEAD changes while a push is in flight, Vault Relay aborts immediately (`ABORTED / REMOTE_CHANGED_DURING_PUSH`), preventing history overwrites.
- **Atomic Single Commit**: All eligible local changes in a push are uploaded as blobs, assembled into a single Git tree on top of the base commit tree, and committed as a single atomic Git commit.
- **25 MiB Mobile Safety Ceiling**: Files $>25\text{ MiB}$ are skipped with a user warning to protect against iOS Jetsam memory terminations. (Note: GitHub platform limit is 100 MB).
- **Canonical LF for Text**: `.md`, `.txt`, `.canvas` text files are canonicalized to LF (`\n`) in memory before Git SHA calculation and upload/write operations.
- **Byte-Exact Binary**: Images, PDF, audio, and binary attachments are streamed and uploaded/written **100% byte-exact** without any transformation.
- **Cryptographic Integrity**: Blob raw SHAs are strictly verified against expected Git blob SHAs.
- **Truncated Tree Guard**: If GitHub returns `truncated: true` (>100,000 objects), sync operations are blocked to prevent partial synchronization.
