# Checkpoint 6 (C6): Safe Delete & Move Semantics

**Date:** 2026-09-05  
**Version:** 0.6.0  
**Phase:** C6 Final Feature Checkpoint (Safe Deletion & Move Semantics)  
**Status:** AUTOMATED GATES PASS | VERIFIED | READY FOR DEVICE ACCEPTANCE  

---

## 1. Executive Summary & Goals

Checkpoint 6 (C6) is the final feature checkpoint before stable 1.0.0. Its goal is to synchronize the full filesystem lifecycle:
- **CREATE**
- **EDIT**
- **MOVE / RENAME**
- **DELETE**

across Windows / Desktop, GitHub, and iPhone / Mobile without destructive guessing, without force push, and without native Git dependencies.

All operations respect the core safety philosophy of GitHub Vault Relay: **Data integrity and explicit failure over silent guessing or destructive automation.**

---

## 2. Core Three-Way Deletion Model

Deletion is never inferred simply from "file missing". It is strictly inferred from the relationship between **Baseline** (`state.json`), **Local Vault**, and **Remote GitHub**:

### Classification State Table

| Baseline (`state.json`) | Local Vault | Remote GitHub | Classification | Description & Action |
| :--- | :--- | :--- | :--- | :--- |
| Present (`SHA1`) | Absent | Present (`SHA1`) | `LOCAL_DELETED` | Local user deleted note while remote remained unchanged. Pushed via Git Data API tree omission (`sha: null`). Baseline pruned only after verified ref update. |
| Present (`SHA1`) | Present (`SHA1`) | Absent | `REMOTE_DELETED` | Remote note deleted by another device/Git actor. Pull creates recovery journal, removes local file via `app.vault.delete()`, verifies absence, prunes baseline, cleans journal. |
| Present (`SHA1`) | Absent | Absent | `DELETED` | Both sides deleted. No mutation required. Baseline entry pruned safely. |
| Present (`SHA1`) | Absent | Present (`SHA2`) | `DELETE_CONFLICT` | Local deleted vs remote modified. Halts safely. Never automatically deletes remote; never automatically restores local. |
| Present (`SHA1`) | Present (`SHA2`) | Absent | `DELETE_CONFLICT` | Remote deleted vs local modified. Halts safely. Never automatically deletes local; never automatically restores remote. |
| Absent | Present | Absent | `LOCAL_ONLY` | New local file. Never inferred as deletion. |
| Absent | Absent | Present | `REMOTE_ONLY` | New remote file. Never inferred as deletion. |
| Present (`SHA1`) | Present (`SHA1`) | Present (`SHA1`) | `UNCHANGED` | Clean converged state. |
| Present (`SHA1`) | Present (`SHA2`) | Present (`SHA1`) | `LOCAL_CHANGED` | Local modification to push. |
| Present (`SHA1`) | Present (`SHA1`) | Present (`SHA2`) | `REMOTE_CHANGED` | Remote modification to pull. |
| Present (`SHA1`) | Present (`SHA2`) | Present (`SHA3`) | `POTENTIAL_CONFLICT` | Three-way content modification conflict. |

---

## 3. Git Data API Remote Deletion Mechanics

Vault Relay strictly avoids GitHub HTTP `DELETE` endpoints and `PUT /contents`. Remote deletion is achieved natively via Git tree construction:

1. **Tree Construction**:
   In `POST /repos/{owner}/{repo}/git/trees` with `base_tree`:
   ```json
   {
     "base_tree": "<base_commit_tree_sha>",
     "tree": [
       {
         "path": "Note.md",
         "mode": "100644",
         "type": "blob",
         "sha": null
       }
     ]
   }
   ```
   Specifying `"sha": null` instructs GitHub's Git Data API to remove `Note.md` from the resulting Git tree.
2. **Atomic Single Commit**:
   All additions, modifications, and deletions in a push batch are combined into **one single Git commit**.
3. **Optimistic Ref Update**:
   `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` with `force: false`.
4. **Authoritative Verification**:
   Independent query of branch ref and tree confirms the path is omitted before removing it from local baseline.

---

## 4. Safe Pull Deletion & Crash Recovery

Local deletion is a destructive operation requiring durable crash recovery:

1. **Pre-Delete Recovery Journal**:
   Before deleting a local file, `StorageManager.beginDeleteRecovery()` writes the complete file content, path, and metadata to:
   `.obsidian/github-vault-relay/delete-recovery/{id}.json`
2. **Local Destruction**:
   File is deleted using Obsidian's standard `app.vault.delete(file)`.
3. **Absence Verification**:
   Vault Relay confirms the file no longer exists in `app.vault`.
4. **Baseline Pruning**:
   The file path is pruned from `state.files`.
5. **Recovery Journal Cleanup**:
   `StorageManager.completeDeleteRecovery(id)` removes the journal snapshot.
6. **Interruption Recovery**:
   On plugin startup, `StorageManager.recoverInterruptedDeletes(app)` scans for lingering journals and restores any deleted files whose sync lifecycle did not cleanly finish, guaranteeing zero silent data loss.

---

## 5. Move & Rename Semantics

1. **Git Primitive Representation**:
   In Git, a Move has no separate primitive; it is **`DELETE old_path` + `ADD new_path`**.
2. **Safe Push**:
   Local move `Projects/A.md -> Archive/A.md` is emitted as `delete Projects/A.md` and `add Archive/A.md` within a **single Git commit**.
3. **Safe Pull (Ordered Execution)**:
   When pulling a remote move, PullEngine enforces strict sequencing:
   - **Step 1:** Write destination file (`Archive/A.md`) and verify byte-exact disk integrity.
   - **Step 2:** Delete source file (`Projects/A.md`) only after destination write succeeds.
   - **Step 3:** Update baseline and clean recovery journals.
   If Step 1 fails, the source file remains untouched.
4. **Exact-SHA Pairing**:
   When a newly added local file shares the identical blob SHA with a deleted baseline file, the UI pairs them as a clean Move (`Projects/A.md → Archive/A.md`).
5. **Move vs Modify Conflict**:
   If a note is moved locally while modified remotely, source deletion becomes a `DELETE_CONFLICT`, preventing misleading partial moves until resolved.

---

## 6. Delete Conflict UX & Resolution

When a delete conflict occurs, the UI presents clear, contextual options:
- **`[ Keep File ]`**:
  - If deleted locally but modified remotely: downloads and restores remote file locally.
  - If deleted remotely but modified locally: pushes modified local file to remote.
  - Outcome: Both sides retain the file.
- **`[ Delete File ]`**:
  - Explicitly authorizes permanent deletion of the modified file with pre-flight revalidation.
- **`[ Cancel ]`**:
  - Aborts resolution; preserves local and remote states untouched.

---

## 7. Verification & Automated Test Suite

A dedicated test suite `tests/c6DeleteMove.test.ts` with 27 comprehensive tests was added.

### Test ID Matrix
- `C6-DEL-001`: Local delete / remote unchanged -> LOCAL_DELETED
- `C6-DEL-002`: Remote delete / local unchanged -> REMOTE_DELETED
- `C6-DEL-003`: Both deleted -> DELETED / CONVERGED_DELETED
- `C6-DEL-004`: Local delete vs remote modify -> DELETE_CONFLICT
- `C6-DEL-005`: Remote delete vs local modify -> DELETE_CONFLICT
- `C6-DEL-006`: No-baseline local-only is NOT deletion -> LOCAL_ONLY
- `C6-DEL-007`: No-baseline remote-only is NOT deletion -> REMOTE_ONLY
- `C6-DEL-008`: Verified remote deletion removes baseline
- `C6-DEL-009`: Verified local deletion removes baseline
- `C6-DEL-010`: Remote delete race blocks push
- `C6-DEL-011`: Local recreate race blocks deletion push
- `C6-DEL-012`: Delete recovery restores interrupted deletions on startup
- `C6-DEL-013`: Deletion cleanup leaves zero artifacts
- `C6-DEL-014`: Binary delete works byte-safely
- `C6-MOVE-001`: Clean local move (delete old + add new)
- `C6-MOVE-002`: Clean remote move
- `C6-MOVE-003`: Move represented by ONE Git commit
- `C6-MOVE-004`: Destination created before local source deletion
- `C6-MOVE-005`: Failed destination write preserves source
- `C6-MOVE-006`: Exact SHA move detection
- `C6-MOVE-007`: Edited move works safely as delete + add
- `C6-MOVE-008`: Move-vs-modify conflict prevents partial move
- `C6-MOVE-009`: Directory move with 10 files pushed in a single commit
- `C6-MOVE-010`: Unicode, nested paths, and emoji move
- `C6-MOVE-011`: Case collision safety
- `C6-MOVE-012`: Destination collision safety
- `C6-MOVE-013`: Binary move works byte-safely
- `C6-RECOVERY-001..002`: Crash recovery journal integrity & malformed tolerance
- `C6-STRESS-001`: 1,000 create -> sync -> delete -> converge cycles leave 0 artifacts
- `C6-SEC-001`: Zero HTTP DELETE or PUT /contents calls during deletion
- `C6-RACE-001`: MutationCoordinator blocks concurrent delete pushes

### Quality Gate Results
- `npm run lint`: PASS (0 warnings, 0 errors)
- `npm run typecheck`: PASS (0 errors)
- `npm run test`: PASS (39 test files, 404 tests passing)
- `npm run build`: PASS (`main.js` built)
- `npm run verify`: PASS (full pipeline clean)

---

## 8. Remaining Limitations & Non-Goals

1. **No Empty Directory Tracking**: Git does not track empty directory nodes. Empty folder moves are not synchronizable.
2. **Lost Baseline State**: If `state.json` is lost on a device, existing local files whose remote counterparts were deleted cannot safely be inferred as deleted. They are classified as `LOCAL_ONLY` to prevent unintended data loss.
3. **No Fuzzy / AI Rename Guessing**: If a moved file is also edited, it is treated conservatively as an independent delete and add.
4. **Single-Account Configuration**: Vault Relay supports a single GitHub repository per vault.

---

## 9. Real Device Acceptance Status

- **C5 Real Windows:** VERIFIED
- **C6 Real Windows:** `NOT RUN` (Acceptance protocol ready in `docs/MANUAL_TEST_MATRIX.md`)
- **C6 Real iPhone:** `NOT RUN` (Acceptance protocol ready in `docs/MANUAL_TEST_MATRIX.md`)
- **0.6.0 Pre-release:** READY
- **1.0.0 Ready:** `NO` (Deferred until real-device acceptance passes)
