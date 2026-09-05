# Changelog

All notable changes to GitHub Vault Relay will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.6.1] - 2026-09-05 (Pre-release)

### Added
- **Windows Production Acceptance Verified**: Completed rigorous Hard Mode acceptance across 5 sequential batches (100 local-to-remote bulk push, 100 remote-to-local bulk pull, 11 concurrent mixed conflict scenarios, binary real-world multi-format tests, and double-sync/offline/restart reliability).
- **Fast-forward Commit SHA for Sequential Conflict Resolution**: Automatic fast-forward of in-flight conflict records when preceding conflict resolutions advance the remote branch, preventing false staleness blocks during multi-conflict sessions.
- **Compact Semantic Dashboard**: Default dashboard UX simplification consolidating 8 metric cards into compact, truthful semantic cards (Changes, Moves, Conflicts, Destructive banner) with zero-state clean view.

### Changed
- **File-level Remote Revalidation**: `revalidateRemoteRecord` validates the exact Git tree blob SHA for the targeted path, preventing spurious resolution aborts caused by unrelated commits on the branch.

## [0.6.0] - 2026-09-05 (Release Candidate)

### Added
- **Safe Delete & Move Synchronization (C6)**: Complete 3-way filesystem lifecycle support (CREATE, EDIT, MOVE/RENAME, DELETE) across Windows, GitHub, and iPhone.
- **Three-Way Deletion Classifier**: Added explicit engine states for `LOCAL_DELETED`, `REMOTE_DELETED`, `DELETE_CONFLICT`, and `DELETED` (converged baseline pruning).
- **Git Data API Deletion**: Clean tree omissions constructed via `POST /git/trees` with `sha: null` against `base_tree`, strictly avoiding HTTP `DELETE` endpoints and `force: true`.
- **Durable Local Delete Recovery**: Pre-delete snapshot journaling in `.obsidian/github-vault-relay/delete-recovery/` with automatic startup restoration if interrupted mid-operation.
- **Ordered Pull Moves**: Guaranteed destination file materialization and byte-exact verification before local source deletion.
- **Single-Commit Move Batching**: Local moves batch `delete old_path` and `add new_path` into a single atomic Git commit.
- **Exact-SHA Move Detection**: Content-addressed pairing of deleted baseline files with newly added local files in UI preview.
- **Contextual Delete Conflict Resolution**: Unambiguous UI actions (`[ Keep File ]`, `[ Delete File ]`, `[ Cancel ]`) with strict revalidation before any remote or local mutation.
- **Comprehensive C6 Test Suite**: 27 automated tests covering deletion, move ordering, directory moves, binary moves/deletes, crash recovery, and security invariants (totaling 404 tests across 39 suites).

### Changed
- **Dashboard & Preview Metrics**: Added Local Deletions, Remote Deletions, and Delete Conflicts counters with distinct badge indicators and filter tabs.
- **PullEngine Deletion Handling**: Explicit deletion phase executed without downloading nonexistent remote blobs.
- **PushEngine Pre-Ref Invariant**: Added verification ensuring deleted files are not recreated locally in-flight before updating branch ref.

---

## [0.5.0] - 2026-09-04 (Release Candidate)

### Added
- **Mutation Lease Locking (`MutationCoordinator`)**: Application-level mutex preventing concurrent executions of Safe Pull, Safe Push, Unified Sync, and Conflict Resolution within an Obsidian instance.
- **Crash Recovery & Rollback Engine**: Journaled pre-write tracking in `pull-recovery/` with automatic startup rollback of interrupted writes.
- **Atomic Storage Fallback**: Atomic state replacement utilizing `.tmp` staging and `.bak` recovery fallbacks.
- **Mobile Responsive Shell (`styles.css`)**: Enforced 44px touch targets on buttons, word wrapping (`overflow-wrap: anywhere`), safe-area insets, and mobile layout constraints.
- **Hardened Test Suite**: Added comprehensive failure injection, concurrency race, scale, and AST security suites, bringing total test coverage to 359 tests across 37 suites.

### Changed
- **Fail-Closed Git Mutations**: Automatic HTTP retries restricted strictly to idempotent `GET` requests; non-idempotent mutations (`POST`, `PATCH`) fail closed immediately on connection loss.
- **Authoritative Ref Query on Lost Response**: When a `PATCH ref` response is ambiguous or lost, PushEngine queries the authoritative ref via an independent `GET` request before deciding status.
- **Cleaned Conflict Baseline Semantics**: "Keep Both" now tracks distinct local and remote SHAs independently to prevent remote desynchronization.
- **Durable Storage Migration**: Migration preserves all source legacy files until canonical destination files are verified byte-for-byte on disk.

---

## [0.4.1] - 2026-09-04

### Changed
- **Clear Token Placement**: Moved Clear Token action to Advanced / Security section with destructive styling.
- **Clear Token Confirmation**: Added mandatory two-step confirmation modal (`ClearTokenConfirmModal`) before credentials can be purged.
- **Mobile Touch Enhancements**: Initial pass on 44px minimum button dimensions for mobile settings.

---

## [0.4.0] - 2026-09-04

### Added
- **Unified Safe Sync (`[ Sync ]`)**: Single-click action combining pre-scan, Safe Pull, re-scan, Safe Push, and convergence verification.
- **GitHub Connection Wizard**: Automated repository discovery (`/user/repos`) and branch dropdown selection.
- **Truthful Progress Model**: Real-time discrete phase emission (`PLANNING`, `DOWNLOADING`, `UPLOADING`, `CREATING_COMMIT`, `UPDATING_REF`, `VERIFYING`) and exact file counters ($x/y$).
- **Conflict Resolution UI**: Interactive card-based review offering Keep Local, Use Remote, and Keep Both.
- **Authorized Scoped Push**: Implemented reviewed scoped push for Keep Local conflict resolution.
- **Canonical Internal Storage**: Standardized all plugin metadata and payloads under `.obsidian/github-vault-relay/`.
- **Orphan Conflict Garbage Collection**: Startup reconciliation and cleanup of unreferenced conflict payload files.

### Changed
- **Scope Discipline**: Removed experimental attachment importer tool to maintain focus strictly on core note synchronization.
- **Root `_vault-relay/` Protection**: Removed plugin ownership of root `_vault-relay/` to treat user notes inside it as normal user content.

---

## [0.3.0] - 2026-09-03

### Added
- **Conservative Safe Push Engine**: Remote Git object construction using Git Data API (`/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`).
- **Single-Commit Batching**: All eligible local changes assembled into a single atomic Git commit per push operation.
- **Optimistic Concurrency**: Branch ref updates strictly enforce `force: false`.
- **Authoritative Ref Verification**: Independent ref verification with bounded retry budget to account for GitHub edge replication latency.
- **Cache-Bypass Headers**: Authoritative GET queries include `Cache-Control: no-cache` to bypass iOS WebKit HTTP caches.

---

## [0.2.0] - 2026-09-02

### Added
- **Conservative Safe Pull Engine**: Remote Git tree download and raw Git blob fetching.
- **Cryptographic Blob Integrity**: Verification of raw blob SHA-1 hashes before writing to local vault.
- **Content Normalization**: In-memory LF (`\n`) normalization for Markdown and text files; byte-exact streaming for binaries.
- **SecretStorage Integration**: Personal Access Token persistence using Obsidian's secure `SecretStorage` API.
- **6-State Sync Classifier**: Categorization into `LOCAL_ONLY`, `REMOTE_ONLY`, `LOCAL_CHANGED`, `REMOTE_CHANGED`, `POTENTIAL_CONFLICT`, and `UNCHANGED`.
