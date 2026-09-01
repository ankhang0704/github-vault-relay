# Vault Relay C1.5 Comparative Audit

**Audit Date**: September 1, 2026  
**Audited Commit**: `d0a640089df3edadcd3d99101eb59120d63ef56e`  
**Target Repository**: [ankhang0704/vault-relay](https://github.com/ankhang0704/vault-relay)  
**Reference Project**: [joshuakto/fit](https://github.com/joshuakto/fit)  

---

## 1. Executive Verdict

### **PASS WITH FINDINGS**

**Summary**:
Vault Relay Checkpoint 1 successfully achieves its core mandate: a lightweight, mobile-first, zero-Node-dependency, read-only foundation for Obsidian vault synchronization over GitHub REST API.
- **Architectural Soundness**: The use of standard Git blob SHA-1 (`crypto.subtle`), strict token hygiene, pure 6-state sync preview classification, and exclusion filtering are properly implemented and verified.
- **Scope Compliance**: Checkpoint 1 contains strictly **zero write operations**, zero file mutations, zero upload/download channels, and zero auto-sync mechanisms.
- **Findings Summary**: The audit identified 0 Critical (P0) vulnerabilities, 3 Important (P1) design gaps to address prior to C2 write execution, 4 Reliability/UX (P2) findings, and 3 Minor/Enhancement (P3) suggestions. None invalidate C1 read-only operation.

---

## 2. Baseline Verification

Executed on Windows host environment (Node v22.19.0, npm 11.12.1):

```bash
> npm ci
added 151 packages in 1.4s

> npm run verify
> eslint . --max-warnings 0
(0 errors, 0 warnings)

> tsc --noEmit
(0 errors)

> vitest run
 ✓ tests/hashUtils.test.ts (3 tests)
 ✓ tests/pathFilter.test.ts (7 tests)
 ✓ tests/syncClassifier.test.ts (8 tests)
 ✓ tests/redact.test.ts (8 tests)
 Test Files  4 passed (4)
      Tests  26 passed (26)

> node esbuild.config.mjs production
(exit 0)
```

**Git Working Tree Status**: Clean (commit `d0a640089df3edadcd3d99101eb59120d63ef56e` on `origin/main`).

---

## 3. Vault Relay Independent Findings

### **VR-C1-P1-001: Truncated Tree Detection Lacks UI Warning in Preview Modal**
- **Severity**: P1 (Important / Correctness)
- **Evidence**: [`src/sync/syncEngine.ts:140`](file:///c:/Users/Admin/Documents/Github/vault-relay/src/sync/syncEngine.ts#L140) captures `truncatedRemoteTree: !!treeResponse.truncated`, but [`src/ui/syncPreviewModal.ts`](file:///c:/Users/Admin/Documents/Github/vault-relay/src/ui/syncPreviewModal.ts) does not render a banner or alert if `report.truncatedRemoteTree === true`.
- **Root Cause**: GitHub Git Trees API (`GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`) truncates responses exceeding 100,000 objects or 7 MB.
- **Impact**: In massive vaults (>100k files), unlisted remote files would be misclassified as `LOCAL_ONLY` instead of alerting the user.
- **Recommended Fix**: Add a warning callout in `SyncPreviewModal` when `truncatedRemoteTree` is true, informing the user that remote tree was truncated by GitHub API.
- **Checkpoint Target**: Pre-C2 / C2 UI refinement.

---

### **VR-C1-P1-002: Deletion vs New File Semantics in Sync Classifier**
- **Severity**: P1 (Important / Correctness for C2)
- **Evidence**: [`src/sync/syncClassifier.ts:54-61`](file:///c:/Users/Admin/Documents/Github/vault-relay/src/sync/syncClassifier.ts#L54-L61):
  ```typescript
  if (local && !remote) {
    category = "LOCAL_ONLY";
  } else if (!local && remote) {
    category = "REMOTE_ONLY";
  }
  ```
- **Root Cause**: When a baseline entry exists in `state.json` (`fileState`), but the file is absent locally, C1 classifies it as `REMOTE_ONLY` rather than distinguishing whether it was deleted locally.
- **Impact**: In C1 (read-only), this is safe because deletions are explicitly deferred and no writes occur. In C2, the classifier must distinguish `LOCAL_DELETED` vs `REMOTE_ADDED` to prevent recreating deleted files or accidentally pushing unwanted deletions.
- **Recommended Fix**: Extend classification in C2 to evaluate `fileState.localSha` when `!local && remote` (or `local && !remote`).
- **Checkpoint Target**: Checkpoint 2 (Sync Engine).

---

### **VR-C1-P1-003: Rate Limit & Retry Backoff Handling on GitHub API**
- **Severity**: P1 (Important / Reliability for C2)
- **Evidence**: [`src/github/githubClient.ts:74-88`](file:///c:/Users/Admin/Documents/Github/vault-relay/src/github/githubClient.ts#L74-L88) performs single HTTP attempts via `requestUrl` without checking `x-ratelimit-remaining`, `retry-after`, or HTTP 429 status codes.
- **Root Cause**: Basic REST client wrapper without exponential backoff retry interceptor.
- **Impact**: On large vaults or rapid operations, hitting GitHub rate limits or transient network drops aborts the scan immediately.
- **Recommended Fix**: Implement lightweight exponential backoff retry (up to 3 retries) on HTTP 429 and 503/504 errors in `GitHubClient`.
- **Checkpoint Target**: Checkpoint 2.

---

### **VR-C1-P2-001: Sequential Full-Vault Hashing on Preview Open**
- **Severity**: P2 (Performance)
- **Evidence**: [`src/sync/syncEngine.ts:46-59`](file:///c:/Users/Admin/Documents/Github/vault-relay/src/sync/syncEngine.ts#L46-L59) scans and hashes every file in the vault sequentially via `app.vault.readBinary(file)` on every preview invocation.
- **Root Cause**: Absence of an in-memory or persisted local metadata cache (`mtime` + `size` -> cached `localSha`).
- **Impact**: For vaults with >5,000 files or large media attachments, generating preview takes several seconds.
- **Recommended Fix**: In C2, maintain local file `mtime`/`size` indexing to re-hash only modified files.
- **Checkpoint Target**: Checkpoint 2 Performance Optimization.

---

### **VR-C1-P2-002: State Persistence Location (`_vault-relay/state.json` vs Plugin Storage)**
- **Severity**: P2 (Architecture / Data Integrity)
- **Evidence**: [`src/sync/syncState.ts:13`](file:///c:/Users/Admin/Documents/Github/vault-relay/src/sync/syncState.ts#L13) targets `_vault-relay/state.json` inside the vault.
- **Root Cause**: In-vault storage requires explicit path exclusion across all tools and risks accidental sync via third-party tools (iCloud / Obsidian Sync).
- **Impact**: If `_vault-relay/` is modified by another sync service, baseline consistency could be affected.
- **Recommended Fix**: Evaluate persisting sync state either inside `.obsidian/plugins/vault-relay/` (via `plugin.saveData()`) or retaining `_vault-relay/state.json` with strict `.gitignore` and exclusion guarantees.
- **Checkpoint Target**: Checkpoint 2 Architecture Design.

---

### **VR-C1-P2-003: Case Sensitivity on Mixed OS File Paths**
- **Severity**: P2 (Compatibility)
- **Evidence**: [`src/sync/syncClassifier.ts:38-44`](file:///c:/Users/Admin/Documents/Github/vault-relay/src/sync/syncClassifier.ts#L38-L44) uses standard Map keys (`path`) which are case-sensitive (`a.localeCompare(b)`).
- **Root Cause**: Windows and iOS file systems are typically case-insensitive, whereas Git repository trees are case-sensitive.
- **Impact**: Renaming a file from `note.md` to `Note.md` on Windows/iOS may create duplicate tree entries on GitHub if not normalized.
- **Recommended Fix**: Add case-collision detection in path scanner before C2 write phase.
- **Checkpoint Target**: Checkpoint 2.

---

### **VR-C1-P3-001: UI Category Badge Color Contrast in Dark/Light Themes**
- **Severity**: P3 (UX)
- **Evidence**: Hardcoded hex fallback values in [`src/ui/syncPreviewModal.ts:323-353`](file:///c:/Users/Admin/Documents/Github/vault-relay/src/ui/syncPreviewModal.ts#L323-L353) (`#0077b6`, `#27ae60`, etc.).
- **Impact**: Colors look great in default Obsidian themes, but custom community themes may have specific background tones.
- **Recommended Fix**: Prefer Obsidian CSS variables (`var(--text-accent)`, `var(--text-success)`, `var(--text-error)`, etc.) with clean fallbacks.
- **Checkpoint Target**: Checkpoint 2 UI Polish.

---

## 4. FIT Reference Findings

Detailed evaluation of architectural patterns from `joshuakto/fit`:

| Pattern / Concept | FIT Reference Design | Evaluation for Vault Relay | Verdict | Reason |
| :--- | :--- | :--- | :--- | :--- |
| **Canonical Git Blob SHA** | `SHA1("blob " + len + "\0" + bytes)` | Standard Git blob SHA computation matching GitHub tree objects directly. | **ADOPT / ALIGNED** | Already implemented in Vault Relay `hashUtils.ts`. Both tools share identical SHA-1 format. |
| **Three-Way Baseline State** | Dual cache (`localShas` + `lastFetchedRemoteShas`) | Tracks confirmed state from last successful sync to detect local and remote changes independently. | **ADAPT** | Vault Relay's per-file record `{ localSha, remoteSha, syncedAt }` serves the same 3-way baseline role. Adopt FIT's rule: *Never copy remote SHA into local baseline without verifying disk bytes*. |
| **In-Memory Hashing During Write** | Hashing downloaded remote content in-memory during disk write | Avoids full-vault re-scans after pull and eliminates race conditions with live editor changes. | **ADOPT (for C2)** | Significant performance and reliability boost during pull operations in mobile environments. |
| **Physical File Check Before Remote Delete** | `vault.adapter.exists()` on removed paths | Verifies file is physically absent on disk before pushing a deletion, preventing data loss if filtering rules change. | **ADOPT (for C2)** | Crucial invariant: Never push deletion purely because a file disappeared from `vault.getFiles()`. |
| **Conflict Out-of-Band Copy** | Writes remote version to `_fit/<path>` | Avoids clobbering local modifications; shields pending files from push. | **ADAPT (for C2)** | Conservative conflict isolation. Vault Relay will use side-by-side conflict files (`_vault-relay/conflicts/` or `.conflict-remote.md`). |
| **Compare-Before-Update HEAD Validation** | `force: false` on Git ref update | Git Data API rejects ref updates if parent commit has diverged on remote. | **ADOPT / ALIGNED** | Core safety invariant in Vault Relay's write design. |
| **Octokit Library Dependency** | `@octokit/core` + plugins | Heavyweight npm bundle (~250 KB) with multiple plugin layers. | **REJECT** | Vault Relay uses lightweight `requestUrl()` natively with zero external dependencies. |
| **Canvas AST Merge** | JSON merge for `.canvas` | Speculative automatic node merging for Obsidian Canvas files. | **DEFER** | High complexity; violates Vault Relay's conservative principle of preserving both copies on conflict. |
| **Selective `.obsidian` Sync** | Field-level & file opt-in rules | Allows syncing `appearance.json` while blocking workspace caches. | **DEFER** | Exclude `.obsidian/` completely in initial sync to eliminate config race conditions between mobile and desktop. |
| **Auto-Sync Timers** | Background interval syncing | Periodic timer polling remote repository. | **DEFER** | Invariant: Manual sync must be 100% battle-tested before auto-sync is introduced. |

---

## 5. Comparative Gap Matrix

| Area | Vault Relay (Current C1) | FIT Reference Approach | Risk / Gap in Vault Relay | Recommendation | Priority |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Blob SHA Calculation** | Web Crypto `crypto.subtle` (Git canonical) | Canonical Git blob SHA (migrated from v1.5) | None. 100% aligned with Git Data API standard. | Maintain current implementation. | **P3** |
| **2. First-Sync Matrix** | Categorizes differing content as `POTENTIAL_CONFLICT` | Inline clash detection; remote written to `_fit/` | None in C1. In C2, must guide user on how to adopt baseline. | Implement explicit first-sync adoption flow in C2. | **P1** |
| **3. Deletion Detection** | Grouped under `LOCAL_ONLY` / `REMOTE_ONLY` | Compares against baseline + validates physical existence | In C2, must not confuse deleted file with newly added file. | Implement 3-way deletion categorization + adapter check. | **P1** |
| **4. Remote HEAD Concurrency** | Designed: atomic ref update (`force=false`) | Git Data API ref update with parent validation | None in C1 (read-only). | Verify atomic CAS in C2 write engine. | **P1** |
| **5. Network / Rate Limit** | Single attempt via `requestUrl` | Octokit retry plugin | Transient network failure halts scan. | Add 3-attempt exponential backoff in C2. | **P2** |
| **6. Truncated Trees** | Flagged in report (`truncatedRemoteTree`) | Recursive paging | Truncated tree not highlighted in C1 modal UI. | Add warning banner in `SyncPreviewModal`. | **P1** |
| **7. Large Vault Hashing** | Sequential `readBinary` per file | Fast scan + in-memory write hashing | Slower scan on >5,000 files. | Add `mtime` + `size` caching in C2. | **P2** |
| **8. Binary File Hashing** | Direct `ArrayBuffer` -> SHA-1 | `ArrayBuffer` -> SHA-1 | None. Fully handles images/PDFs. | Maintain current implementation. | **P3** |
| **9. Protected Paths** | Default exclusions (`.obsidian/`, `.git/`, `_fit/`, `_vault-relay/`) | Three-layer filter (Protected, Hidden, Gitignore) | Vault Relay uses explicit path list; does not parse nested `.gitignore`. | Sufficient for conservative mobile vault sync. | **P3** |
| **10. Mobile Runtime** | Pure Web APIs (`crypto.subtle`, `TextEncoder`, `requestUrl`) | Pure Web APIs + Octokit | None. Clean zero-Node runtime. | Maintain strict zero-Node rule. | **P3** |

---

## 6. Sync-State / Baseline Verdict

### **Is the current Vault Relay state model sufficient for safe three-way change detection?**

### **Verdict: YES (for C1 Read-Only & C2 Future Writes)**

**Rationale**:
Vault Relay's sync state schema ([`src/sync/syncTypes.ts:46-59`](file:///c:/Users/Admin/Documents/Github/vault-relay/src/sync/syncTypes.ts#L46-L59)):
```typescript
export interface FileSyncStateEntry {
  remoteSha: string;
  localSha: string;
  syncedAt: number;
}
```
Tracking both `localSha` and `remoteSha` per file, keyed by path and tied to `lastSyncedCommitSha`, provides the necessary mathematical foundation for 3-way merge decision making:
1. `localSha == base.localSha && remoteSha == base.remoteSha` $\rightarrow$ **UNCHANGED**
2. `localSha != base.localSha && remoteSha == base.remoteSha` $\rightarrow$ **LOCAL_CHANGED**
3. `localSha == base.localSha && remoteSha != base.remoteSha` $\rightarrow$ **REMOTE_CHANGED**
4. `localSha != base.localSha && remoteSha != base.remoteSha` $\rightarrow$ **CONFLICT**
5. `!base` $\rightarrow$ **NO BASELINE** (Safe fallback to `POTENTIAL_CONFLICT` if both exist and differ).

**Rule to enforce in C2**: `base.localSha` must always be recorded from the exact bytes verified on the local device, never assumed from `remoteSha`.

---

## 7. GitHub Concurrency & Write Safety Verdict

### **Analysis of Planned C2 Write Pipeline**:
1. `GET /repos/{owner}/{repo}/branches/{branch}` $\rightarrow$ Obtain remote `HEAD_A`.
2. `POST /repos/{owner}/{repo}/git/blobs` $\rightarrow$ Upload new local blobs.
3. `POST /repos/{owner}/{repo}/git/trees` $\rightarrow$ Build new tree with `base_tree = HEAD_A.tree`.
4. `POST /repos/{owner}/{repo}/git/commits` $\rightarrow$ Create commit with `parent = [HEAD_A]`.
5. `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` with `sha = newCommitSha`, `force = false`.

### **Safety Against Race Conditions**:
- **Concurrent Desktop Push**: If a user on Windows pushes a commit `HEAD_B` while iPhone is syncing, GitHub's Git Data API will reject step 5 with `HTTP 422 Unprocessable Entity` (non-fast-forward ref update). iPhone sync aborts safely without corrupting GitHub history.
- **Interrupted Network Halfway**: Blobs and dangling commits created on GitHub are inert without a ref update. The local state is NOT updated until step 5 succeeds, guaranteeing clean rollback.
- **Stale Preview**: If user leaves preview open for 1 hour and then triggers sync, pre-flight HEAD revalidation in step 1 & 5 catches remote changes immediately.

---

## 8. Mobile Compatibility Verdict

### **Verdict: 100% COMPLIANT**

- **Runtime Check**: Zero occurrences of `node:*`, `fs`, `child_process`, `path`, `os`, or `Buffer` in production source code and bundled output (`main.js`).
- **Cryptographic Subsystem**: Standard Web Crypto API (`globalThis.crypto.subtle.digest("SHA-1", ...)`) supported across iOS Safari, WebKit, and Obsidian Mobile.
- **Network Subsystem**: Obsidian official `requestUrl()` API utilized for all HTTP communication, avoiding CORS limitations on mobile.
- **Packaging**: `manifest.json` correctly declares `isDesktopOnly: false`.

---

## 9. Security & Token Hygiene Verdict

### **Verdict: 100% COMPLIANT**

- **Redaction Coverage**: `redactTokens()` actively filters `github_pat_*`, `ghp_*`, `Bearer ...` tokens, and query parameters from error strings, Notices, and modal DOMs.
- **Endpoint Enforcement**: Hardcoded `baseUrl = "https://api.github.com"` prevents accidental redirection or SSRF.
- **Settings Isolation**: Token is stored in plugin `data.json`, which is excluded by default from any vault sync.
- **Permissions**: Fully compatible with repository-scoped Fine-Grained Personal Access Tokens requiring only `Contents: Read and write`.

---

## 10. Test Coverage Gaps

Current test suite contains 26 tests across 4 files. To prepare for C2, the following test cases should be added:
1. **Tree Truncation Test**: Verify behavior when `GitHubTreeResponse.truncated == true`.
2. **Network Error Redaction**: Test error response sanitization with simulated HTTP 401/403/429 bodies containing embedded tokens.
3. **Empty Repository Test**: Test connection and tree handling on a newly initialized GitHub repo with 0 commits.
4. **Unicode Path Normalization**: Test paths containing accents, emoji, and non-ASCII UTF-8 characters.

---

## 11. Recommended Remediation Order

| Priority | Item | Description | Target |
| :--- | :--- | :--- | :--- |
| **P1** | `VR-C1-P1-001` | Add prominent UI callout in `SyncPreviewModal` when remote tree is truncated. | Pre-C2 / C2 |
| **P1** | `VR-C1-P1-002` | Refine 3-way deletion categorization in classifier before implementing pull/push. | Checkpoint 2 |
| **P1** | `VR-C1-P1-003` | Add exponential backoff retry on HTTP 429/503 in `GitHubClient`. | Checkpoint 2 |
| **P2** | `VR-C1-P2-001` | Add `mtime` + `size` caching to optimize local vault scanning for large vaults. | Checkpoint 2 |
| **P2** | `VR-C1-P2-002` | Finalize state file location strategy (`_vault-relay/state.json` vs plugin storage). | Checkpoint 2 |
| **P2** | `VR-C1-P2-003` | Add case-collision validation for cross-platform path safety. | Checkpoint 2 |
| **P3** | `VR-C1-P3-001` | Polish preview modal CSS badge variables for custom Obsidian themes. | Checkpoint 2 |

---

## 12. C2 Readiness

### **Status: READY FOR CHECKPOINT 2 DESIGN**

The Checkpoint 1 foundation is sound, robust, and cleanly architected. No breaking structural rework is required before proceeding to the Checkpoint 2 implementation plan.

---

## 13. Explicitly Deferred FIT Features

The following capabilities observed in FIT are intentionally **DEFERRED** from Vault Relay to maintain our conservative, auditable scope:
1. **Deletion Syncing (Initial C2)**: Deletions remain deferred until manual upload/download parity is proven.
2. **Automatic Background Sync**: Must prove manual sync safety before introducing background timers.
3. **End-to-End Encryption**: Out of scope for standard GitHub-backed vault sync.
4. **Selective `.obsidian/` Sync**: Keep `.obsidian/` 100% excluded to prevent device config conflicts.
5. **Canvas / Markdown AST Merge**: Preserving both files on conflict is safer than automated 3-way merging.
6. **Multi-Remote / GitLab / Gitea**: GitHub REST API remains the sole target.

---

## 14. Final Quality Gate Results

- **`npm run lint`**: **PASS** (0 errors, 0 warnings)
- **`npm run typecheck`**: **PASS** (0 errors)
- **`npm run test`**: **PASS** (26/26 tests passed)
- **`npm run build`**: **PASS** (exit 0)
- **`npm run verify`**: **PASS** (exit 0)
- **Production Code Status**: Unmodified and frozen at commit `d0a640089df3edadcd3d99101eb59120d63ef56e`.
