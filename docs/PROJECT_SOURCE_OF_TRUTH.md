# GitHub Vault Relay: Project Source of Truth

> **Canonical reference document for repository architecture, factual technical guarantees, portfolio narratives, and engineering verification.**  
> **Repository:** [https://github.com/ankhang0704/github-vault-relay](https://github.com/ankhang0704/github-vault-relay)  
> **Current Version:** `0.6.0` (Release Candidate)  
> **Status:** AUTOMATED GATES PASS | VERIFIED | REAL-DEVICE ACCEPTANCE PENDING  

---

## 1. Project Identity
- **Name:** GitHub Vault Relay (`github-vault-relay`)
- **Category:** Obsidian Community Plugin (Sync & Version Control Bridge)
- **Tagline:** A conservative, mobile-first GitHub sync bridge for Obsidian — without running Git on the phone.
- **Maintainer:** ankhang0704 (Vault Relay Contributors)
- **License:** MIT License

---

## 2. Real Problem
- Obsidian users who manage their Markdown vaults via GitHub repositories face a severe limitation on mobile devices (iOS / iPadOS / Android).
- Mobile operating systems run applications inside strict security sandboxes:
  1. No native command-line Git binary exists.
  2. Spawning child processes (`child_process`) is forbidden.
  3. Running heavy JavaScript Git emulators (e.g. `isomorphic-git`) incurs severe memory footprints, fragile packfile re-encoding, and high risk of mobile OS termination (iOS Jetsam memory kills).
- Existing alternatives either require running third-party synchronization cloud servers, paying proprietary sync subscriptions, or risking silent corruption when external native Git clients interact with the vault.

---

## 3. Goals
- Connect Obsidian vaults directly to a central GitHub repository over HTTPS using Obsidian's native `requestUrl()` API.
- Provide a clean, unified sync action (`[ Sync ]`) that coordinates remote pulls and local pushes safely.
- Guarantee strict data integrity: stop and preserve both versions rather than guessing or silently overwriting notes.
- Maintain seamless co-existence with external native Git workflows on desktop (CLI, Obsidian Git, GUI clients).
- Keep all internal sync metadata and conflict payloads completely hidden from user note graphs and search.

---

## 4. Non-Goals (Strict Feature Freeze)
The following are deliberate product non-goals:
- **No background auto-sync / scheduled sync:** Sync only executes when explicitly triggered by the user.
- **No sync-on-save:** Prevents battery exhaustion, race conditions, and excessive commit noise.
- **No ambiguous / unverified deletion:** Deletion is never inferred without previous baseline synchronized existence evidence. Missing baseline cannot infer deletion (treated conservatively as local-only or remote-only).
- **No empty directory synchronization:** Git tracks file paths, not empty directory nodes.
- **No fuzzy / AI rename guessing:** Moves are recognized strictly when content SHA is byte-identical or handled safely as independent delete + add.
- **No force push:** `force: false` is strictly enforced on all branch ref updates.
- **No third-party Git hosts:** Exclusively GitHub REST and Git Data APIs (no GitLab, Gitea, or WebDAV).
- **No Canvas 3-way merge:** Canvas files are treated as atomic units.
- **No `.obsidian/` configuration sync:** Excluded by default (`.obsidian/`, `.git/`, `_fit/`).
- **No attachment importer tool:** Binary attachments sync byte-exact, but no import wizard is bundled.
- **No multi-account switching:** Single account and repository configuration per vault.

---

## 5. Current Status & Baseline
- **C1 Foundation:** VERIFIED (Inventory scanning & 6-state classification)
- **C2 Safe Pull:** VERIFIED (Blob download, SHA verification, LF normalization, SecretStorage)
- **C3 Safe Push:** VERIFIED (Git Data API tree/commit/ref construction, optimistic concurrency)
- **C4 Unified Sync & Conflict Resolution:** VERIFIED (Unified single-click sync, Connection Wizard, 3-way conflict review, canonical internal storage)
- **C5 Production Hardening:** AUTOMATED PASS (Mutation coordinator, crash rollback, upgrade matrix, failure injection, scale benchmarks, mobile accessibility)
- **C6 Safe Delete & Move Semantics:** AUTOMATED PASS (Three-way deletion classifier, Git Data API tree omissions, ordered pull moves, crash recovery journaling, delete conflicts, 27 C6 tests)
- **Current Published Release:** `0.6.0` Pre-release (Release Candidate)
- **Real Windows Acceptance:** `NOT RUN` (Pending)
- **Real iPhone Acceptance:** `NOT RUN` (Pending via BRAT)
- **MVP Complete:** `NO` (Awaiting real-device validation)
- **1.0.0 Ready:** `NO` (Final acceptance on real devices required)

---

## 6. Supported Platforms
- **Obsidian Mobile:** iOS (iPhone / iPad), Android (Obsidian v0.15.0+).
- **Obsidian Desktop:** Windows 10/11, macOS, Linux.

---

## 7. Architecture Summary
Vault Relay operates as an asymmetric HTTPS bridge:

```
+-------------------------------------------------------------+
|                     GitHub Repository                       |
|         (Central Remote Repository / Source of Truth)       |
+-------------------------------------------------------------+
               ^                               ^
               | Native Git CLI/GUI            | HTTPS REST & Git Data API
               | (clone / commit / push)       | (Blobs, Trees, Commits, Refs)
               v                               v
+------------------------------+  +---------------------------+
|      Obsidian Desktop        |  |      Obsidian Mobile      |
|                              |  |    (iOS / Android)        |
| • Native Git or Vault Relay  |  | • Zero native Git binary  |
| • Full desktop environment   |  | • Obsidian requestUrl()   |
| • Mutual Git co-existence    |  | • Unified Safe Sync       |
+------------------------------+  +---------------------------+
```

---

## 8. Sync Model & 6-State Classifier
Vault Relay compares local vault files against remote Git tree blobs and the last durable `state.json` baseline:

| State Category | Local State | Remote State | Baseline Comparison | Automated Action |
| :--- | :--- | :--- | :--- | :--- |
| **`LOCAL_ONLY`** | Exists | Missing | New note created locally | Eligible for Safe Push (`PUSH_CREATE`) |
| **`REMOTE_ONLY`** | Missing | Exists | New note created on remote | Eligible for Safe Pull (`PULL_CREATE`) |
| **`LOCAL_CHANGED`** | Modified | Unchanged | Local note modified since last sync | Eligible for Safe Push (`PUSH_UPDATE`) |
| **`REMOTE_CHANGED`** | Unchanged | Modified | Remote note updated on GitHub | Eligible for Safe Pull (`PULL_UPDATE`) |
| **`POTENTIAL_CONFLICT`** | Modified | Modified | Both sides modified independently | Blocked from sync; preserved for manual review |
| **`UNCHANGED`** | Identical | Identical | Hashes match baseline and each other | No-op |

---

## 9. Safe Pull Engine
- Fetches remote Git tree and identifies `REMOTE_ONLY` and `REMOTE_CHANGED` entries.
- Downloads blobs via `GET /git/blobs/{sha}`.
- Cryptographically validates the downloaded bytes against expected Git SHA-1.
- Prepares content: canonicalizes text (`.md`, `.txt`, `.canvas`) to LF (`\n`); streams binary files byte-exact.
- Records pre-write intentions in a journal file (`.obsidian/github-vault-relay/pull-recovery/`).
- Writes to local vault and verifies written bytes.
- Updates baseline in `state.json` and deletes recovery journal.

---

## 10. Safe Push Engine
- Identifies `LOCAL_ONLY` and `LOCAL_CHANGED` entries.
- Uploads raw note bytes to `POST /git/blobs`.
- Builds a new Git tree on top of the remote base tree using `POST /git/trees`.
- Creates a single Git commit referencing the parent commit using `POST /git/commits`.
- Re-reads local files from disk immediately before moving the branch ref to ensure local files were not edited during network transmission.
- Updates branch ref via `PATCH /git/refs/heads/{branch}` with `force: false`.
- Performs authoritative post-write verification using an independent `GET` request.
- Advances local `state.json` baseline only after authoritative remote verification succeeds.

---

## 11. Unified Sync Engine
- Single-click action combining Pull and Push:
  1. **Phase 1 (Scan):** Complete inventory classification.
  2. **Phase 2 (Pull):** Pulls safe remote changes if present.
  3. **Phase 3 (Re-scan):** Fresh scan to incorporate pulled notes and detect newly created local changes.
  4. **Phase 4 (Push):** Pushes eligible local changes in a single atomic Git commit.
  5. **Phase 5 (Convergence):** Final scan confirming synchronization status.
- **Important Semantic Invariant:** Unified Sync is intentionally **not** an end-to-end all-or-nothing rollback transaction. If Safe Pull succeeds and Safe Push subsequently fails, successfully pulled notes are retained.

---

## 12. Conflict Model
When both local and remote notes have changed independently, Vault Relay never silently overwrites either version:
- **Keep Local:** Performs an authorized scoped push of the reviewed local file to GitHub after revalidating that remote HEAD has not changed again.
- **Use Remote:** Overwrites the local note with the reviewed remote version after revalidating that local content has not changed again.
- **Keep Both:** Leaves the local note intact and saves the remote version alongside it as `filename (remote conflict YYYY-MM-DD_HHmm).ext`. Updates baseline state for both records independently.

---

## 13. GitHub API Model
- Uses Obsidian's runtime `requestUrl()` API to bypass CORS restrictions.
- REST Endpoints: `/user/repos` (discovery), `/repos/{owner}/{repo}/branches/{branch}` (ref check).
- Git Data API Endpoints: `/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`.
- **Zero DELETE / Zero PUT contents:** Guaranteed 0 occurrences in codebase.
- **Mutation Safety:** Automatic retry is strictly limited to idempotent `GET` requests (max 3). Non-idempotent mutations (`POST`, `PATCH`) fail closed immediately.
- **Rate Limit Handling:** HTTP 429 parses `Retry-After` (capped to max 10s backoff).

---

## 14. Storage Model
All internal plugin state is stored in the hidden configuration directory:
```
.obsidian/github-vault-relay/
├── state.json                  # Tracked commit SHA and per-file baseline hashes
├── conflicts_meta.json         # Active conflict metadata registry
├── conflicts/                  # Isolated conflict blob payloads
└── pull-recovery/              # Interrupted write recovery journals
```
- Atomic storage replaces `state.json` via `.tmp` staging and `.bak` fallbacks.
- User content residing in any root `_vault-relay/` directory is treated as standard user notes and never touched or deleted by the plugin.

---

## 15. Secret Model
- Canonical Key: `github-vault-relay-pat`.
- Storage: Obsidian `SecretStorage` exclusively.
- Plaintext persistence in `data.json` or `localStorage` is prohibited and verified by automated AST scans.
- Sanitization: All errors and logs pass through `redactTokens()` masking token signatures.

---

## 16. Failure & Recovery Model
- **Offline Failure:** Operations abort cleanly with zero file or state mutations.
- **Interrupted Pull Recovery:** Interrupted writes are detected on plugin startup and rolled back to known baselines.
- **Interrupted State Save:** Corrupted or partial state saves automatically restore the `.bak` backup.
- **Lost PATCH Ref Response:** Engine performs independent authoritative GET check on branch ref before declaring failure or advancing baseline.

---

## 17. Concurrency Model
- `MutationCoordinator` implements an in-memory lease lock keyed by the Obsidian `App` instance.
- Prevents concurrent executions among Safe Pull, Safe Push, Unified Sync, and Conflict Resolution.
- ConflictManager locks individual file paths during active resolution.

---

## 18. Migration Model
Tested across 12 upgrade paths (`tests/c5UpgradeMigration.test.ts`):
- Clean install -> Fresh state.
- Legacy C2/C3 (`_vault-relay/state.json`) -> Canonical storage.
- Intermediate C4 (`.obsidian/vault-relay/`) -> Canonical storage.
- Legacy PAT keys (`vault-relay-pat`, `vault-relay:pat`) -> Canonical `SecretStorage`.
- All legacy source files are kept until destination records are verified byte-for-byte on disk.

---

## 19. Test & CI Evidence
- **Total Test Suites:** 37 test files.
- **Total Passing Tests:** 359 tests (0 skipped, 0 failing).
- **Linters:** ESLint (0 errors, 0 warnings with `--max-warnings 0`).
- **Typechecker:** TypeScript `tsc --noEmit` (0 errors).
- **CI Matrix:** GitHub Actions running on Node 20.x and Node 22.x (Run ID `33892492722` - GREEN).
- **Production Bundle:** `main.js` (130,200 bytes, SHA-256: `0CB10C17459EF22826CA9E1134D479CF66DF66D759CE9914C4BC922BD58A64FD`).

---

## 20. Verified Metrics (Lab / Network-Independent)
*Evaluated with mock GitHub client on mixed-type vaults (.md, .txt, .canvas, PNG, JPG, PDF, bin):*
- 100 files: Classification < 5 ms, Preview ~24 ms, Unified Sync planning < 25 ms.
- 500 files: Classification < 15 ms, Preview ~37 ms, Unified Sync planning < 40 ms.
- 1,000 files: Classification < 30 ms, Preview ~64 ms, Unified Sync planning < 65 ms.
- Batch Push (10, 50, 100 files): Single Git commit, single ref update per batch.

---

## 21. Real-Device Evidence
- **C4 Desktop & iPhone Core:** VERIFIED in prior checkpoint runs.
- **C5 Real Windows Acceptance:** `NOT RUN` (Protocol defined in `docs/MANUAL_TEST_MATRIX.md`).
- **C5 Real iPhone Acceptance:** `NOT RUN` (Protocol defined in `docs/MANUAL_TEST_MATRIX.md`).

---

## 22. Known Limitations
- Standard GitHub authenticated API rate limits apply (typically 5,000 req/hr).
- Repositories returning truncated Git trees (>100,000 files) are blocked for safety.
- Single repository and branch configuration per vault.
- Cellular/Wi-Fi latency dominates real-world sync speed compared to in-memory benchmarks.

---

## 23. Timeline
- **2026-09-01:** C1 Foundation Bootstrap (Scanner & 6-state classifier).
- **2026-09-01 → 09-02:** C2 Conservative Safe Pull (Cryptographic blob verification, LF canonicalization, SecretStorage).
- **2026-09-02:** C3 Conservative Safe Push (Git Data API, optimistic concurrency `force: false`, ref verification).
- **2026-09-03 → 09-04:** C4 Unified Sync & Conflict Resolution (Single-action sync, Connection Wizard, 3-way conflict review, canonical internal storage).
- **2026-09-04:** C5 Production Hardening (Mutation lease, fail-closed mutations, pull rollback journal, 12-scenario migration matrix, 359 tests, 0.5.0 RC prerelease).

---

## 24. AI-Assisted Development Methodology
GitHub Vault Relay was developed using a disciplined human-in-the-loop, AI-assisted engineering methodology:

### Maintainer-Owned Responsibilities
- System purpose, problem definition, and product scope.
- Invariant definition (zero force push, deferred deletions, SecretStorage only, 25 MiB ceiling).
- Architecture and security threat boundary decisions.
- Real-device manual acceptance testing on Windows and iOS devices.
- Release candidate authorization and publishing decisions.

### AI-Assisted Implementation Responsibilities
- Code synthesis conforming to strict architectural constraints.
- Exhaustive test harness generation (359 unit and failure-injection tests).
- Automated static security auditing and AST property verification.
- Refactoring and regression remediation under quality gate constraints.

---

## 25. Canonical Portfolio Reference Tables

### SAFE PORTFOLIO CLAIMS
| Claim | Factual Evidence Base |
| :--- | :--- |
| **Mobile-First Git Sync Bridge without Native Git** | Communicates exclusively via HTTPS using Obsidian's `requestUrl()` API and GitHub Git Data API. |
| **Optimistic Concurrency & History Protection** | All branch updates pass `force: false`. Remote HEAD revalidated before mutation. |
| **Single-Commit Batching** | Each Safe Push batch commits all eligible note changes in a single atomic Git commit. |
| **Deterministic Conflict Preservation** | Notes modified independently on both sides are flagged as conflicts and preserved until user resolution. |
| **100% SecretStorage Credential Protection** | PAT stored strictly in device `SecretStorage`. Zero plaintext in `data.json` or `localStorage`. |
| **Crash Recovery & Rollback Engine** | Startup recovery rolls back unverified pull writes using recovery journals; atomic `.bak` fallback. |
| **Strict Automated Verification** | 359 tests across 37 suites, 0 ESLint warnings, 0 type errors, Node 20 & 22 green CI. |

---

### DO NOT CLAIM / NOT YET VERIFIED
| Unsupported Claim | Reason | Factually Accurate Position |
| :--- | :--- | :--- |
| *"Production 1.0.0 Stable Release"* | C5 real-device acceptance is still pending. | Currently at version `0.5.0` Release Candidate. |
| *"Verified on real iPhones in C5"* | C5 automated tests are green, but real iOS device test is `NOT RUN`. | Automated C5 hardening complete; real device acceptance pending. |
| *"Absolute Zero Data Loss Guarantee"* | External Git force-pushes or host malware can cause loss outside plugin control. | Halts safely and preserves both versions when state is ambiguous. |
| *"Sub-10ms synchronization on all devices"* | 10ms was an in-memory mock classification benchmark. Real network latency is higher. | Bounded hash caching minimizes local file hashing. |
| *"End-to-end two-phase transaction"* | Pull and Push are distinct sequential phases; successful Pull is kept if Push fails. | Unified sync combines Safe Pull, Re-plan, and Safe Push into one user action. |
