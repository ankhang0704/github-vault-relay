# Engineering Notes: How Vault Relay Actually Works

This is a maintainer study guide, not a marketing page. Every answer below is tied to the current implementation or its tests. Start with the Git model, then follow the baseline and safety checks through Pull, Push, storage, and recovery.

## Core Git and API concepts

### 1. What problem does Vault Relay solve?

It lets one Obsidian vault synchronize with one GitHub repository/branch over HTTPS when native Git is not available or desirable on the device. The runtime entry point is `src/main.ts`; the network implementation is `src/github/githubClient.ts`.

### 2. Why does it not run Git on mobile?

The plugin uses Obsidian `requestUrl()` and GitHub's Git Data API instead of `child_process`, a native Git binary, or `isomorphic-git`. This keeps the mobile runtime inside the APIs the plugin actually ships; see `src/github/githubClient.ts` and the package/runtime source.

### 3. What is a Git blob?

A blob is Git's content object: it stores file bytes without the file path. Vault Relay creates blobs with `POST /git/blobs` in `GitHubClient.createBlob()` and associates paths later through a tree.

### 4. What is a Git tree?

A tree is a directory listing that maps paths to blob objects, modes, and types. `PushEngine` sends tree entries to `GitHubClient.createTree()` so one planned vault state can become one remote tree.

### 5. What is a Git commit?

A commit names a tree, parent commit(s), message, and author metadata. `PushEngine` creates one commit after blobs/tree construction and before moving the branch ref. The commit is the history node; it does not itself make the branch visible until the ref moves.

### 6. What is a Git ref?

A ref is a mutable name pointing to an object, such as `refs/heads/main` pointing to a commit. Vault Relay updates the configured branch through `PATCH /git/refs/heads/{branch}` with `force: false`.

### 7. What does the GitHub REST/Git Data API distinction mean here?

Repository and branch discovery use ordinary GitHub REST endpoints such as `/user/repos` and `/repos/{owner}/{repo}/branches`. File synchronization uses the lower-level Git Data endpoints for blobs, trees, commits, refs, and raw blob reads. Both are implemented by `GitHubClient`.

### 8. Why use the Git Data API instead of `PUT /contents`?

The Git Data flow makes the tree, parent commit, and non-force ref update explicit. It lets one batch become one commit and avoids a file-at-a-time Contents API mutation. The security tests assert that production code does not use `PUT /contents` or HTTP `DELETE`.

### 9. What is a SHA in Vault Relay?

A SHA is an identifier for Git content or history. For a blob, it is computed from Git's header plus payload, not from raw bytes alone. `src/sync/hashUtils.ts` computes `sha1("blob " + byteLength + "\\0" + payload)` through Web Crypto.

### 10. Is SHA-1 being used as a password hash?

No. It is used as Git's content-addressed identity and integrity check, matching GitHub's blob SHA. PAT security comes from Obsidian `SecretStorage`, not from these file SHAs.

### 11. What is canonical content?

For `.md`, `.txt`, and `.canvas`, `canonicalContent.ts` converts CRLF/CR to LF before canonical hashing and writes. Other extensions are treated as binary bytes and are not character-normalized.

### 12. How does remote blob integrity get checked?

`GitHubClient.getRawBlobBytes()` decodes the returned blob, computes the raw Git blob SHA, and compares it with the requested SHA. A mismatch throws before Pull writes the file. `githubClientC2.test.ts` and Pull tests cover this boundary.

## Baseline and classification

### 13. What is the sync baseline?

The baseline is the last locally durable record of an accepted sync. `state.json` stores `lastSyncedCommitSha`, timestamps, and per-path `localSha`/`remoteSha` entries. `syncClassifier.ts` compares current local and remote inventory against this record.

### 14. Why are three inputs required?

Current local and remote content alone cannot reveal who changed what. The baseline supplies the common point needed to tell “only local changed,” “only remote changed,” “both changed,” or “one side deleted.”

### 15. What are the ten real classifier states?

The `SyncCategory` union has `LOCAL_ONLY`, `REMOTE_ONLY`, `LOCAL_CHANGED`, `REMOTE_CHANGED`, `POTENTIAL_CONFLICT`, `UNCHANGED`, `LOCAL_DELETED`, `REMOTE_DELETED`, `DELETE_CONFLICT`, and `DELETED`. `OVERSIZED` and `UNSAFE` are report counters/guards, not states in the union.

### 16. What happens when a file is missing but has no baseline?

It becomes `LOCAL_ONLY` if only local content exists or `REMOTE_ONLY` if only remote content exists. The implementation refuses to infer deletion from absence without synchronized existence evidence.

### 17. How is a normal content conflict classified?

If local and remote both differ from the recorded baseline, the result is `POTENTIAL_CONFLICT`. Pull/Push skip the automatic overwrite path and the UI sends the record to `ConflictManager` for an explicit decision.

### 18. What does `UNCHANGED` mean with text line endings?

It means the canonical hashes agree, not necessarily that the original line-ending bytes were identical. Text is normalized to LF before the relevant canonical hash is compared.

### 19. What are the deletion states?

`LOCAL_DELETED` means the baseline path is absent locally but remote content still matches the baseline. `REMOTE_DELETED` is the mirror. `DELETE_CONFLICT` means one side deleted while the other modified. `DELETED` means both sides are absent and only the obsolete baseline remains.

### 20. Why is `DELETE_CONFLICT` separate from `POTENTIAL_CONFLICT`?

The user decision is different: a deletion-versus-edit choice needs explicit “Keep File” or “Delete File” context, not a generic content choice. `deleteConflictType` records which side deleted and which side modified.

## Safe Pull and safe Push

### 21. What does Safe Pull do first?

It reads the configured branch/tree, filters paths and size, scans local files, loads state, and classifies the inventory. It does not download every remote blob before planning. See `PullEngine.executeSafePull()`.

### 22. What protects a local file during Pull?

Before a remote update, Pull checks that the local file still matches the reviewed local SHA. It creates a pull recovery journal and optional original backup, writes verified content, rereads it, and only then prepares the baseline update.

### 23. What happens if Pull is interrupted after a local write?

The journal remains under `${app.vault.configDir}/github-vault-relay/pull-recovery/`. On plugin load, `main.ts` calls `StorageManager.recoverInterruptedPullWrites()`, which verifies whether the remote result/state was committed or restores the original verified bytes when the write was uncommitted.

### 24. How does a remote deletion get pulled safely?

`REMOTE_DELETED` first creates a verified delete recovery snapshot under `delete-recovery/`, then calls `app.fileManager.trashFile()`, verifies the file is gone, prunes baseline state, and cleans recovery evidence after state persistence. It does not call `app.vault.delete()` for this path.

### 25. What does Safe Push do?

It scans local files, fetches remote branch/tree state, classifies eligible changes, uploads changed content as blobs, creates a tree, creates one commit, rereads local files, patches the ref with `force: false`, verifies the authoritative ref/tree, and finally saves the local baseline.

### 26. What is the atomic commit boundary?

One Safe Push operation groups its eligible creates, updates, moves, and deletions into one Git commit and one branch ref update. The individual HTTP calls before the ref update are not a distributed transaction; if the ref does not advance, local state does not pretend it did.

### 27. What does optimistic concurrency mean here?

Vault Relay uses the remote commit it observed as the expected parent and sends a non-force ref update. If another writer advances the branch first, GitHub rejects the non-fast-forward update instead of letting the plugin overwrite that history.

### 28. Where is remote HEAD revalidated?

Normal Push reads the branch/tree during planning and relies on the non-force ref update as the final concurrency gate. Reviewed conflict pushes explicitly reread branch and exact file/tree state immediately before their scoped mutation. Both flows also perform authoritative post-write verification.

### 29. What happens when the PATCH response is lost?

Push does not guess. It performs an independent authoritative ref read, with bounded verification attempts, and accepts success only if the ref points to the new commit. Otherwise the operation reports failure/abort and does not advance baseline.

### 30. How is a move represented in Git?

Git stores paths in trees rather than a separate rename object. Vault Relay represents a move as deletion of the old path plus addition of the new path in the same commit. The classifier pairs the UI display only when the content SHA exactly matches the deleted baseline.

### 31. How is a remote move applied locally?

Pull writes and verifies the destination first. Only after that succeeds does it remove the source. If destination materialization fails, the source remains, so a move cannot turn into a missing file because of a partial write.

### 32. How does the zero-file case work?

The canonical empty root tree is `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. When the resulting remote file count is zero, Push uses that SHA directly instead of asking GitHub to create an empty tree. The next file can use it as `base_tree`.

## Storage, secrets, and files

### 33. Where does internal state live?

`StorageManager.getPluginStorageDir(app)` returns `${app.vault.configDir}/github-vault-relay/`. The usual `.obsidian/...` spelling is an example only. State, conflict metadata/payloads, pull journals, and delete journals are kept there.

### 34. What is the difference between plugin storage and `_vault-relay/`?

The canonical plugin directory is hidden configuration storage. A root `_vault-relay/` directory is user-owned content in the current model; migration preserves its user files and the default exclusion migration removes the old plugin-owned rule.

### 35. How are state writes made durable?

`StorageManager.writeAtomicJson()` stages a `.tmp` file, verifies the decoded value, and uses a `.bak` fallback. Startup recovery inspects these artifacts before normal sync work.

### 36. Where is the PAT stored?

`src/security/secretStore.ts` uses Obsidian `SecretStorage` with the canonical key `github-vault-relay-pat`. If secure storage is unavailable, the code fails closed instead of falling back to plaintext runtime storage.

### 37. Why does localStorage appear in the secret-store code?

Only for one-time migration and cleanup of legacy values. The active path reads/writes SecretStorage; migration verifies the secure write and then purges legacy localStorage entries.

### 38. What does redaction cover?

`redact.ts` covers a configured token, GitHub PAT patterns, legacy token patterns, Bearer credentials, authorization headers, and token-like URL parameters in sanitized text. Some diagnostic console calls still pass caught error objects directly, so blanket redaction of every console diagnostic remains open.

### 39. How are text and binary files different?

Text extensions are decoded/normalized for canonical Git content. Binary attachments are carried as bytes and checked by SHA; no text encoding conversion is applied. The 25 MiB guard applies to both.

### 40. Why is there a 25 MiB ceiling?

`fileSizePolicy.ts` defines `MAX_SAFE_FILE_SIZE_BYTES = 25 * 1024 * 1024`. It is a Vault Relay mobile memory/bandwidth policy, not a statement of GitHub's maximum blob size. Oversized files are skipped with warnings.

## Performance, concurrency, and recovery

### 41. What is cached?

`SyncEngine` keeps an in-memory per-Obsidian-app hash cache keyed by path, mtime, and size. An unchanged tuple reuses the previous SHA and avoids rereading bytes during preview scans. It is not persistent and is not a correctness authority.

### 42. What is the cache's limitation?

If bytes change without mtime/size changing, the cache can be stale. Mutation paths reread files before remote writes, and callers can bypass the cache. The current implementation therefore uses the cache as a performance hint, not as proof that a push is safe.

### 43. What does `MutationCoordinator` lock?

It provides an in-memory lease per Obsidian `App` instance for Pull, Push, Unified Sync, and conflict actions. It prevents duplicate/reentrant work in that process; it is not a distributed lock across devices or external Git clients.

### 44. How does the plugin coexist with native Git or web edits?

External writers may advance the branch. Vault Relay reads the new ref/tree, classifies the differences, pulls safe changes, and refuses non-force history clobbering. External force-pushes remain outside the plugin's control.

### 45. What is the difference between automated and manual evidence?

The current automated baseline is 42 test files and 467 passing tests, checked by `npm run verify`. Real Windows/iOS behavior is a separate manual protocol in `MANUAL_TEST_MATRIX.md`; a passing Vitest run must not be described as a real-device PASS.

### 46. What should a maintainer say when a sync fails after Pull?

Say exactly what the result reports: Pull may have succeeded and remains applied while Push failed or was aborted. Unified Sync is sequential, not a two-phase commit, so recovery is a fresh scan and an explicit next action rather than an invented rollback claim.

### 47. What is the custom configuration-directory caveat?

StorageManager computes its path from `app.vault.configDir`, but `pathFilter.ts` initializes `DEFAULT_EXCLUSIONS` from a `.obsidian` fallback. Do not claim full default exclusion support for a custom config directory until that production follow-up is implemented and tested.

### 48. What is the current security wording caveat?

Claim SecretStorage-only active PAT storage and sanitized user-facing errors. Do not claim that every console diagnostic is redacted: the source still has warning sites that pass error objects directly. That hardening item was intentionally not changed in this documentation task.
