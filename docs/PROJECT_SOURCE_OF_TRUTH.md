# GitHub Vault Relay: Project Source of Truth

This is the current factual reference for Vault Relay. When this document conflicts with a checkpoint, the current source, tests, manifest, and `main` branch win.

## Current identity

| Fact | Canonical value | Evidence |
| :--- | :--- | :--- |
| Plugin/package | `github-vault-relay` | `manifest.json`, `package.json` |
| Release | `1.0.3` | `manifest.json`, `package.json`, Git tag `1.0.3` |
| Minimum Obsidian version | `1.11.4` | `manifest.json`, `tests/manifest.test.ts` |
| Mobile | Supported; `isDesktopOnly: false` | `manifest.json`, `tests/manifest.test.ts` |
| Remote service | GitHub REST/Git Data API over HTTPS | `src/github/githubClient.ts` |
| Test files | `42` | `tests/*.test.ts`, current `vitest run` output |
| Passing tests | `467` | current `vitest run` output |
| Quality gate | `PASS` (`npm run verify`, 2026-09-06) | `package.json`, local gate run |

`main.js` is a generated, ignored build artifact. The current production build identity is recorded by the verification run and should be regenerated rather than hand-edited. The manual matrix records the matching release asset hashes for reproducible device testing.

## Product boundary

Vault Relay is a user-triggered, GitHub-backed bridge for one configured vault/repository/branch. It avoids native Git on mobile and does not claim to be a distributed transaction system. Its priority is explicit failure and preservation of ambiguous state.

Non-goals are background/scheduled sync, sync-on-save, fuzzy rename inference, empty-directory sync, alternative Git forges, Canvas three-way merge, multi-account switching, and force-push behavior.

## Runtime architecture

The main flow is:

1. `SyncEngine` inventories local files and reads the remote branch/tree.
2. `syncClassifier.ts` compares local entries, remote blobs, and `state.json`.
3. `PullEngine` applies safe remote changes with blob verification and recovery journals.
4. `UnifiedSyncEngine` rescans after Pull.
5. `PushEngine` creates blobs/tree/commit, revalidates, updates the ref with `force: false`, and verifies the result.
6. `StorageManager` advances the durable baseline only after the operation's checks permit it.

The primary UI is `SyncDashboardModal`; the older Pull, Push, Preview, and conflict commands remain registered in `src/main.ts`.

## Classifier: ten implementation states

The union in `src/sync/syncTypes.ts` and branches in `src/sync/syncClassifier.ts` define these ten states:

| State | Actual condition | Result |
| :--- | :--- | :--- |
| `LOCAL_ONLY` | Local exists, remote and baseline do not | Push candidate |
| `REMOTE_ONLY` | Remote exists, local and baseline do not | Pull candidate |
| `LOCAL_CHANGED` | Both exist; local differs from baseline; remote matches baseline | Push candidate |
| `REMOTE_CHANGED` | Both exist; remote differs from baseline; local matches baseline | Pull candidate |
| `POTENTIAL_CONFLICT` | Both exist and both diverged from the baseline, or both differ without a base | Manual conflict review |
| `UNCHANGED` | Canonical local and remote SHAs match, or both still match their reviewed baseline | No-op |
| `LOCAL_DELETED` | Baseline exists; local is absent; remote still has baseline content | Push deletion candidate |
| `REMOTE_DELETED` | Baseline exists; remote is absent; local still has baseline content | Pull deletion candidate |
| `DELETE_CONFLICT` | One side deleted and the other side changed | Explicit Keep File/Delete File decision |
| `DELETED` | Baseline exists; both sides are absent | Remove obsolete baseline entry |

`OVERSIZED` and `UNSAFE` are counters/guards attached to a report. They are not members of `SyncCategory`.

Without a baseline entry, a missing file is deliberately treated as `LOCAL_ONLY` or `REMOTE_ONLY`; absence alone never proves deletion.

## Baseline and SHA semantics

`state.json` stores `lastSyncedCommitSha`, timestamps, and one `FileSyncStateEntry` per path containing `localSha`, `remoteSha`, and `syncedAt`. These are the comparison anchors for the classifier.

`hashUtils.ts` computes a Git blob SHA-1 over `blob <byte-length>\0<payload>`. Text paths are canonicalized to LF before the canonical SHA is computed; binary paths use the original bytes. Remote blob bytes are independently rehashed before a Pull writes them.

## Safe Pull

`PullEngine` fetches the remote branch/tree, filters unsafe or excluded paths, classifies changes, downloads verified blobs, and applies only eligible changes. Text is written in canonical LF form; binary content is byte-exact. Existing local content is checked before overwrite. Pull writes are journaled under `pull-recovery/`; remote deletions are snapshotted under `delete-recovery/` and routed through `app.fileManager.trashFile()`.

For an exact-SHA remote move, the destination is materialized and verified before the source is removed. If destination materialization fails, the source remains.

## Safe Push and optimistic concurrency

`PushEngine` uploads changed bytes as blobs, builds one tree from the remote base tree, creates one commit, rereads local files before the ref update, and calls `PATCH /git/refs/heads/{branch}` with `force: false`. It then verifies the authoritative branch ref and resulting tree/blob SHAs before updating the local baseline.

This is optimistic concurrency: the branch's expected parent is used as the concurrency boundary. A remote HEAD change causes the ref update to fail rather than overwrite unrelated history. A lost PATCH response is resolved by an authoritative ref read before status is reported.

One Safe Push batch has one Git commit/ref update boundary. Blob and tree objects created before a failed ref update may remain unreachable Git objects; the branch and local baseline are not advanced as if the push succeeded.

## Deletion and move model

Remote deletion is represented by omitting a path in a Git tree, or by `sha: null` in the tree input when files remain. The final-file case uses `CANONICAL_EMPTY_TREE_SHA` (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) directly. No HTTP `DELETE` endpoint is used.

Local deletion during Pull uses Obsidian trash semantics after recovery evidence is written and the destination/source ordering for moves is satisfied. User-triggered confirmation flows are the boundary for destructive sync actions.

## Storage and migration

The canonical internal directory is computed as:

`${app.vault.configDir}/github-vault-relay/`

It contains `state.json`, `conflicts_meta.json`, conflict payloads, `pull-recovery/`, and `delete-recovery/` as needed. `${app.vault.configDir}` is dynamic; `.obsidian` is only the usual example.

`StorageManager.migrateLegacyStorage()` handles legacy root `_vault-relay/` state, intermediate `${configDir}/vault-relay/`, and the intermediate plugin directory. Root `_vault-relay/` user files are preserved as normal content. State writes use `.tmp` and `.bak` recovery paths.

Current limitation: `pathFilter.ts` exposes `getDefaultExclusions(configDir)`, but `DEFAULT_EXCLUSIONS` is initialized from its `.obsidian` fallback and settings use that constant. The storage path itself is dynamic; default exclusion behavior for a custom `configDir` needs a production follow-up and is not claimed as fully solved here.

## Secret and network model

`src/security/secretStore.ts` uses Obsidian `SecretStorage` as the only active PAT backend with key `github-vault-relay-pat`. localStorage is only consulted for verified one-time legacy migration when SecretStorage is available; it is not a runtime fallback. `redact.ts` provides token-pattern and configured-token redaction for sanitized errors.

The client uses `requestUrl()` and GitHub endpoints for repository/branch discovery, ref/tree/blob reads, and Git Data API writes. Automatic retries are bounded and mutation requests fail closed on connection loss. The implementation has no telemetry or intermediary relay service.

## Verification evidence

The canonical executable gate is:

```text
npm run verify
```

It runs ESLint with zero warnings, TypeScript typechecking, Vitest, and the production build. Current automated test evidence is 42 files and 467 passing tests. Historical checkpoint totals in `docs/development-history/` and older Changelog entries are snapshots, not current totals.

The current manual acceptance matrix is a protocol. Its device rows must remain `NOT RUN` until a real Windows/iOS run is recorded; automated tests do not prove real-device acceptance.

## Ownership and AI-assisted engineering

The maintainer/product owner owns problem definition, requirements, scope, product decisions, direction given to agents, manual testing, acceptance/rejection, and release decisions.

Engineering work was AI-assisted: architecture exploration, implementation/refactoring, test generation, audits, and documentation drafting were performed with human review and direction. Technical decisions are attributed to the maintainer only when supported by an explicit decision, test, commit/history record, or current implementation—not merely by authorship of a file.

## Current open technical follow-ups

These are intentionally not changed by this documentation task:

1. Make default path exclusions consume the live `app.vault.configDir` for custom Obsidian configuration directories.
2. Audit remaining diagnostic logging that passes caught error objects directly so the PAT-never-in-logs invariant is blanket, not only enforced on sanitized user-facing paths.

Until those are resolved, portfolio wording must not claim complete custom-config-dir exclusion coverage or blanket redaction of every console diagnostic.
