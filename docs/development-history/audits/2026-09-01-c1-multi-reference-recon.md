# Vault Relay C1.6 Multi-Reference Sync Engineering Recon

**Audit Date**: September 1, 2026  
**Audited Commit**: `d0a640089df3edadcd3d99101eb59120d63ef56e`  
**Target Repository**: [ankhang0704/github-vault-relay](https://github.com/ankhang0704/github-vault-relay)  
**Reference Implementations Analyzed**:
1. **Docs Sync** (`luhaifeng666/obsidian-docs-sync`)
2. **SyncGit** (`bhoopeshrk/sync-git`)
3. **GitHub Gitless Sync** (`silvanocerza/obsidian-github-sync` / `github-gitless-sync`)
4. **Obsidian Git** (`Vinzent03/obsidian-git`) — *Mobile Failure Mode Database*
5. **FIT** (`joshuakto/fit`) — *Prior C1.5 Architectural Baseline*

---

## 1. Executive Summary & Baseline Verification

This multi-reference reconnaissance investigates real-world failure modes, mobile memory limitations, token persistence strategies, and concurrency traps across 5 independent Obsidian synchronization projects before Vault Relay implements Checkpoint 2 (Write/Sync operations).

### Baseline Quality Gate Verification
```bash
> npm run verify
> eslint . --max-warnings 0 (0 errors, 0 warnings)
> tsc --noEmit (0 errors)
> vitest run (26/26 tests passed)
> node esbuild.config.mjs production (exit 0)
```
**Working Tree**: Clean on branch `main` at commit `d0a640089df3edadcd3d99101eb59120d63ef56e`.

---

## 2. Reference Projects In-Depth Analysis

### Reference A: Docs Sync (`luhaifeng666/obsidian-docs-sync`)
- **Key Architecture**: GitHub REST / Git Data API, one verified commit per sync, optimistic branch-head validation, conflict-copy creation (preserving both files), remote deletions sent to Obsidian trash (`vault.trash()`).
- **Token Security (Obsidian SecretStorage)**:
  - Stores GitHub PAT using Obsidian's native **`SecretStorage` API** (`app.secretStorage`) rather than writing plaintext into plugin `data.json`.
  - `app.secretStorage` is officially supported in Obsidian v1.11.4+.
  - Storing in SecretStorage ensures the PAT is completely omitted from plugin `data.json`. Even if a user copies or commits their `.obsidian/` folder, the token is never exposed.
  - SecretStorage identifiers must be namespaced: `vault-relay:pat:<owner>:<repo>`.
  - **Verdict for Vault Relay**: **ADOPT Mandatory SecretStorage in C2**. Since Vault Relay is a new plugin with zero legacy user base, we mandate `SecretStorage` in C2 (`minAppVersion: 1.11.4`) with zero plaintext storage in `data.json`.

---

### Reference B: SyncGit (`bhoopeshrk/sync-git`)
- **Key Architecture**: REST-based mobile sync, offline detection (`navigator.onLine`), smart delta hashing using file metadata (`mtime` + `size`), 3-attempt concurrent race retry, 25 MiB safety guard.
- **Line-Ending Normalization (CRLF/LF)**:
  - Windows native Git often normalizes line endings (`core.autocrlf`), producing LF in Git blobs but CRLF on Windows disk.
  - SyncGit normalizes text line-endings (`\r\n` $\rightarrow$ `\n`) before computing Git blob SHAs to prevent spurious conflicts.
- **Large-File Safety**: Enforces a 25 MiB safety guard for mobile uploads.
- **Verdict**: **ADOPT** 25 MiB mobile memory ceiling and canonical text LF representation for C2.

---

### Reference C: GitHub Gitless Sync (`silvanocerza/obsidian-github-sync`)
- **Key Architecture**: Direct GitHub REST without local Git.
- **Critical Failure Modes Discovered**:
  1. *First Sync Failure*: Crashes/aborts if **both** local vault and remote repo already contain files. It erroneously requires one side to be completely empty.
  2. *API Payload Limit Crashes*: Attempting to create thousands of blobs in a single synchronous burst causes payload exhaustion and timeouts.
  3. *`TypeError: Cannot set properties of undefined (setting 'sha')`*: Corrupted in-memory metadata when remote tree is modified externally via native Git.
- **Lessons for Vault Relay**:
  - Vault Relay's `POTENTIAL_CONFLICT` classification gracefully handles initial non-empty states without crashing.
  - Vault Relay must batch Git blob creation (e.g. 5 concurrent requests) rather than firing 1,000 requests simultaneously.
  - Sync state must treat remote tree as the source of truth, expecting external native Git commits from Windows.

---

### Reference D: Obsidian Git (`Vinzent03/obsidian-git`) — Mobile Failure Modes Database
- **Why isomorphic-git fails on iOS**:
  - *Jetsam OOM (Out Of Memory)*: Loading multi-megabyte Git packfiles into the iOS WebKit JavaScript heap causes iOS to kill the Obsidian process instantly.
  - *Case-Only Rename Traps*: Renaming `note.md` $\rightarrow$ `Note.md` on case-insensitive filesystems (iOS/macOS APFS, Windows NTFS) causes isomorphic-git index corruption.
  - *Plugin Self-Deletion*: Syncing `.obsidian/plugins/` while the plugin is executing causes partial overwrites and corrupts runtime state.
- **Lessons for Vault Relay**:
  - Validates Vault Relay's core architectural thesis: **Direct REST blob streaming eliminates packfile processing and avoids Jetsam OOM crashes**.
  - Confirms `.obsidian/` must remain strictly excluded by default.

---

## 3. Corrected Technical Facts & Independent Findings

### **Fact Correction: File Size Limits (Platform vs Safety Policy)**
- **`GITHUB_PLATFORM_LIMIT`**: Official GitHub REST API documentation confirms that `POST /repos/{owner}/{repo}/git/blobs` supports blobs up to **100 MB**.
- **`VAULT_RELAY_SAFETY_POLICY`**: Vault Relay intentionally enforces a **25 MiB per-file limit** for mobile memory protection.
  - *Technical Rationale*: In browser/WebView environments, uploading a blob requires `readBinary` (ArrayBuffer) $\rightarrow$ Base64 stringification $\rightarrow$ JSON payload envelope $\rightarrow$ HTTP serialization. A 25 MiB file consumes ~100–140 MiB peak memory during string allocation in the JavaScript heap.
  - Allowing 100 MB files on iOS mobile WebKit would cause heap spikes $>400\text{ MiB}$, triggering immediate iOS Jetsam process termination (OOM crash).
  - Therefore, the 25 MiB ceiling is a **deliberate Vault Relay mobile safety policy**, not a GitHub platform limit.

---

### **Fact Correction: Line Ending Canonicalization Strategy**
- **The Problem**:
  - Windows native Git with `core.autocrlf = true` converts LF in the Git repository $\rightarrow$ CRLF on Windows disk, and CRLF on disk $\rightarrow$ LF in Git blobs.
  - If mobile reads a local note created on Windows with `\r\n` and hashes raw bytes, the calculated Git blob SHA will differ from GitHub's LF blob SHA, generating a false `LOCAL_CHANGED` / `REMOTE_CHANGED` diff.
- **The Solution (Canonical Text vs Binary)**:
  - **Text Files (`.md`, `.txt`, `.canvas`)**: Normalize line endings to canonical LF (`\n`) in memory before calculating Git blob SHA and before creating GitHub blobs. When pulling remote text, write with canonical LF (`\n`).
  - **Binary Files (images, audio, PDF, attachments)**: Hashed and written **100% byte-exact** without any string decoding or line transformation.
  - **Repository Guidance**: Recommend standard `.gitattributes` (`* text=auto eol=lf`) in documentation.

---

### **Fact Correction: Retry & Concurrency Recovery Policy**
- **HTTP 429 (Rate Limit)**: Transient issue. Parse `Retry-After` response header (default 2s backoff) and perform bounded retry (maximum 3 attempts).
- **HTTP 503 / 504 (Gateway/Service Unavailable)**: Transient issue. Apply bounded exponential backoff (1s, 2s, 4s; max 3 attempts).
- **HTTP 422 (Unprocessable Entity)**:
  - **DO NOT generically retry**.
  - If HTTP 422 is returned from `PATCH /git/refs/heads/{branch}` due to a fast-forward race condition (remote HEAD moved since preview):
    1. Immediately **abort** the pending write plan.
    2. Re-fetch the current remote HEAD commit and tree.
    3. Re-run 3-way classification against the latest remote state.
    4. Rebuild the proposed sync plan and notify/prompt the user.
  - Other 422 validation errors (e.g. invalid object SHA): Abort immediately and surface sanitized error diagnostics.

---

## 4. Cross-Project ADOPT / ADAPT / REJECT / DEFER Matrix

| Area | Current Vault Relay | Reference Experience | Verdict | Technical Rationale | Priority |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Credential Storage** | `saveData` (data.json) | Docs Sync: `SecretStorage` | **ADOPT (Mandatory)** | Mandate `app.secretStorage` in C2 (`minAppVersion: 1.11.4`). PAT never touches `data.json`. | **P1** |
| **2. First Sync Flow** | Categorizes as `POTENTIAL_CONFLICT` | Docs Sync: explicit confirmation modal | **ADAPT** | Display explicit First Sync confirmation modal before writing initial baseline commit. | **P1** |
| **3. Three-Way Baseline** | `{ localSha, remoteSha, syncedAt }` | Docs Sync / FIT: baseline from confirmed sync | **ADOPT / ALIGNED** | Retain current schema. Invariant: local baseline computed only from verified local bytes. | **P1** |
| **4. External Git Compatibility** | Designed for Windows native Git | Gitless Sync fails if external commits diverge | **ADOPT / ALIGNED** | Always fetch fresh remote HEAD before diffing; never assume linear remote history. | **P1** |
| **5. Conflict Preservation** | Preserves both versions | Docs Sync / FIT: out-of-band conflict copies | **ADAPT** | Write remote conflict version to `_vault-relay/conflicts/<path>` or `note.conflict.md`. Never overwrite local. | **P1** |
| **6. Remote HEAD Concurrency** | Atomic Git ref update (`force=false`) | Docs Sync / FIT: reject HTTP 422 if HEAD moved | **ADOPT / ALIGNED** | Core Git Data API CAS guarantee. | **P1** |
| **7. Retry / Backoff Strategy** | Single attempt in C1 | SyncGit: 3 retries on race; Octokit: retry plugin | **ADAPT (for C2)** | Differentiate 429/503 (backoff retry) from 422 (abort, re-fetch HEAD, rebuild transaction). | **P1** |
| **8. Offline Detection** | Browser error on fetch | SyncGit: `navigator.onLine` check | **ADAPT (for C2)** | Check `navigator.onLine` before initiating network scan to fail fast with friendly message. | **P2** |
| **9. Truncated Git Trees** | Captured in report | Gitless Sync: payload limit failures | **ADAPT** | Add prominent UI alert in `SyncPreviewModal` when `truncatedRemoteTree === true`. | **P1** |
| **10. Binary Attachments** | Direct `ArrayBuffer` $\rightarrow$ SHA-1 | All: byte-exact binary streaming | **ADOPT / ALIGNED** | Standard Web Crypto `ArrayBuffer` hashing is 100% byte-exact. | **P3** |
| **11. Large File Limit** | No size guard in C1 | SyncGit: 25 MB; GitHub API: 100 MB limit | **ADOPT (for C2)** | Enforce 25 MiB safety ceiling to prevent mobile memory exhaustion. | **P1** |
| **12. Line Endings (CRLF/LF)** | Raw byte hashing | SyncGit: normalizes `\r\n` $\rightarrow$ `\n` for text files | **ADAPT (for C2)** | Canonicalize text files to LF (`\n`) before hashing; binary files remain 100% byte-exact. | **P1** |
| **13. Unicode Filenames** | Standard UTF-8 URI encoding | All: `encodeURIComponent` on path segments | **ADOPT / ALIGNED** | Already implemented in `GitHubClient`. | **P3** |
| **14. Case Collisions** | Standard Map keys | Obsidian-Git: case-only rename traps on iOS | **ADAPT (for C2)** | Detect case collisions (`note.md` vs `Note.md`) before creating Git tree. | **P2** |
| **15. Rename Detection** | Defer rename heuristic | Gitless Sync / FIT: handles as delete + add | **DEFER** | Treat renames as delete + add in C2 to preserve simplicity and auditability. | **P3** |
| **16. Deletion Propagation** | Explicitly deferred in C1 | FIT: `vault.adapter.exists()` verification | **ADOPT (for C2)** | When deletion is enabled, always verify physical absence on disk before pushing delete. | **P1** |
| **17. Atomic State Persistence** | In-memory $\rightarrow$ state.json | FIT / Docs Sync: persist only after commit ref OK | **ADOPT / ALIGNED** | State is persisted strictly after HTTP 200 on Git ref update. | **P1** |
| **18. Mobile Memory Model** | REST single-blob processing | Obsidian-Git: isomorphic-git packfile OOM crashes | **ADOPT / ALIGNED** | Validates zero-packfile architecture. 25 MiB limit guarantees memory safety. | **P1** |
| **19. Protected Paths** | Default exclusions (`.obsidian/`, `.git/`, `_fit/`, `_vault-relay/`) | Docs Sync / FIT: exclude `.obsidian/` | **ADOPT / ALIGNED** | Strictly maintain exclusions to prevent mobile/desktop config corruption. | **P1** |
| **20. Hashing Performance Cache** | Full scan in C1 | SyncGit: `mtime` + `size` cache | **ADAPT (for C2)** | Add `mtime` + `size` cache to avoid re-reading unchanged files during local scan. | **P2** |

---

## 5. Harvested Regression Test Catalog

| Test ID | Source Lesson | Scenario | Expected Safe Behavior | Target |
| :--- | :--- | :--- | :--- | :--- |
| **`REG-001`** | Docs Sync / Concurrency | Remote HEAD changes between preview generation and push commit. | Ref update rejected with HTTP 422; sync engine aborts write plan, re-fetches HEAD, re-classifies diff, and prompts user. | C2 |
| **`REG-002`** | Gitless Sync / First Sync | First sync executed on a vault where both local vault and GitHub repo already have different files. | Classified as `POTENTIAL_CONFLICT`; prompts user for explicit baseline confirmation; zero file clobbering. | C2 |
| **`REG-003`** | SyncGit / File Size | User adds a 35 MiB video file to the vault. | Pre-flight check detects $>25\text{ MiB}$; file skipped with warning; sync of remaining notes proceeds. | C2 |
| **`REG-004`** | SyncGit / Line Endings | Note edited on Windows with CRLF (`\r\n`) and on iOS with LF (`\n`) with identical text. | Canonical LF representation produces identical hash; classified as `UNCHANGED`. | C2 |
| **`REG-005`** | FIT / Deletion Safety | File excluded by exclusion rule disappears from `vault.getFiles()`. | Physical check via `vault.adapter.exists()` confirms file exists on disk; deletion is NOT pushed to remote. | C2 |
| **`REG-006`** | Obsidian-Git / iOS Binary | Syncing images (`.png`, `.jpg`) and PDF attachments on iOS. | Direct `readBinary()` $\rightarrow$ Base64 blob upload succeeds without byte mutation or heap corruption. | C2 |
| **`REG-007`** | GitHub API / Rate Limit | GitHub REST returns HTTP 429 with `Retry-After: 2`. | Exponential backoff waits 2 seconds and retries up to 3 times before failing cleanly with sanitized message. | C2 |
| **`REG-008`** | SyncGit / Offline | User triggers sync while device is in Airplane Mode (`navigator.onLine === false`). | Immediate clean abort with "Device is offline" notice; zero timeout delays. | C2 |
| **`REG-009`** | Docs Sync / Mid-Sync Drop | Network disconnects after blobs are uploaded but before ref update. | Remote ref untouched; local state unchanged; subsequent sync resumes safely without duplicate commits. | C2 |
| **`REG-010`** | Obsidian-Git / Case Rename | User renames `summary.md` $\rightarrow$ `Summary.md` on iOS/Windows. | Scanner detects case collision and prevents creating duplicate dual-cased tree entries on GitHub. | C2 |
| **`REG-011`** | Docs Sync / SecretStorage | Token retrieval and persistence in `app.secretStorage`. | Token successfully retrieved from Obsidian SecretStorage; `data.json` contains zero token strings. | C2 |

---

## 6. Frozen C2 Architectural Decisions

The following architectural policies are permanently frozen for Checkpoint 2:

| Decision Key | Frozen C2 Policy | Technical Specification |
| :--- | :--- | :--- |
| **`TOKEN_STORAGE`** | **Mandatory SecretStorage** | PAT stored exclusively in `app.secretStorage` (namespaced key `vault-relay:pat:<owner>:<repo>`). `manifest.json` `minAppVersion` set to `1.11.4`. `data.json` never contains token plaintext. |
| **`FILE_SIZE_POLICY`** | **25 MiB Safety Ceiling** | Hard ceiling of 25 MiB per file for mobile memory safety. Files $>25\text{ MiB}$ are skipped with user notification. |
| **`TEXT_LINE_ENDING_POLICY`** | **Canonical LF for Text** | For `.md`, `.txt`, `.canvas`, normalize `\r\n` $\rightarrow$ `\n` in memory before computing Git blob SHA and before creating GitHub blobs. Write canonical `\n` on pull. |
| **`BINARY_POLICY`** | **100% Byte-Exact** | Non-text files (images, audio, PDF, attachments) are hashed and transferred as raw byte buffers without any modification. |
| **`429_POLICY`** | **Bounded Retry-After Backoff** | On HTTP 429, parse `Retry-After` header (default 2s), retry up to 3 times with exponential backoff. |
| **`503_504_POLICY`** | **Exponential Backoff Retry** | On HTTP 503/504, retry up to 3 times (1s, 2s, 4s). |
| **`422_POLICY`** | **No Generic Retry (Fail-Fast)** | Non-race HTTP 422 errors fail immediately with sanitized diagnostics. |
| **`REMOTE_HEAD_RACE_POLICY`** | **Abort $\rightarrow$ Re-fetch $\rightarrow$ Re-plan** | On ref update HTTP 422 race condition: abort current write transaction, re-fetch remote HEAD/tree, re-run 3-way classifier, rebuild transaction. |
| **`CASE_COLLISION_POLICY`** | **Pre-Tree Validation** | Check for duplicate paths differing only by case; halt sync if collision is detected on case-insensitive filesystems. |
| **`TRUNCATED_TREE_POLICY`** | **Prominent UI Warning** | If `treeResponse.truncated === true`, render a warning banner in preview UI alerting user of partial remote scan. |

---

## 7. Final Quality Gate Results

- **`npm run lint`**: **PASS** (0 errors, 0 warnings)
- **`npm run typecheck`**: **PASS** (0 errors)
- **`npm run test`**: **PASS** (26/26 tests passed)
- **`npm run build`**: **PASS** (exit 0)
- **`npm run verify`**: **PASS** (exit 0)
- **Production Code Status**: Unmodified and frozen at commit `d0a640089df3edadcd3d99101eb59120d63ef56e`.
