# GitHub Vault Relay

> **A conservative, mobile-first GitHub sync bridge for Obsidian — without running Git on your phone.**

[![CI](https://github.com/ankhang0704/github-vault-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/ankhang0704/github-vault-relay/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.6.0-blue.svg)](https://github.com/ankhang0704/github-vault-relay/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GitHub Vault Relay connects your **Obsidian Mobile (iPhone / iPad)** and **Desktop** vaults directly to your GitHub repository using GitHub's REST and Git Data APIs over HTTPS. It requires **no native Git installation, no command line tools, no isomorphic-git polyfills, and zero background daemons**.

---

## 🏛️ What GitHub Vault Relay Does

- **Unified Safe Sync**: A single `[ Sync ]` action safely pulls eligible remote changes, then replans and pushes eligible local changes. Each Safe Push batch is committed to GitHub as one Git commit (`force: false`). Unified Sync is intentionally not an end-to-end transaction: a successful Pull is not rolled back merely because a later Push fails.
- **Safe Deletion & Move Semantics**: Respects the complete filesystem lifecycle (CREATE, EDIT, MOVE/RENAME, DELETE). Deletion requires baseline synchronized existence proof. Moves are pushed in a single atomic Git commit (`delete old` + `add new`) and pulled safely (`destination` materialized and verified before `source` is deleted).
- **Data Integrity Over Convenience**: Explicit failure over silent guessing. When state is ambiguous, Vault Relay halts safely and preserves both versions.
- **Mobile-First iOS/Android Design**: Communicates via Obsidian's native HTTPS requests (`requestUrl()`). Never invokes Node.js child processes or native Git.
- **Clean Vault Experience**: Internal state is kept under `.obsidian/github-vault-relay/` and is not treated as normal vault note content.
- **Fast and Fresh**: Authoritative Git ref reads are designed to avoid stale mobile HTTP-cache results, while bounded local hash caching reduces unnecessary repeated file hashing.
- **Full External Git Compatibility**: Fully compatible with native Git on desktop, Obsidian Git, or web edits on GitHub. Vault Relay does not assume exclusive ownership of your repository.

---

## 🚫 What GitHub Vault Relay Does NOT Do (Feature Freeze)

To guarantee rock-solid data safety on mobile devices, the following are deliberate non-goals:

- **No background auto-sync or scheduled sync**: Sync runs only when explicitly triggered by you.
- **No sync-on-save**: Prevents battery drain, race conditions, and accidental Git commit spam.
- **No ambiguous or unverified deletion**: Deletion is never inferred without previous baseline synchronized existence evidence. Missing baseline cannot safely infer deletion (treated conservatively as local-only or remote-only).
- **No empty directory synchronization**: Git tracks file paths, not directory nodes. Empty directories are not synchronized.
- **No fuzzy / AI rename guessing**: Moves are recognized strictly when content SHA is byte-identical or handled safely as independent delete + add.
- **No force push**: Every branch update uses `force: false`. If remote branch HEAD changes unexpectedly, sync aborts safely.
- **No alternative Git forges**: GitHub REST/Git Data API only (no GitLab, Gitea, or WebDAV).
- **No Canvas 3-way merge**: JSON Canvas files are treated as atomic units.
- **No `.obsidian/` configuration sync**: Excluded by default (`.obsidian/`, `.git/`, `_fit/`).
- **No attachment importer tool**: Attachments inside notes sync normally, but no special import tool is bundled.
- **No multi-account switching**: Single configured GitHub account and repository per vault.

---

## 📦 Installation & Setup

### Option A: Install via BRAT (Recommended for Beta / Mobile)

1. Install the [Obsidian BRAT](https://github.com/TfTHacker/obsidian-42-brat) community plugin.
2. In Obsidian Settings, navigate to **BRAT** -> **Add Beta plugin**.
3. Enter repository URL: `https://github.com/ankhang0704/github-vault-relay`.
4. Enable **GitHub Vault Relay** under Community Plugins.

### Option B: Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Place them in your vault at `.obsidian/plugins/github-vault-relay/`.
3. Reload Obsidian and enable the plugin in Community Plugins.

---

## 🔑 GitHub Personal Access Token (PAT) Setup

### Creating a Fine-Grained PAT (Recommended)

1. Open GitHub -> **Settings** -> **Developer Settings** -> **Personal Access Tokens** -> **Fine-grained tokens**.
2. Click **Generate new token**.
3. Set **Token name** (e.g., `Obsidian Mobile Vault Relay`).
4. Set **Expiration** (e.g., 90 days or 1 year).
5. Under **Repository access**, select **Only select repositories** and pick your vault repository.
6. Under **Repository permissions**, configure:
   - **Contents**: `Access: Read and write` (Metadata read access is included automatically).
7. Click **Generate token** and copy the token string (`github_pat_...`).

### Connection Wizard

1. Open Obsidian -> **Settings** -> **GitHub Vault Relay**.
2. Paste your token into the **GitHub Personal Access Token** field.
3. Click **Save & Connect**.
4. The wizard automatically discovers your accessible repositories and branch names.
5. Select your target repository and default branch (e.g., `main`), then close settings.

---

## 🔄 How Sync Works

### 1. Unified Sync (`[ Sync ]`)
- Open the **Sync Dashboard** from the ribbon icon or Command Palette (`GitHub Vault Relay: Open Sync Dashboard`).
- Click **Sync**. Vault Relay performs:
  1. **Planning**: Discovers local notes and fetches the remote Git tree.
  2. **Safe Pull**: Downloads and verifies any remote changes where your local note has not changed.
  3. **Revalidation**: Checks remote HEAD again to verify no concurrent changes occurred.
  4. **Safe Push**: Assembles local changes into blobs, builds a new Git tree, creates a single commit, and updates the branch ref (`force: false`).
  5. **Post-Write Verification**: Confirms GitHub's authoritative ref matches the new commit before updating local baseline state.

### 2. Truthful Progress UX
During any sync operation, the progress dialog displays the active phase and exact file counters:
```
[ PLANNING ] Scanning vault and remote tree...
[ DOWNLOADING ] Pulling remote changes (2 / 5 files)...
[ CREATING_COMMIT ] Creating single atomic Git commit...
[ UPDATING_REF ] Updating branch ref main...
[ VERIFYING ] Verifying remote ref update...
```
No synthetic percentages or misleading smooth progress bars are used.

---

## ⚔️ Conflict Resolution

When a file has been modified both locally and remotely since the last sync, it is classified as a **Potential Conflict**. Vault Relay never silently overwrites either version.

Open **Conflict Resolution** (`GitHub Vault Relay: Review Conflicts`) to review and resolve:

| Option | What It Does | Safety Guarantee |
| :--- | :--- | :--- |
| **Keep Local** | Revalidates remote state and pushes your local version to GitHub. | Scoped authorized push; aborts safely if remote changed during review. |
| **Use Remote** | Overwrites the local note with the latest remote version. | Re-verifies local file matches reviewed version; saves a local backup first. |
| **Keep Both** | Leaves your local note untouched and saves the remote version alongside it as `filename (Conflict YYYY-MM-DD-HHmmss).ext`. | Zero overwrites; both versions immediately available. |

---

## 🗑️ Safe Deletion & Move Semantics

GitHub Vault Relay synchronizes normal filesystem deletions and moves across Windows, GitHub, and iPhone without destructive guessing.

### 1. Three-Way Deletion Model
Deletion is never inferred simply from "file missing". It requires a three-way comparison between **Baseline** (last synchronized state), **Local Vault**, and **Remote GitHub**:
- **Local Deleted**: File was present in baseline and matches remote, but is absent locally. Vault Relay creates a new Git tree omitting the file (`sha: null`), commits, updates the ref (`force: false`), and only prunes baseline after verified remote deletion.
- **Remote Deleted**: File was present in baseline and matches local, but is absent on GitHub. Vault Relay creates durable recovery evidence in `.obsidian/github-vault-relay/delete-recovery/`, removes the local file via `app.vault.delete()`, verifies absence, prunes baseline, and cleans up recovery evidence.
- **Both Deleted**: File is absent both locally and remotely. Vault Relay silently prunes the obsolete baseline entry.
- **Delete Conflict**: One side deleted the file while the other side modified it (e.g., deleted locally but edited on GitHub, or deleted remotely but edited locally). Vault Relay halts safely and offers explicit contextual resolution:
  - **`[ Keep File ]`**: Retains the modified version on both sides.
  - **`[ Delete File ]`**: Authorizes deletion of the modified file with full revalidation.
  - **`[ Cancel ]`**: Leaves both states untouched.

### 2. Move & Rename Lifecycle
In Git, a Move is represented as **`DELETE old_path` + `ADD new_path`**:
- **Safe Push**: When a note is moved or renamed locally, Safe Push batches both the deletion of the old path and the addition of the new path into **one atomic Git commit**.
- **Safe Pull**: When pulling a remote move, Vault Relay enforces strict ordering:
  1. Writes and verifies the destination file byte-exact.
  2. Deletes the source file only after the destination write is confirmed.
  3. Updates baseline and cleans recovery journals.
  If destination materialization fails, the source file remains untouched.
- **Exact-SHA Move Detection**: When the new path has the exact same blob SHA as the deleted baseline path, Vault Relay detects the move in the UI preview (`Projects/A.md → Archive/A.md`).
- **Empty Directories**: Git does not track directory nodes. Empty folder moves are not synchronizable.
- **Lost Baseline**: Without previous baseline synchronization evidence, missing files cannot safely be inferred as deleted and are treated conservatively as untracked (`LOCAL_ONLY` / `REMOTE_ONLY`).

---

## 📁 File Types, Binaries & 25 MiB Safety Ceiling

- **Text Files** (`.md`, `.txt`, `.canvas`): Line endings are canonicalized to LF (`\n`) in memory for Git hash computation and storage.
- **Binary Files** (PNG, JPG, PDF, audio, etc.): Transferred and written **100% byte-exact** without character encoding conversion.
- **25 MiB Safety Ceiling**: Individual files larger than 25 MiB are skipped with an explanatory notice. This safeguards mobile devices against memory termination (iOS Jetsam) and mobile data exhaustion.

---

## 🔒 Security & Privacy Architecture

- **Obsidian SecretStorage Only**: Your PAT is stored exclusively in Obsidian's secure device storage (`github-vault-relay-pat`).
- **No Plaintext Storage**: Tokens are never stored in plugin `data.json` or `localStorage`.
- **Zero Token Leakage**: All logs, error dialogs, and notifications pass through an automatic token redaction layer that masks PAT patterns.
- **Minimal Write Surface**: All remote updates use Git Data API endpoints (`/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`). Vault Relay never uses `PUT /contents` or `DELETE` endpoints.
- **Clear Token Confirmation**: Clearing your token requires explicit modal confirmation and securely wipes credentials from device storage.

---

## 🗄️ Internal Storage & Migration

- Internal state is kept under `.obsidian/github-vault-relay/` and is not treated as normal vault note content:
  - `state.json`: Tracked commit SHAs and file baselines.
  - `conflicts_meta.json`: Active conflict records.
  - `conflicts/`: Isolated conflict payloads.
- **Automatic Migration**: Upgrading from earlier versions (0.3.0, 0.4.0, or legacy `_vault-relay/`) runs automatically on startup.
- **Preserved User Content**: Any user notes inside a root `_vault-relay/` folder are preserved as normal notes and never deleted.

---

## 📴 Offline & Failure Recovery

- **Offline Mode**: If network connectivity is lost, sync fails fast and gracefully without altering local files or baseline state.
- **Interruption Recovery**: If Obsidian is closed or killed mid-sync:
  - Interrupted Pull writes are detected and rolled back to known baselines on next launch.
  - Atomic state writes use `.tmp` staging and `.bak` fallbacks to prevent corrupted metadata.
  - The next sync will safely re-scan and resume convergence.

---

## ⚠️ Known Limitations

- **GitHub API Rate Limits**: Standard GitHub authenticated API rate limits apply.
- **Repository Size Limit**: Repositories returning truncated Git trees (>100,000 files) are blocked for safety.
- **Single Repository / Branch**: Multi-repo and multi-branch concurrent sync is not supported.

---

## 📚 Technical Documentation & Resources

- **Security Policy & Disclosures**: [SECURITY.md](SECURITY.md)
- **System Architecture & Data Flows**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Project Source of Truth**: [docs/PROJECT_SOURCE_OF_TRUTH.md](docs/PROJECT_SOURCE_OF_TRUTH.md)
- **Real-Device Acceptance Protocol**: [docs/MANUAL_TEST_MATRIX.md](docs/MANUAL_TEST_MATRIX.md)
- **Contributing & Development**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Changelog**: [CHANGELOG.md](CHANGELOG.md)
- **Complete Documentation Index**: [docs/README.md](docs/README.md)
