# Checkpoint 4 (C4) Pre-Runtime Hardening & Safety Freeze Document

**Audit Date**: September 3, 2026  
**Repository**: [ankhang0704/github-vault-relay](https://github.com/ankhang0704/github-vault-relay)  
**Status**: **PRE-RUNTIME HARDENING PASS** | **SAFETY FREEZE PASS** | **149/149 TESTS GREEN** | **REAL DESKTOP & IPHONE PENDING**

---

## 1. Executive Summary

Checkpoint 4 elevates GitHub Vault Relay from isolated Safe Pull and Safe Push operations into a **Unified Safe Sync** mobile-first product for Obsidian users across Windows and physical iPhone.

This document records the results of the pre-runtime safety audit and hardening pass. All identified P1 edge cases (BRAT update storage wipe risk, LocalHashCache false synchronization risk, un-paginated repository discovery, and state-critical read inconsistencies) have been resolved with regression test coverage.

### Current Checkpoint Status
- **C1 (Read-Only Preview & Scanning)**: `VERIFIED`
- **C2 (Safe Pull — GitHub → Obsidian)**: `VERIFIED` (Desktop & iPhone Acceptance Passed)
- **C3 (Safe Push — Obsidian → GitHub)**: `VERIFIED` (Desktop & iPhone Acceptance Passed on 0.3.0)
- **C4 (Unified Sync & Mobile Productization)**: `PRE-RUNTIME SAFETY FREEZE PASS` (Automated 149/149 Tests Green; Real Device Testing Pending)

---

## 2. State-Critical Read Policy & Endpoint Audit

| Context | Exact HTTP Endpoint | Headers / Options | Semantics & Rationale |
| :--- | :--- | :--- | :--- |
| **Preview HEAD** | `GET /repos/{owner}/{repo}/branches/{branch}?t=${Date.now()}` | `Cache-Control: no-cache, no-store, must-revalidate`, `Pragma: no-cache` | High-level branch endpoint returning commit SHA and tree SHA in 1 roundtrip. Cache-busted via unique timestamp and headers to prevent iOS WebKit cache reuse. (*Implemented fix; real iPhone verification pending*). |
| **Push Verification HEAD** | `GET /repos/{owner}/{repo}/git/ref/heads/{branch}?t=${Date.now()}` | `Cache-Control: no-cache, no-store, must-revalidate`, `Pragma: no-cache` | Authoritative low-level Git ref read immediately following a `PATCH` ref update. Fallback: `getBranch(branch, true)`. |
| **Unified Sync (Pre-Pull & Replan)** | `GET /repos/{owner}/{repo}/branches/{branch}?t=${Date.now()}` | `Cache-Control: no-cache, no-store, must-revalidate`, `Pragma: no-cache` | Fresh, cache-busted preflight read for initial planning, post-pull replanning, and post-push final convergence. |
| **Conflict Revalidation** | `GET /repos/{owner}/{repo}/branches/{branch}?t=${Date.now()}` | `Cache-Control: no-cache, no-store, must-revalidate`, `Pragma: no-cache` | Verifies remote branch HEAD has not advanced ahead of the reviewed commit before allowing `resolveKeepLocal`. |

---

## 3. LocalHashCache Safety Invariant Audit

- **Question**: Can file bytes change while `mtime` and `size` remain identical?
- **Answer**: **YES**. Fast consecutive edits within filesystem timestamp granularity (e.g. 1-second resolution), character swaps/replacements of equal byte length (e.g. "TODO" vs "DONE"), or scripts touching files can alter content without altering size or apparent `mtime`.
- **Enforced Correctness Invariant**:
  - `PushEngine` **NEVER** uses `LocalHashCache`. It always reads raw bytes from disk and hashes them immediately prior to upload.
  - `UnifiedSyncEngine` explicitly calls `generatePreview(true)` (`bypassLocalCache = true`), guaranteeing that pre-sync, replan, and post-sync convergence checks compute fresh hashes directly from disk.
  - `SyncEngine` hooks into Obsidian vault events (`modify`, `delete`, `rename`) to immediately evict cached records when a file is touched in the editor.
  - Regression verified by `FRESH-007`: same path, same size, same mtime, different bytes correctly detects `LOCAL_CHANGED` under cache bypass.

---

## 4. Internal Storage Architecture & BRAT Update Safety

- **Identified Hazard**: Storing `state.json` and `conflicts/` under `${app.vault.configDir}/plugins/github-vault-relay/` exposed data to deletion when BRAT or Obsidian plugin manager reinstalls or updates plugins.
- **Architectural Solution**:
  - Permanent internal path moved to: **`${app.vault.configDir}/vault-relay/`**
    - State: `${configDir}/vault-relay/state.json`
    - Conflicts: `${configDir}/vault-relay/conflicts/`
    - Metadata: `${configDir}/vault-relay/conflicts_meta.json`
  - Completely outside the plugin release directory (`plugins/github-vault-relay`), making it 100% immune to plugin updates or re-installations.
  - Completely hidden from user-facing vault notes (inside `.obsidian/`).
- **Byte-Exact Migration Verification**:
  - `StorageManager.migrateLegacyStorage()` checks both legacy root `_vault-relay/` and intermediate plugin dir `plugins/github-vault-relay/state.json`.
  - Migrates binary and text conflict payloads with byte-exact verification (length and content comparison).
  - Legacy source folder is removed **ONLY** after 100% verified copy. If verification fails, legacy data remains untouched.

---

## 5. End-to-End Performance Truthfulness

On a representative 30-file fixture (`FRESH-005`, `FRESH-008`):

| Component | Measured Scope | Timing (Local / Mock) | Expected Real Mobile (Network) |
| :--- | :--- | :--- | :--- |
| **Local File Inventory** | Reading vault file list | <1 ms | 1–5 ms |
| **Local Hashing (Warm)** | Cache lookup via `LocalHashCache` | <1 ms | 1–5 ms |
| **Local Hashing (Cold / Bypass)** | Reading & hashing 30 notes | 2–5 ms | 10–30 ms |
| **Remote HEAD Request** | `getBranch(branch, true)` HTTP GET | Network dependent | 100–300 ms |
| **Remote Tree Request** | `getTreeRecursive(treeSha)` HTTP GET | Network dependent | 150–400 ms |
| **State Classification** | 6-state diff algorithm | <1 ms | 1–5 ms |
| **Total Preview Duration** | End-to-end `generatePreview()` | Network dependent | **250–700 ms** |

*Note: The "<5ms" metric refers strictly to local vault inventory and classification with warm cache. Total preview time is dominated by remote network roundtrips.*

---

## 6. Comprehensive Requirement Test Matrix (149 Tests across 19 Suites)

### 6.1 Unified Safe Sync Engine (`tests/unifiedSyncEngine.test.ts`)
| Requirement ID | Test Description | Status |
| :--- | :--- | :--- |
| **SYNC-001** | Pull-only scenario runs Pull, skips Push, updates baseline | **PASS** |
| **SYNC-002** | Push-only scenario skips Pull, executes Safe Push (1 commit), updates baseline | **PASS** |
| **SYNC-003** | Both Pull and Push executed in single unified sync (1 pulled, 1 pushed) | **PASS** |
| **SYNC-004** | Up-to-date repository returns PASS with 0 pulled and 0 pushed | **PASS** |
| **SYNC-005** | Pull failure immediately halts sync and skips Push phase | **PASS** |
| **SYNC-006** | Remote HEAD changed during replan blocks Push | **PASS** |
| **SYNC-007** | Potential conflict preserves local file untouched and finishes with warning | **PASS** |
| **SYNC-008** | Concurrency lock prevents overlapping duplicate sync executions | **PASS** |
| **SYNC-009** | Progress callback receives events spanning SCANNING, PLANNING, COMPLETE | **PASS** |
| **SYNC-010** | Rejected concurrent sync leaves lock clean after active sync finishes | **PASS** |

### 6.2 Connection Wizard & Repo Discovery (`tests/connectionWizard.test.ts`)
| Requirement ID | Test Description | Status |
| :--- | :--- | :--- |
| **CONN-001** | listUserRepositories discovers repositories with privacy and default branches | **PASS** |
| **CONN-002** | listBranches lists all branches for a given repository | **PASS** |
| **CONN-003** | Allows /user/repos queries even when owner and repo are blank | **PASS** |
| **CONN-004** | testConnection validates permissions and default branch | **PASS** |
| **CONN-005** | Token error / missing PAT throws human-readable message with token redacted | **PASS** |
| **CONN-006** | listUserRepositories paginates automatically beyond 100 repositories | **PASS** |
| **CONN-007** | listBranches paginates automatically beyond 100 branches | **PASS** |
| **CONN-008** | Offline detection aborts wizard actions safely without unhandled error | **PASS** |
| **CONN-009** | Missing Contents permission on testConnection provides actionable advice | **PASS** |

### 6.3 Operation Progress Model (`tests/progressModel.test.ts`)
| Requirement ID | Test Description | Status |
| :--- | :--- | :--- |
| **PROGRESS-001** | Safe Pull emits PLANNING, DOWNLOADING with file counts, UPDATING_STATE, COMPLETE | **PASS** |
| **PROGRESS-002** | Safe Push emits PLANNING, UPLOADING, CREATING_TREE, CREATING_COMMIT, UPDATING_REF, COMPLETE | **PASS** |
| **PROGRESS-003** | Unified Sync emits continuous progress events spanning Pull and Push | **PASS** |
| **PROGRESS-004** | Failed operation emits failure progress and retains exact failing phase | **PASS** |
| **PROGRESS-005** | Phase labels are descriptive and human-readable | **PASS** |
| **PROGRESS-006** | Progress file count completed is monotonic during downloads and uploads | **PASS** |

### 6.4 Preview Freshness & Performance (`tests/previewFreshness.test.ts`)
| Requirement ID | Test Description | Status |
| :--- | :--- | :--- |
| **FRESH-001** | generatePreview requests branch with bypassCache=true, headers, and timestamp | **PASS** |
| **FRESH-002** | LocalHashCache reuses SHA when mtime and size match | **PASS** |
| **FRESH-003** | LocalHashCache invalidates when content changes | **PASS** |
| **FRESH-004** | clearLocalHashCache forces re-computation of local hashes | **PASS** |
| **FRESH-005** | Timings are instrumented truthfully on SyncPreviewReport | **PASS** |
| **FRESH-006** | Repeated preview invocations execute genuinely fresh HTTP requests with distinct timestamps | **PASS** |
| **FRESH-007** | Same size, same mtime, different bytes detects mutation under bypassCache | **PASS** |
| **FRESH-008** | End-to-end performance truth breakdown on 30-file fixture | **PASS** |

### 6.5 Conflict Resolution Engine (`tests/conflictResolution.test.ts`)
| Requirement ID | Test Description | Status |
| :--- | :--- | :--- |
| **CONFLICT-001** | recordConflict stores and persists conflict record | **PASS** |
| **CONFLICT-002** | resolveKeepLocal pushes local version when remote unchanged | **PASS** |
| **CONFLICT-003** | resolveKeepLocal aborts when remote HEAD changed since review | **PASS** |
| **CONFLICT-004** | resolveUseRemote overwrites local note when local SHA is unchanged | **PASS** |
| **CONFLICT-005** | resolveUseRemote aborts if local file changed concurrently | **PASS** |
| **CONFLICT-006** | resolveKeepBoth preserves local note untouched | **PASS** |
| **CONFLICT-007** | resolveKeepBoth creates remote conflict copy with timestamp suffix | **PASS** |
| **CONFLICT-008** | Binary conflict resolution preserves byte fidelity for images/PDFs | **PASS** |

### 6.6 StorageManager & Migration (`tests/storageManager.test.ts`)
| Requirement ID | Test Description | Status |
| :--- | :--- | :--- |
| **MIG-001** | Loads empty state when neither internal nor legacy exists | **PASS** |
| **MIG-002** | Saves and loads state from internal hidden storage | **PASS** |
| **MIG-003** | Legacy migration moves _vault-relay/state.json to internal storage | **PASS** |
| **MIG-004** | Legacy migration cleans up legacy directory only after verified copy | **PASS** |
| **MIG-005** | Migration is idempotent (subsequent runs do not fail or corrupt) | **PASS** |
| **MIG-006** | Migration preserves legacy conflict files into internal conflicts directory | **PASS** |
| **MIG-007** | Broken legacy state does not destroy legacy file | **PASS** |
| **MIG-008** | saveConflictPayload writes binary and string payloads to internal conflicts | **PASS** |
| **MIG-009** | Internal storage lives in .obsidian/vault-relay (safe against BRAT and plugin updates) | **PASS** |
| **MIG-010** | Migrates intermediate plugin-dir state to permanent .obsidian/vault-relay | **PASS** |
| **MIG-011** | Binary conflict migration verifies byte-exact equality | **PASS** |

### 6.7 Attachment Import Scope Decision (`tests/attachmentRemoval.test.ts`)

**Attachment Import = REMOVED FROM PRODUCT SCOPE**
- **Reason**: Content acquisition belongs to Obsidian / iOS / OS workflows (files app, camera roll, share sheet, Obsidian drag-and-drop). Vault Relay starts responsibility once content exists in the vault.
- **Core Binary Sync Preserved**: Existing binary files in the vault (images, PDFs, audio, etc.) continue to be classified and synchronized 100% byte-exact across Safe Pull, Safe Push, and Unified Sync.

| Requirement ID | Test Description | Status |
| :--- | :--- | :--- |
| **REMOVE-001** | No Import Attachment UI, commands, or buttons remain | **PASS** |
| **REMOVE-002** | No attachment-import production module remains | **PASS** |
| **REMOVE-003** | Existing binary file in vault still classifies correctly | **PASS** |
| **REMOVE-004** | Existing binary file still Safe/Unified Pushes correctly | **PASS** |
| **REMOVE-005** | Remote binary file still Pulls correctly | **PASS** |

---

## 7. Remote Write Surface Audit

Complete inventory of all mutating HTTP methods across the production codebase:

| Endpoint | Method | Payload / Arguments | Security Invariants Enforced |
| :--- | :--- | :--- | :--- |
| `/repos/{owner}/{repo}/git/blobs` | `POST` | `{ content: base64, encoding: "base64" }` | Size $<25	ext{ MiB}$, content byte-exact, raw SHA verified |
| `/repos/{owner}/{repo}/git/trees` | `POST` | `{ base_tree: baseSha, tree: treeItems }` | Preserves existing remote tree, path safety verified |
| `/repos/{owner}/{repo}/git/commits` | `POST` | `{ message, tree, parents: [baseCommitSha] }` | Atomic single commit, optimistic concurrency parentage |
| `/repos/{owner}/{repo}/git/refs/heads/{branch}` | `PATCH` | `{ sha: commitSha, force: false }` | **Strict `force: false` invariant**. Non-fast-forward rejected |

**Zero** `DELETE`, **Zero** `PUT`, **Zero** `force: true`.
