# GitHub Vault Relay: System Architecture

This document describes the technical architecture, data flows, and concurrency invariants of GitHub Vault Relay.

---

## 1. System Context

```mermaid
flowchart TD
    subgraph ObsidianApp["Obsidian Application Environment"]
        User["User / Mobile Notes"] <--> Vault["Obsidian Vault (Filesystem)"]
        Vault <--> Relay["GitHub Vault Relay Plugin"]
        Relay <--> SecretStorage["Obsidian SecretStorage (Device Keychain)"]
    end

    subgraph GitHubRemote["GitHub Remote Cloud (api.github.com)"]
        GitDataAPI["GitHub Git Data API\n(Blobs, Trees, Commits, Refs)"]
        GitRepo["Git Repository (main branch)"]
        GitDataAPI <--> GitRepo
    end

    subgraph ExternalWriters["External Git Environment (Desktop/Web)"]
        NativeGit["Native Git CLI / GUI / Web Editor"] <--> GitRepo
    end

    Relay -->|"HTTPS REST & Git Data API<br>(Obsidian requestUrl)"| GitDataAPI
```

---

## 2. Component Architecture

```mermaid
flowchart TD
    subgraph UI["Presentation Layer (src/ui/)"]
        Dashboard["SyncDashboardModal"]
        Preview["SyncPreviewModal"]
        ConflictModal["ConflictResolutionModal"]
        TokenModal["ClearTokenConfirmModal"]
        SettingsTab["VaultRelaySettingTab"]
    end

    subgraph Coordination["Coordination & Security (src/sync/, src/security/)"]
        Coordinator["MutationCoordinator\n(WeakMap Lease Lock)"]
        SecretStore["SecretStore\n(github-vault-relay-pat)"]
        Classifier["SyncClassifier\n(10-State Inventory)"]
    end

    subgraph Engines["Core Synchronization Engines (src/sync/)"]
        UnifiedEngine["UnifiedSyncEngine"]
        PullEngine["PullEngine"]
        PushEngine["PushEngine"]
        ConflictMgr["ConflictManager"]
    end

    subgraph Storage["Persistence & Client (src/sync/, src/github/)"]
        StorageMgr["StorageManager\n(.obsidian/github-vault-relay/)"]
        Client["GitHubClient\n(Obsidian requestUrl)"]
    end

    UI --> Coordinator
    SettingsTab --> SecretStore
    Coordinator --> UnifiedEngine
    Coordinator --> ConflictMgr
    UnifiedEngine --> Classifier
    UnifiedEngine --> PullEngine
    UnifiedEngine --> PushEngine
    PullEngine --> Client
    PushEngine --> Client
    ConflictMgr --> Client
    PullEngine --> StorageMgr
    PushEngine --> StorageMgr
    ConflictMgr --> StorageMgr
    Client --> SecretStore
```

---

## 3. Unified Sync Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as SyncDashboardModal
    participant Lease as MutationCoordinator
    participant Sync as UnifiedSyncEngine
    participant Class as SyncClassifier
    participant Pull as PullEngine
    participant Push as PushEngine
    participant GitHub as GitHub API
    participant Store as StorageManager

    User->>UI: Click [ Sync ]
    UI->>Lease: acquireMutationLease(app, "Unified Sync")
    Lease-->>UI: Lease granted
    UI->>Sync: executeSync(onProgress)

    Note over Sync,GitHub: Phase 1: Initial Scan
    Sync->>Class: classifySyncState(localFiles, remoteBlobs, state)
    Class-->>Sync: Diff report (pullItems, pushItems, conflicts)

    opt Remote Changes Exist (REMOTE_ONLY / REMOTE_CHANGED)
        Note over Sync,GitHub: Phase 2: Safe Pull
        Sync->>Pull: executeSafePull(pullItems)
        Pull->>GitHub: GET /git/blobs/{sha}
        Pull->>Store: Record pre-write recovery journal
        Pull->>Store: Write & verify local files
        Pull->>Store: Save state.json & delete journal
        Pull-->>Sync: PullReport (SUCCESS)
    end

    Note over Sync,GitHub: Phase 3: Re-scan (Pull output incorporated)
    Sync->>Class: classifySyncState(freshLocal, freshRemote, state)
    Class-->>Sync: Updated pushItems

    opt Local Changes Exist (LOCAL_ONLY / LOCAL_CHANGED)
        Note over Sync,GitHub: Phase 4: Safe Push
        Sync->>Push: executeSafePush(freshPushItems)
        Push->>GitHub: Upload blobs, tree, commit
        Push->>Push: Re-verify local bytes on disk
        Push->>GitHub: PATCH /git/refs/heads/:branch (force: false)
        Push->>GitHub: Authoritative GET ref check
        Push->>Store: Advance state.json baseline
        Push-->>Sync: PushReport (SUCCESS)
    end

    Note over Sync,GitHub: Phase 5: Final Convergence Scan
    Sync->>Class: classifySyncState()
    Sync-->>UI: UnifiedSyncResult (PASS)
    UI->>Lease: releaseMutationLease()
    UI-->>User: Display Sync Complete
```

> [!IMPORTANT]
> **Non-Transaction Invariant**: Unified Sync is intentionally **not** an all-or-nothing rollback transaction. If Safe Pull succeeds and Safe Push subsequently fails (e.g. remote branch moved concurrently), the successfully pulled remote files are **not** rolled back. The partial success is reported truthfully to the user.

---

## 4. Safe Push Git Object Construction

```mermaid
flowchart TD
    Start(["Start Safe Push"]) --> Preflight["Preflight Checks: Exclusions, 25 MiB ceiling, Valid paths"]
    Preflight --> Blobs["1. POST /git/blobs for each modified file"]
    Blobs --> Tree["2. POST /git/trees using base commit tree SHA"]
    Tree --> Commit["3. POST /git/commits referencing parent commit SHA"]
    Commit --> InFlightCheck{"4. Re-read local disk files:<br>Did any bytes change in flight?"}
    InFlightCheck -->|"Yes"| AbortInFlight["ABORT: Local file modified during upload.<br>Branch ref untouched."]
    InFlightCheck -->|"No"| PatchRef["5. PATCH /git/refs/heads/:branch with force: false"]
    PatchRef --> RefCheck{"Remote accepted ref update?"}
    RefCheck -->|"Rejection / 422"| AbortMoved["ABORT: Remote HEAD moved concurrently.<br>History preserved."]
    RefCheck -->|"Network Drop"| RecoverLost["Query GET /git/refs/heads/:branch to verify authoritative SHA"]
    RecoverLost --> VerifyRef
    RefCheck -->|"200 OK"| VerifyRef["6. Authoritative GET ref verification retry budget"]
    VerifyRef --> AdvanceState["7. Durably advance state.json baseline commit SHA"]
    AdvanceState --> Done(["Push Complete"])
```

---

## 5. Conflict Resolution Sequence

```mermaid
flowchart TD
    PotentialConflict["Potential Conflict Detected:<br>Both local and remote notes modified independently"] --> UserReview["User Reviews Note in ConflictResolutionModal"]

    UserReview --> Choice{"User Resolution Choice"}

    Choice -->|"Keep Local"| KL1["1. Revalidate remote HEAD & local disk bytes"]
    KL1 --> KL2["2. Execute scoped authorized Safe Push to GitHub"]
    KL2 --> KL3["3. Clear conflict record & advance state baseline"]

    Choice -->|"Use Remote"| UR1["1. Revalidate local file matches reviewed hash"]
    UR1 --> UR2["2. Save pre-write local backup to journal"]
    UR2 --> UR3["3. Overwrite local file with verified remote blob"]
    UR3 --> UR4["4. Verify local disk bytes & update baseline"]

    Choice -->|"Keep Both"| KB1["1. Generate timestamped conflict filename"]
    KB1 --> KB2["2. Write remote version alongside local note"]
    KB2 --> KB3["3. Verify disk copy & advance baselines independently"]

    KL3 --> Resolved(["Conflict Resolved"])
    UR4 --> Resolved
    KB3 --> Resolved
```

---

## 6. Crash Recovery & Storage Lifecycle

```mermaid
flowchart TD
    Startup(["Obsidian Startup / Plugin Load"]) --> CheckDir["Ensure .obsidian/github-vault-relay/ exists"]
    CheckDir --> MigCheck{"Legacy storage detected?"}
    MigCheck -->|"Yes"| MigAction["Migrate C2/C3 root or C4 intermediate data with byte-exact verification"]
    MigAction --> AtomicRec
    MigCheck -->|"No"| AtomicRec["Inspect state.json: .tmp or .bak present?"]
    AtomicRec -->|".tmp without .bak"| DiscardTmp["Discard stale .tmp"]
    AtomicRec -->|".bak present"| RestoreBak["Restore last valid .bak backup to state.json"]
    DiscardTmp --> PullJournalCheck
    RestoreBak --> PullJournalCheck
    AtomicRec -->|"Clean"| PullJournalCheck["Inspect pull-recovery/ directory"]
    PullJournalCheck -->|"Journal found"| RollbackPull["Roll back interrupted pull writes to pre-write state"]
    PullJournalCheck -->|"No journals"| DelJournalCheck["Inspect delete-recovery/ directory"]
    RollbackPull --> DelJournalCheck
    DelJournalCheck -->|"Journal found"| RecoverDelete["Restore interrupted local deletions from snapshot"]
    DelJournalCheck -->|"No journals"| OrphanGC["Garbage Collect unreferenced conflict payloads"]
    RecoverDelete --> OrphanGC
    OrphanGC --> Ready(["Plugin Ready for User Interaction"])
```

---

## 7. Safe Deletion & Move Lifecycle

### Three-Way Deletion Classification Matrix

| Baseline (`state.json`) | Local Vault | Remote GitHub | Classification | Engine Handling |
| :--- | :--- | :--- | :--- | :--- |
| Present (`SHA1`) | Absent | Present (`SHA1`) | `LOCAL_DELETED` | Safe Push builds tree with `sha: null`. Ref updated `force: false`. Baseline pruned after verified omission. |
| Present (`SHA1`) | Present (`SHA1`) | Absent | `REMOTE_DELETED` | Safe Pull creates pre-delete recovery snapshot, deletes local file via `vault.delete()`, prunes baseline. |
| Present (`SHA1`) | Absent | Absent | `DELETED` | Baseline entry pruned cleanly without remote or local mutation. |
| Present (`SHA1`) | Absent | Present (`SHA2`) | `DELETE_CONFLICT` | Local deleted vs remote modified. Halts safely; presents `[ Keep File ]` or `[ Delete File ]`. |
| Present (`SHA1`) | Present (`SHA2`) | Absent | `DELETE_CONFLICT` | Remote deleted vs local modified. Halts safely; presents `[ Keep File ]` or `[ Delete File ]`. |
| Absent | Present | Absent | `LOCAL_ONLY` | Conservative: never inferred as remote deletion without baseline proof. |
| Absent | Absent | Present | `REMOTE_ONLY` | Conservative: never inferred as local deletion without baseline proof. |

### Move & Rename Semantics

1. **Push Move**: A local file move (e.g. `Projects/A.md` -> `Archive/A.md`) is decomposed into `delete Projects/A.md` + `add Archive/A.md` within a **single atomic Git commit**.
2. **Pull Move**: Safe Pull enforces strict sequencing:
   - Step 1: Write and verify destination (`Archive/A.md`) byte-exact.
   - Step 2: Delete source (`Projects/A.md`) only after destination write is verified.
   - Step 3: Update baseline state and clean up recovery snapshots.
   If Step 1 fails, the source file remains untouched.
3. **Exact-SHA Detection**: When the SHA of an added local file exactly matches the baseline SHA of a deleted local file, the UI pairs them as an exact Move (`Projects/A.md → Archive/A.md`).
4. **Git Data API Safety**: All remote deletions use `{ path, mode: "100644", type: "blob", sha: null }` in `POST /git/trees`. Zero HTTP `DELETE` endpoints, zero `PUT /contents`, `force: false` always.

---

## 8. Canonical Empty-Tree & Zero-File Lifecycle

### GitHub Git Data API Edge Case
In Git, an empty directory tree is deterministically represented by the canonical empty tree SHA:
```
4b825dc642cb6eb9a060e54bf8d69288fbee4904
```
However, GitHub's Git Data API exhibits two edge-case behaviors:
1. Calling `POST /git/trees` with `{ tree: [] }` returns `HTTP 422 Invalid tree info`.
2. Calling `POST /git/trees` with a valid `base_tree` and deleting the final file (`{ path: "...", sha: null }`) returns `HTTP 404 Not Found`.
3. Calling `GET /git/trees/4b825dc642cb6eb9a060e54bf8d69288fbee4904` returns `HTTP 404 Not Found` because GitHub does not persist or serve a physical Git tree object for the empty root.

### Deterministic Architecture Solution
Vault Relay resolves this limitation cleanly without synthetic files (`.gitkeep`, `README.md`) or artificial placeholder commits:

```mermaid
flowchart TD
    Scan["PushEngine computes resultingRemoteFileCount"] --> ZeroCheck{"resultingRemoteFileCount == 0?"}
    ZeroCheck -->|"Yes (All files deleted)"| EmptyFlow["DEDICATED EMPTY-TREE FLOW<br>targetTreeSha = CANONICAL_EMPTY_TREE_SHA<br>(Bypass POST /git/trees)"]
    ZeroCheck -->|"No (Files remain)"| StandardFlow["Standard Flow<br>POST /git/trees with sha: null entries"]
    
    EmptyFlow --> Commit["POST /git/commits referencing targetTreeSha"]
    StandardFlow --> Commit
    
    Commit --> PatchRef["PATCH /git/refs/heads/:branch (force: false)"]
    PatchRef --> Verify["Authoritative Post-Push Verification"]
    Verify --> ResolveTree["GitHubClient.getTreeRecursive(commitSha)"]
    
    ResolveTree --> Tree404{"GET /git/trees returns 404?"}
    Tree404 -->|"Yes"| CommitCheck["Query GET /git/commits/:sha"]
    CommitCheck --> IsEmpty{"commit.tree.sha == CANONICAL_EMPTY_TREE_SHA?"}
    IsEmpty -->|"Yes"| ReturnEmpty["Return { sha: CANONICAL_EMPTY_TREE_SHA, tree: [] }"]
    IsEmpty -->|"No"| ThrowErr["Rethrow original 404 error"]
    Tree404 -->|"No (200 OK)"| ReturnTree["Return tree items"]
```

### Transition Lifecycle: 0 ↔ 1+ Files
1. **Convergence to 0 Files**: When all synchronized files are removed locally, `PushEngine` commits `CANONICAL_EMPTY_TREE_SHA` directly. Post-verification confirms 0 files in the root tree, and `state.json` baseline is cleanly cleared of all file records.
2. **Transitioning from 0 to 1+ Files**: When a user creates the first file in an empty repository, `PushEngine` uploads the blob and calls `POST /git/trees` with `base_tree: CANONICAL_EMPTY_TREE_SHA` and the new file entry. GitHub natively accepts this call, builds a single-file tree, and the resulting commit advances the branch ref cleanly.
3. **Unborn Repository Boundary**: A repository must have at least one initial commit and branch. An unborn Git HEAD (0 commits) cannot be manipulated via Git Data API tree/commit endpoints; this is an inherent Git constraint documented in [README.md](../README.md).

