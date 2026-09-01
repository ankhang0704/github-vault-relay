# Vault Relay

A conservative, mobile-compatible GitHub-backed vault sync plugin designed primarily for **Obsidian on iOS (iPhone)**.

> [!IMPORTANT]
> **Current Status: Checkpoint 1 (Bootstrap & Read-Only Connectivity)**
> This checkpoint provides plugin bootstrap, settings configuration, GitHub REST connection testing, local vault scanning, and a **read-only sync preview modal**.
> **Strictly NO file creation, modification, deletion, git commits, or uploads are performed.**

---

## 🏛️ Architecture & Workflow

Vault Relay is architected around an asymmetric sync model designed for users who work with their notes across desktop and mobile devices.

```
+-------------------------------------------------------------+
|                     GitHub Repository                       |
|          (Central Git Remote / Vault Source of Truth)       |
+-------------------------------------------------------------+
               ^                               ^
               | (Native Git: clone/push/pull) | (GitHub REST / Git Data API)
               |                               |
+------------------------------+  +---------------------------+
|        Windows / macOS       |  |          iPhone           |
|      (Obsidian Desktop)      |  |     (Obsidian Mobile)     |
|                              |  |                           |
| • Native Git CLI / GUI       |  | • Vault Relay Plugin      |
| • Standard Git branch/merge  |  | • Direct REST to GitHub   |
| • Full local Git history     |  | • Zero Node.js / CLI req  |
| • No Vault Relay needed      |  | • Conservative sync model |
+------------------------------+  +---------------------------+
```

### Windows / Desktop Workflow
- Your existing Obsidian vault continues using standard native Git (Git CLI, Obsidian Git, or your favorite Git GUI).
- No Vault Relay plugin is required on Windows or desktop platforms.

### iPhone / Mobile Workflow
- Obsidian on iOS runs in a sandboxed mobile environment where native Git CLI, `child_process`, and Node filesystem APIs (`fs`) do not exist.
- Vault Relay communicates directly with GitHub's REST and Git Data APIs over HTTPS using Obsidian's native `requestUrl()` API.

---

## 🔒 Threat Model & Security Decisions

1. **Token Hygiene & Storage**:
   - Vault Relay uses GitHub **Fine-Grained Personal Access Tokens (PAT)**.
   - Tokens are stored locally on your device via Obsidian's plugin storage (`saveData` in `.obsidian/plugins/vault-relay/data.json`).
   - Plugin settings and internal state files (`_vault-relay/`) are **strictly excluded** from sync and never committed to GitHub.
2. **Zero Leaks & Automatic Redaction**:
   - Tokens are never printed in debug logs, error toasts, console logs, or UI notices.
   - All network errors pass through a sanitization layer (`redactTokens`) that masks PATs (`github_pat_*`, `ghp_*`, `Bearer ...`) before displaying to the user.
3. **Restricted Endpoint Destination**:
   - The token is transmitted exclusively to `https://api.github.com` and nowhere else. No third-party servers, analytics, or telemetry.
4. **Principle of Least Privilege**:
   - Configure your Fine-Grained PAT to have access **only** to your specific vault repository with **Contents: Read and Write** permissions. Do not grant organization-wide or account-wide permissions.

---

## ❓ Why Native Git / isomorphic-git is Not Used

- **Mobile Sandbox Constraints**: iOS prohibits spawning subprocesses or executing shell binaries (e.g. `git status`, `git commit`).
- **Heavyweight Bundle Avoidance**: Full Git implementations like `isomorphic-git` require emulated file systems, large polyfills, and complex packfile decoders, introducing memory overhead and stability concerns on mobile.
- **Auditable & Conservative**: Vault Relay directly calls GitHub's Git Data API. Every operation (tree fetch, blob hash calculation, ref check) is explicit, transparent, and easy to audit.

---

## ⚙️ Fine-Grained PAT Setup Guide

To create a GitHub Fine-Grained Personal Access Token:

1. Navigate to **GitHub** -> **Settings** -> **Developer Settings** -> **Personal Access Tokens** -> **Fine-grained tokens**.
2. Click **Generate new token**.
3. Set **Token name** (e.g., `Obsidian iPhone Vault Relay`).
4. Set **Expiration** as desired.
5. Under **Repository access**, select **Only select repositories** and pick your vault repository.
6. Under **Repository permissions**, configure:
   - **Contents**: `Access: Read and write` (Metadata access is automatically granted).
7. Generate and copy the token (`github_pat_...`), then paste it into the Vault Relay plugin settings in Obsidian.

---

## 📊 Sync Preview Categories (Checkpoint 1)

When you open the **Sync Preview Modal** (via ribbon icon or command palette), Vault Relay scans your local vault, calculates standard Git blob SHA-1 hashes for all notes, queries GitHub for the current branch tree, and classifies each file into one of 6 states:

| Category | Description |
| :--- | :--- |
| **`LOCAL ONLY`** | Exists in your local vault but does not exist in the remote GitHub repository. |
| **`REMOTE ONLY`** | Exists in the remote Git tree on GitHub but does not exist in your local vault. |
| **`LOCAL CHANGED`** | Content has been modified locally since the last recorded sync. Remote is unchanged. |
| **`REMOTE CHANGED`** | Content has been updated on GitHub since the last recorded sync. Local is unchanged. |
| **`POTENTIAL CONFLICT`** | Both local and remote copies have changed from the base state, or exist on both sides with differing content and no common sync history. |
| **`UNCHANGED`** | Local Git blob SHA matches the remote Git blob SHA identically. |

### Default Exclusions
Vault Relay automatically ignores internal system files and folders:
- `.obsidian/` (Theme, workspace cache, and plugin settings)
- `.git/` (Native Git repository metadata)
- `_fit/` (Mobile Fit history / sync folders)
- `_vault-relay/` (Vault Relay internal sync state)

---

## 🛡️ Safety Model Invariants (Future Checkpoints)

When write and sync capabilities are implemented in subsequent checkpoints, the engine will enforce these strict invariants:

- **Never Force-Push**: Branch references are updated only if the remote HEAD matches the expected parent.
- **Pre-Flight Validation**: Remote commit HEAD is re-verified immediately before applying any change.
- **Never Silently Overwrite**: Conflicting content is never overwritten automatically; both local and remote versions will be preserved.
- **Manual Sync First**: Reliable manual sync and preview must exist before any automatic/background sync is introduced.
- **Deletion Deferred**: Deletion propagation is safely deferred to protect against accidental mass deletions.

---

## 🛠️ Development & Testing

### Requirements
- Node.js 20+
- npm

### Installation & Build
```bash
# Install dependencies
npm install

# Run automated tests (Vitest)
npm run test

# Build production bundle (tsc + esbuild)
npm run build

# Start live development watch
npm run dev
```

### Running Tests
The unit test suite covers:
- Exclusion path filtering and normalization.
- Git blob SHA-1 computation matching standard Git objects.
- 6-state sync preview classification matrix (including conflict detection).
- Token sanitization and redaction across errors and API client.

```bash
npm run test
```

---

## 🧪 Smoke Testing in Obsidian Desktop

To test the development build in your Obsidian desktop app:

1. In this project directory, run:
   ```bash
   npm run build
   ```
2. Locate your target Obsidian vault's plugin directory:
   `<VaultFolder>/.obsidian/plugins/vault-relay/`
   *(Create the `vault-relay` directory if it does not exist)*.
3. Copy the following files into `<VaultFolder>/.obsidian/plugins/vault-relay/`:
   - `main.js`
   - `manifest.json`
4. Open **Obsidian** -> **Settings** -> **Community Plugins**.
5. Enable **Community Plugins** (if not already enabled) and click **Reload Plugins**.
6. Toggle **Vault Relay** to **ON**.
7. In **Vault Relay Settings**:
   - Enter your GitHub Fine-Grained PAT (`github_pat_...`).
   - Enter your repository owner (e.g. `your-username`).
   - Enter your repository name (e.g. `your-vault-repo`).
   - Leave branch as `main` (or specify your branch).
8. Click **Test Connection** to verify connection to GitHub.
9. Click **Open Sync Preview** (or click the ribbon icon / run command `Vault Relay: Preview sync status (Read-Only)`) to view the classified preview report.

---

## 📄 License

MIT License - Copyright (c) 2026 Vault Relay Contributors.
