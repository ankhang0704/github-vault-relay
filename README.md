# GitHub Vault Relay

> A conservative GitHub bridge for Obsidian Mobile — without running Git on the phone.

A conservative, mobile-compatible GitHub-backed vault sync plugin designed primarily for **Obsidian on iOS (iPhone)**.

> [!IMPORTANT]
> **Current Status: Checkpoint 2 (Safe Pull: GitHub → Obsidian Local)**
> - **Supported**: GitHub → Obsidian Safe Pull with pre-write local safety, cryptographic integrity verification, and conflict preservation.
> - **Not Yet Supported**: Obsidian → GitHub Push (Checkpoint 3), bidirectional auto-sync, deletion propagation.
> - **Remote State**: Strictly **READ-ONLY** on GitHub (zero GitHub commits, blob creations, tree creations, or ref updates).

---

## 💡 Design Philosophy

GitHub Vault Relay prioritizes data integrity over the appearance of successful synchronization. When state is ambiguous, it stops or preserves both versions rather than guessing or silently overwriting data. GitHub remains compatible with external native Git workflows; GitHub Vault Relay does not assume exclusive ownership of the repository.

---

## 🏛️ Architecture & Workflow

GitHub Vault Relay is architected around an asymmetric sync model designed for users who work with their notes across desktop and mobile devices.

```
+-------------------------------------------------------------+
|                     GitHub Repository                       |
|          (Central Git Remote / Vault Source of Truth)       |
+-------------------------------------------------------------+
               ^                               |
               | (Native Git: clone/push/pull) | (GitHub REST / Git Data API: GET only)
               |                               v
+------------------------------+  +---------------------------+
|        Windows / macOS       |  |          iPhone           |
|      (Obsidian Desktop)      |  |     (Obsidian Mobile)     |
|                              |  |                           |
| • Native Git CLI / GUI       |  | • GitHub Vault Relay      |
| • Standard Git branch/merge  |  | • Direct REST to GitHub   |
| • Full local Git history     |  | • Zero Node.js / CLI req  |
| • No plugin needed on PC     |  | • Conservative Safe Pull  |
+------------------------------+  +---------------------------+
```

### Windows / Desktop Workflow
- Your existing Obsidian vault continues using standard native Git (Git CLI, Obsidian Git, or your favorite Git GUI).
- No GitHub Vault Relay plugin is required on Windows or desktop platforms.

### iPhone / Mobile Workflow
- Obsidian on iOS runs in a sandboxed mobile environment where native Git CLI, `child_process`, and Node filesystem APIs (`fs`) do not exist.
- GitHub Vault Relay communicates directly with GitHub's REST and Git Data APIs over HTTPS using Obsidian's native `requestUrl()` API.
- In Checkpoint 2, GitHub Vault Relay downloads remote notes locally with pre-write safety and conflict preservation.

---

## 🔒 Threat Model & Security Decisions

1. **Secure Device Token Storage**:
   - GitHub Vault Relay stores Personal Access Tokens (PAT) exclusively in device secure storage (Obsidian SecretStorage when available, and app-isolated local secure storage).
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

## ❓ Why Native Git / isomorphic-git is Not Used

- **Mobile Sandbox Constraints**: iOS prohibits spawning subprocesses or executing shell binaries (e.g. `git status`, `git commit`).
- **Heavyweight Bundle Avoidance**: Full Git implementations like `isomorphic-git` require emulated file systems, large polyfills, and complex packfile decoders, introducing memory overhead and stability concerns on mobile (such as Jetsam OOM terminations).
- **Auditable & Conservative**: GitHub Vault Relay directly calls GitHub's Git Data API. Every operation (tree fetch, blob hash calculation, ref check) is explicit, transparent, and easy to audit.

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

## 📊 Sync Preview Categories & Safe Pull

When you open the **Sync Preview Modal** or run **Safe Pull**, GitHub Vault Relay classifies each note into one of 6 states:

| Category | Description | Safe Pull Action |
| :--- | :--- | :--- |
| **`LOCAL ONLY`** | Exists in local vault, not present on GitHub. | Kept untouched locally (future push). |
| **`REMOTE ONLY`** | Exists in GitHub Git tree, not in local vault. | Safely created locally. |
| **`LOCAL CHANGED`** | Modified locally since last sync, remote unchanged. | Kept untouched locally (future push). |
| **`REMOTE CHANGED`** | Updated on GitHub since last sync, local unchanged. | Safely updated locally after pre-write check. |
| **`POTENTIAL CONFLICT`** | Both local and remote versions changed, or exist with differing content. | Local original untouched; remote version preserved in `_vault-relay/conflicts/`. |
| **`UNCHANGED`** | Local Git blob SHA matches remote Git blob SHA identically. | No operation needed; baseline verified. |

### Default Exclusions
GitHub Vault Relay automatically ignores internal system files and folders:
- `.obsidian/` (Theme, workspace cache, and plugin settings)
- `.git/` (Native Git repository metadata)
- `_fit/` (Mobile Fit history / sync folders)
- `_vault-relay/` (GitHub Vault Relay internal sync state & conflicts)

---

## 🛡️ Checkpoint 2 Safety Model Policies

- **25 MiB Mobile Safety Ceiling**: Remote files $>25\text{ MiB}$ are skipped during pull with a user warning to protect against iOS Jetsam memory terminations. (Note: GitHub platform limit is 100 MB).
- **Canonical LF for Text**: `.md`, `.txt`, `.canvas` text files are canonicalized to LF (`\n`) in memory before Git SHA calculation and local writing.
- **Byte-Exact Binary**: Images, PDF, audio, and binary attachments are streamed and written **100% byte-exact** without any transformation.
- **Cryptographic Integrity**: Remote blob raw SHA is strictly verified against expected Git blob SHA before any local write.
- **Pre-Write Conflict Protection**: Immediately before modifying an existing note, local bytes are re-read. If the user edited the note in Obsidian since planning, the local edit wins and the remote version is saved as a conflict copy.
- **Conflict Preservation**: Conflicting remote versions are saved under `_vault-relay/conflicts/<timestamp>/<path>`. Never overwritten.
- **Truncated Tree Guard**: If GitHub returns `truncated: true`, safe pull is completely blocked to prevent partial state corruption.
- **Strictly Zero Remote Writes**: Checkpoint 2 performs zero `POST`, `PUT`, `PATCH`, or `DELETE` requests to GitHub.

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
5. Click **Pull Safe Remote Changes** to test Safe Pull.

---

## 📄 License

MIT License - Copyright (c) 2026 GitHub Vault Relay Contributors.
