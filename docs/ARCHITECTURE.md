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

    Relay -- "HTTPS REST & Git Data API\n(Obsidian requestUrl)" --> GitDataAPI
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
        Classifier["SyncClassifier\n(6-State Inventory)"]
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
        Push->>GitHub: PATCH /git/refs/heads/{branch} (force: false)
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
    Start([Start Safe Push]) --> Preflight[Preflight Checks: Exclusions, 25 MiB ceiling, Valid paths]
    Preflight --> Blobs[1. POST /git/blobs for each modified file]
    Blobs --> Tree[2. POST /git/trees using base_commit tree SHA]
    Tree --> Commit[3. POST /git/commits referencing parent commit SHA]
    Commit --> InFlightCheck{4. Re-read local disk files: Did any bytes change in flight?}
    InFlightCheck -- Yes --> AbortInFlight[ABORT: Local file modified during upload. Ref untouched.]
    InFlightCheck -- No --> PatchRef[5. PATCH /git/refs/heads/{branch} with force: false]
    PatchRef --> RefCheck{Remote accepted update?}
    RefCheck -- Rejection / 422 --> AbortMoved[ABORT: Remote HEAD moved concurrently. History preserved.]
    RefCheck -- Network Drop --> RecoverLost[Query GET /git/refs/heads/{branch} to verify authoritative SHA]
    RecoverLost --> VerifyRef
    RefCheck -- 200 OK --> VerifyRef[6. Authoritative GET ref verification retry budget]
    VerifyRef --> AdvanceState[7. Durably advance state.json baseline commit SHA]
    AdvanceState --> Done([Push Complete])
```

---

## 5. Conflict Resolution Sequence

```mermaid
stateDiagram-v2
    [*] --> PotentialConflict: Both local and remote notes changed independently
    PotentialConflict --> UserReview: Review in ConflictResolutionModal

    state UserReview {
        [*] --> Choice
        Choice --> KeepLocal: Select "Keep Local"
        Choice --> UseRemote: Select "Use Remote"
        Choice --> KeepBoth: Select "Keep Both"
    }

    state KeepLocal {
        KL_Revalidate: Revalidate remote HEAD & local file
        KL_Push: Scoped authorized Safe Push
        KL_Done: Clear conflict & advance baseline
        KL_Revalidate --> KL_Push --> KL_Done
    }

    state UseRemote {
        UR_Revalidate: Revalidate local file matches reviewed hash
        UR_Backup: Save pre-write local backup to journal
        UR_Write: Overwrite local file with remote blob
        UR_Verify: Post-write verification
        UR_Done: Clear conflict & advance baseline
        UR_Revalidate --> UR_Backup --> UR_Write --> UR_Verify --> UR_Done
    }

    state KeepBoth {
        KB_Name: Generate deterministic timestamped filename
        KB_Write: Write remote version as conflict copy
        KB_Verify: Verify conflict copy on disk
        KB_Done: Update baseline for both files independently
        KB_Name --> KB_Write --> KB_Verify --> KB_Done
    }

    KeepLocal --> Resolved: Conflict eliminated
    UseRemote --> Resolved: Conflict eliminated
    KeepBoth --> Resolved: Conflict eliminated
    Resolved --> [*]
```

---

## 6. Crash Recovery & Storage Lifecycle

```mermaid
flowchart TD
    Startup([Obsidian Startup / Plugin Load]) --> CheckDir[Ensure .obsidian/github-vault-relay/ exists]
    CheckDir --> MigCheck{Legacy storage detected?}
    MigCheck -- Yes --> MigAction[Migrate C2/C3 root or C4 intermediate data with byte-exact verification]
    MigAction --> AtomicRec
    MigCheck -- No --> AtomicRec[Inspect state.json: .tmp or .bak present?]
    AtomicRec -- .tmp without .bak --> DiscardTmp[Discard stale .tmp]
    AtomicRec -- .bak present --> RestoreBak[Restore last valid .bak backup to state.json]
    DiscardTmp --> JournalCheck
    RestoreBak --> JournalCheck
    AtomicRec -- Clean --> JournalCheck[Inspect pull-recovery/ directory]
    JournalCheck -- Journal found --> RollbackJournal[Roll back interrupted pull writes to pre-write state]
    JournalCheck -- No journals --> OrphanGC[Garbage Collect unreferenced conflict payloads]
    RollbackJournal --> OrphanGC
    OrphanGC --> Ready([Plugin Ready for User Interaction])
```
