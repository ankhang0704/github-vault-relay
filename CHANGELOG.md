# Changelog

All notable changes to GitHub Vault Relay will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
