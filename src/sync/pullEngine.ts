/**
 * Safe Pull Engine for Vault Relay (Checkpoint 2: GitHub -> Obsidian Local)
 *
 * Implements the conservative Safe Pull workflow:
 * - Strictly READ-ONLY on remote GitHub (zero GitHub writes/commits/refs).
 * - Fresh HEAD and tree re-validation.
 * - Truncated tree full abort guard.
 * - Path traversal and reserved directory guards.
 * - Case collision detection and safety blocks.
 * - 25 MiB mobile safety size ceiling.
 * - Remote blob raw SHA cryptographic integrity verification.
 * - Canonical LF normalization for text (.md, .txt, .canvas), 100% byte-exact for binary.
 * - Pre-write local modification check (local editor edits win; never silently overwritten).
 * - Conflict preservation under internal storage (.obsidian/vault-relay/conflicts/) without modifying local files.
 * - Post-write verification before advancing baseline state.
 */

import { App, TFile } from "obsidian";
import { GitHubClient } from "../github/githubClient";
import { VaultRelaySettings } from "../settings";
import { isCanonicalTextPath, canonicalizeTextBytes, prepareContentBytesForPath } from "./canonicalContent";
import { isOversized } from "./fileSizePolicy";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "./hashUtils";
import { isPathExcluded, normalizePath } from "./pathFilter";
import { detectCaseCollisions, validatePathSafety } from "./pathSafety";
import { classifySyncState } from "./syncClassifier";
import { StorageManager } from "./storageManager";
import { ConflictManager } from "./conflictManager";
import { SyncProgressCallback } from "./progressTypes";
import {
  acquireMutationLease,
  getActiveMutationLabel,
  MutationLease,
  ownsMutationLease,
  releaseMutationLease,
} from "./mutationCoordinator";
import {
  LocalFileEntry,
  PullExecutionReport,
  PullFileResult,
  RemoteBlobEntry,
  SyncStateData,
} from "./syncTypes";
import { sanitizeErrorMessage } from "../security/redact";

export class PullEngine {
  private app: App;
  private settings: VaultRelaySettings;
  private githubClient: GitHubClient;

  constructor(app: App, settings: VaultRelaySettings, githubClient: GitHubClient) {
    this.app = app;
    this.settings = settings;
    this.githubClient = githubClient;
  }

  /**
   * Helper to ensure all parent directories exist in the Obsidian vault.
   */
  private async ensureParentFolderExists(filePath: string): Promise<void> {
    const normalized = normalizePath(filePath);
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash === -1) return;

    const folderPath = normalized.substring(0, lastSlash);
    const segments = folderPath.split("/");
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const abstractFile = this.app.vault.getAbstractFileByPath(currentPath);
      if (!abstractFile) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch {
          // If folder already exists or adapter handled it, continue
        }
      }
    }
  }

  /**
   * Scans local files in the vault.
   */
  public async scanLocalVault(): Promise<Map<string, LocalFileEntry>> {
    const localFiles = new Map<string, LocalFileEntry>();
    const allVaultFiles = this.app.vault.getFiles();

    for (const file of allVaultFiles) {
      if (isPathExcluded(file.path, this.settings.excludedPaths)) {
        continue;
      }

      try {
        const binaryContent = await this.app.vault.readBinary(file);
        const sha = await calculateCanonicalGitBlobSha(binaryContent, file.path);

        localFiles.set(file.path, {
          path: file.path,
          sha,
          size: file.stat.size,
          mtime: file.stat.mtime,
        });
      } catch (err) {
        console.warn(`[Vault Relay] Failed to read ${file.path}:`, err);
      }
    }

    return localFiles;
  }

  /**
   * Loads sync state from internal storage.
   */
  public async loadState(): Promise<SyncStateData> {
    return StorageManager.loadState(this.app);
  }

  /**
   * Saves updated sync state to internal storage.
   */
  public async saveState(state: SyncStateData): Promise<void> {
    return StorageManager.saveState(this.app, state);
  }

  /**
   * Executes the complete Safe Pull process.
   */
  public async executeSafePull(
    onProgress?: SyncProgressCallback,
    existingLease?: MutationLease
  ): Promise<PullExecutionReport> {
    const ownsExistingLease = ownsMutationLease(this.app, existingLease);
    const mutationLease = ownsExistingLease ? existingLease : acquireMutationLease(this.app, "Safe Pull");

    if (!mutationLease) {
      return {
        timestamp: Date.now(),
        branch: this.settings.branch || "main",
        status: "ABORTED",
        results: [],
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        summaryMessage: `Safe Pull blocked because another vault mutation is in progress (${getActiveMutationLabel(this.app) || "unknown operation"}).`,
      };
    }

    try {
      return await this.executeSafePullUnlocked(onProgress);
    } finally {
      if (!ownsExistingLease) releaseMutationLease(mutationLease);
    }
  }

  private async executeSafePullUnlocked(onProgress?: SyncProgressCallback): Promise<PullExecutionReport> {
    const timestamp = Date.now();
    const branchName = this.settings.branch || "main";

    // Preflight offline check
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // Aborted offline
      return {
        timestamp,
        branch: branchName,
        status: "ABORTED",
        results: [],
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        summaryMessage: "Device is offline (network disconnected). Safe pull was aborted.",
      };
    }

    onProgress?.({ phase: "PLANNING", completed: 0, total: 1, message: "Planning safe pull..." });

    // Step 1: Fetch fresh branch HEAD and tree from GitHub
    let remoteCommitSha: string;
    let treeSha: string;
    let treeResponse;

    try {
      const branchInfo = await this.githubClient.getBranch(branchName, true);
      remoteCommitSha = branchInfo.commit.sha;
      treeSha = branchInfo.commit.commit?.tree?.sha || branchInfo.commit.sha;
      treeResponse = await this.githubClient.getTreeRecursive(treeSha);
    } catch (err) {
      const safeMsg = sanitizeErrorMessage(err);
      return {
        timestamp,
        branch: branchName,
        status: "FAIL",
        results: [],
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        summaryMessage: `Failed to fetch remote repository state: ${safeMsg}`,
      };
    }

    // Step 2: Check for truncated Git tree
    if (treeResponse.truncated) {
      return {
        timestamp,
        branch: branchName,
        remoteCommitSha,
        status: "ABORTED",
        results: [],
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        summaryMessage:
          "Remote tree was truncated by GitHub API (>100,000 objects). Safe pull is blocked to prevent partial synchronization.",
      };
    }

    // Step 3: Scan local vault and load state
    const localFiles = await this.scanLocalVault();
    const state = await this.loadState();

    // Step 4: Filter and validate remote blobs
    const remoteBlobs = new Map<string, RemoteBlobEntry>();
    const remotePaths: string[] = [];

    for (const item of treeResponse.tree) {
      if (item.type !== "blob") continue;
      if (isPathExcluded(item.path, this.settings.excludedPaths)) continue;

      remoteBlobs.set(item.path, {
        path: item.path,
        sha: item.sha,
        size: item.size,
        mode: item.mode,
      });
      remotePaths.push(item.path);
    }

    // Step 5: Check for case collisions
    const allPaths = Array.from(new Set([...localFiles.keys(), ...remotePaths]));
    const caseCollisions = detectCaseCollisions(allPaths);

    // Step 6: Run 3-way classification
    const classification = classifySyncState({
      localFiles,
      remoteBlobs,
      state,
      excludedPaths: this.settings.excludedPaths,
    });

    const results: PullFileResult[] = [];
    const counts = {
      pulledCreated: 0,
      pulledUpdated: 0,
      pulledDeleted: 0,
      pulledMoved: 0,
      conflictsPreserved: 0,
      unchanged: 0,
      skippedLocalOnly: 0,
      skippedLocalChanged: 0,
      skippedOversized: 0,
      skippedUnsafe: 0,
      failed: 0,
    };

    let stateModified = false;
    const pendingRecoveryJournals: string[] = [];
    const pendingDeleteRecoveryJournals: string[] = [];
    let statePersisted = false;
    let processedCount = 0;

    // Split into non-deletions and deletions.
    // Core invariant for moves: destination creation MUST be materialized and verified before source deletion.
    const nonDeletions = classification.items.filter((it) => it.category !== "REMOTE_DELETED");
    const deletions = classification.items.filter((it) => it.category === "REMOTE_DELETED");
    const orderedItems = [...nonDeletions, ...deletions];

    onProgress?.({ phase: "PLANNING", completed: 0, total: orderedItems.length, message: "Planning safe pull..." });

    // Step 7: Process each item safely
    for (const item of orderedItems) {
      processedCount++;
      if (item.category === "REMOTE_DELETED") {
        if (item.isMove) {
          onProgress?.({
            phase: "APPLYING_MOVES",
            completed: processedCount,
            total: orderedItems.length,
            currentPath: item.path,
            message: `Applying move (${processedCount} / ${orderedItems.length})`,
          });
        } else {
          onProgress?.({
            phase: "REMOVING_LOCAL",
            completed: processedCount,
            total: orderedItems.length,
            currentPath: item.path,
            message: `Removing local file (${processedCount} / ${orderedItems.length})`,
          });
        }
      } else {
        onProgress?.({
          phase: "DOWNLOADING",
          completed: processedCount,
          total: orderedItems.length,
          currentPath: item.path,
        });
      }
      const path = item.path;

      // 7.1 Path safety check
      const pathCheck = validatePathSafety(path, this.settings.excludedPaths);
      if (!pathCheck.valid) {
        counts.skippedUnsafe++;
        results.push({
          path,
          action: "SKIP_UNSAFE",
          status: "SKIPPED",
          message: `Unsafe path: ${pathCheck.reason}`,
        });
        continue;
      }

      // 7.2 Case collision check
      const lowerPath = normalizePath(path).toLowerCase();
      if (caseCollisions.has(lowerPath)) {
        const colliding = caseCollisions.get(lowerPath) || [];
        counts.skippedUnsafe++;
        results.push({
          path,
          action: "SKIP_UNSAFE",
          status: "SKIPPED",
          message: `Case collision detected: conflicts with [${colliding.join(", ")}]. Blocked for safety.`,
        });
        continue;
      }

      // 7.3 Handle UNCHANGED
      if (item.category === "UNCHANGED") {
        counts.unchanged++;
        results.push({
          path,
          action: "SKIP_UNCHANGED",
          status: "SUCCESS",
          localSha: item.localSha,
          remoteSha: item.remoteSha,
        });

        // Ensure baseline is recorded
        if (item.localSha && item.remoteSha && (!state.files[path] || state.files[path].localSha !== item.localSha)) {
          state.files[path] = {
            localSha: item.localSha,
            remoteSha: item.remoteSha,
            syncedAt: timestamp,
          };
          stateModified = true;
        }
        continue;
      }

      // 7.4 Handle LOCAL_ONLY
      if (item.category === "LOCAL_ONLY") {
        counts.skippedLocalOnly++;
        results.push({
          path,
          action: "SKIP_LOCAL_ONLY",
          status: "SKIPPED",
          localSha: item.localSha,
          message: "Local only file. Kept untouched (future push responsibility).",
        });
        continue;
      }

      // 7.5 Handle LOCAL_CHANGED
      if (item.category === "LOCAL_CHANGED") {
        counts.skippedLocalChanged++;
        results.push({
          path,
          action: "SKIP_LOCAL_CHANGED",
          status: "SKIPPED",
          localSha: item.localSha,
          remoteSha: item.remoteSha,
          message: "Modified locally. Kept untouched (future push responsibility).",
        });
        continue;
      }

      // 7.6 Handle REMOTE_DELETED (Safe local file deletion with durable recovery)
      if (item.category === "REMOTE_DELETED") {
        // Paired move safety guard: if this deletion is part of a remote move, verify destination write succeeded
        if (item.isMove && item.movedTo) {
          const destResult = results.find((r) => r.path === item.movedTo);
          if (!destResult || destResult.status !== "SUCCESS") {
            counts.failed++;
            results.push({
              path,
              action: "PULL_DELETE",
              status: "FAILED",
              message: `Move destination ${item.movedTo} failed to materialize. Source file preserved intact.`,
            });
            continue;
          }
        }

        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) {
          // Already absent locally. Clean obsolete baseline entry.
          delete state.files[path];
          stateModified = true;
          counts.pulledDeleted++;
          results.push({
            path,
            action: "PULL_DELETE",
            status: "SUCCESS",
            message: "File was already absent locally. Baseline entry cleaned.",
          });
          continue;
        }

        if (!(file instanceof TFile)) {
          counts.failed++;
          results.push({
            path,
            action: "PULL_DELETE",
            status: "FAILED",
            message: "Target is a directory, not a file.",
          });
          continue;
        }

        try {
          // Pre-delete local check: has local file changed since planning?
          const currentBytes = await this.app.vault.readBinary(file);
          const currentSha = await calculateCanonicalGitBlobSha(currentBytes, path);
          if (item.localSha && currentSha.toLowerCase() !== item.localSha.toLowerCase()) {
            // Local file was modified! Converted to conflict - DO NOT delete
            counts.conflictsPreserved++;
            results.push({
              path,
              action: "PRESERVE_CONFLICT",
              status: "CONFLICT_PRESERVED",
              localSha: currentSha,
              message: "File was modified locally before remote deletion could be pulled. Deletion blocked to protect local data.",
            });
            continue;
          }

          // Durable delete recovery record before calling destructive delete
          const deleteJournal = await StorageManager.beginDeleteRecovery(
            this.app,
            path,
            currentSha,
            currentBytes
          );

          // Delete file via canonical Obsidian trash/vault API
          await StorageManager.deleteVaultFile(this.app, file);

          // Verify absence
          const stillExists = await this.app.vault.adapter.exists(path);
          if (stillExists) {
            throw new Error(`Failed to delete local file ${path}: file is still present on disk.`);
          }

          // Advance state: remove from baseline
          delete state.files[path];
          stateModified = true;

          // Defer recovery cleanup until state is safely committed to disk
          pendingDeleteRecoveryJournals.push(deleteJournal);

          counts.pulledDeleted++;
          if (item.isMove && item.movedTo) {
            counts.pulledMoved = (counts.pulledMoved || 0) + 1;
          }
          results.push({
            path,
            action: "PULL_DELETE",
            status: "SUCCESS",
            message: "File safely removed locally matching remote deletion.",
          });
        } catch (delErr) {
          const safeMsg = sanitizeErrorMessage(delErr);
          counts.failed++;
          results.push({
            path,
            action: "PULL_DELETE",
            status: "FAILED",
            message: `Failed to delete local file: ${safeMsg}`,
          });
        }
        continue;
      }

      // 7.7 Handle DELETE_CONFLICT
      if (item.category === "DELETE_CONFLICT") {
        counts.conflictsPreserved++;
        results.push({
          path,
          action: "PRESERVE_CONFLICT",
          status: "CONFLICT_PRESERVED",
          localSha: item.localSha,
          remoteSha: item.remoteSha,
          message: "Delete conflict detected (one side deleted, other side modified). Kept untouched for review.",
        });
        continue;
      }

      // 7.8 Handle DELETED (Both sides deleted / converged)
      if (item.category === "DELETED") {
        delete state.files[path];
        stateModified = true;
        counts.unchanged++;
        results.push({
          path,
          action: "SKIP_UNCHANGED",
          status: "SUCCESS",
          message: "File deleted on both sides. Obsolete baseline entry removed.",
        });
        continue;
      }

      // 7.9 Handle File Size Policy Check for Remote Downloads
      const remoteBlob = remoteBlobs.get(path);
      if (!remoteBlob) {
        continue;
      }

      if (isOversized(remoteBlob.size)) {
        counts.skippedOversized++;
        results.push({
          path,
          action: "SKIP_OVERSIZED",
          status: "SKIPPED",
          remoteSha: remoteBlob.sha,
          message: `File size (${remoteBlob.size} bytes) exceeds Vault Relay 25 MiB mobile safety ceiling. Skipped.`,
        });
        continue;
      }

      // 7.7 Handle REMOTE_ONLY (Safe Create)
      if (item.category === "REMOTE_ONLY") {
        try {
          const rawBytes = await this.githubClient.getRawBlobBytes(remoteBlob.sha, remoteBlob.size);
          const contentBytes = prepareContentBytesForPath(rawBytes, path);
          const expectedLocalSha = await calculateRawGitBlobSha(contentBytes);

          // Verify no concurrent local file creation occurred
          const existingFile = this.app.vault.getAbstractFileByPath(path);
          if (existingFile) {
            // Divert to conflict
            const conflictPath = await this.preserveConflictCopy(
              path,
              rawBytes,
              timestamp,
              undefined,
              item.remoteSha,
              remoteCommitSha
            );
            counts.conflictsPreserved++;
            results.push({
              path,
              action: "PRESERVE_CONFLICT",
              status: "CONFLICT_PRESERVED",
              remoteSha: remoteBlob.sha,
              conflictPath,
              message: "File was created locally during sync. Remote version preserved in conflict directory.",
            });
            continue;
          }

          // Ensure parent folders exist
          await this.ensureParentFolderExists(path);

          const recoveryJournal = await StorageManager.beginPullWriteRecovery(
            this.app,
            path,
            expectedLocalSha,
            remoteBlob.sha
          );

          // Create local file
          await this.app.vault.createBinary(path, contentBytes.buffer);

          // Post-write verification
          const writtenFile = this.app.vault.getAbstractFileByPath(path);
          if (!(writtenFile instanceof TFile)) {
            throw new Error("Created file not found in vault after write.");
          }
          const verifiedBytes = await this.app.vault.readBinary(writtenFile);
          const verifiedLocalSha = await calculateCanonicalGitBlobSha(verifiedBytes, path);
          if (verifiedLocalSha.toLowerCase() !== expectedLocalSha.toLowerCase()) {
            throw new Error("Post-write verification failed: local content does not match the verified remote blob.");
          }

          // Update baseline state
          state.files[path] = {
            localSha: verifiedLocalSha,
            remoteSha: remoteBlob.sha,
            syncedAt: timestamp,
          };
          stateModified = true;
          pendingRecoveryJournals.push(recoveryJournal);

          counts.pulledCreated++;
          results.push({
            path,
            action: "PULL_CREATE",
            status: "SUCCESS",
            localSha: verifiedLocalSha,
            remoteSha: remoteBlob.sha,
            message: "Created local file from remote repository.",
          });
        } catch (err) {
          counts.failed++;
          results.push({
            path,
            action: "PULL_CREATE",
            status: "FAILED",
            remoteSha: remoteBlob.sha,
            message: `Failed to create file: ${sanitizeErrorMessage(err)}`,
          });
        }
        continue;
      }

      // 7.8 Handle REMOTE_CHANGED (Safe Update)
      if (item.category === "REMOTE_CHANGED") {
        let originalBytes: ArrayBuffer | undefined;
        let writeAttempted = false;
        let recoveryJournal: string | undefined;
        let rollbackSucceeded = false;
        try {
          const rawBytes = await this.githubClient.getRawBlobBytes(remoteBlob.sha, remoteBlob.size);
          const contentBytes = prepareContentBytesForPath(rawBytes, path);
          const expectedLocalSha = await calculateRawGitBlobSha(contentBytes);

          const existingAbstract = this.app.vault.getAbstractFileByPath(path);
          if (!(existingAbstract instanceof TFile)) {
            throw new Error("Target file for update not found in local vault.");
          }

          // Immediate pre-write verification: Ensure local file was NOT modified since planning!
          const currentDiskBytes = await this.app.vault.readBinary(existingAbstract);
          originalBytes = currentDiskBytes.slice(0);
          const currentLocalSha = await calculateCanonicalGitBlobSha(currentDiskBytes, path);

          if (currentLocalSha !== item.localSha) {
            // Local file was edited concurrently -> PRESERVE BOTH
            const conflictPath = await this.preserveConflictCopy(
              path,
              rawBytes,
              timestamp,
              item.localSha,
              remoteBlob.sha,
              remoteCommitSha
            );
            counts.conflictsPreserved++;
            results.push({
              path,
              action: "PRESERVE_CONFLICT",
              status: "CONFLICT_PRESERVED",
              localSha: currentLocalSha,
              remoteSha: remoteBlob.sha,
              conflictPath,
              message: "Local file was modified concurrently in editor. Remote version preserved as conflict copy.",
            });
            continue;
          }

          // Modify existing local file
          recoveryJournal = await StorageManager.beginPullWriteRecovery(
            this.app,
            path,
            expectedLocalSha,
            remoteBlob.sha,
            originalBytes
          );
          writeAttempted = true;
          await this.app.vault.modifyBinary(existingAbstract, contentBytes.buffer);

          // Post-write verification
          const verifiedBytes = await this.app.vault.readBinary(existingAbstract);
          const verifiedLocalSha = await calculateCanonicalGitBlobSha(verifiedBytes, path);
          if (verifiedLocalSha.toLowerCase() !== expectedLocalSha.toLowerCase()) {
            throw new Error("Post-write verification failed: local content does not match the verified remote blob.");
          }

          // Update baseline state
          state.files[path] = {
            localSha: verifiedLocalSha,
            remoteSha: remoteBlob.sha,
            syncedAt: timestamp,
          };
          stateModified = true;
          pendingRecoveryJournals.push(recoveryJournal);

          counts.pulledUpdated++;
          results.push({
            path,
            action: "PULL_UPDATE",
            status: "SUCCESS",
            localSha: verifiedLocalSha,
            remoteSha: remoteBlob.sha,
            message: "Updated local file from remote repository.",
          });
        } catch (err) {
          let rollbackMessage = "";
          if (writeAttempted && originalBytes) {
            try {
              const current = this.app.vault.getAbstractFileByPath(path);
              if (!(current instanceof TFile)) throw new Error("target disappeared during rollback");
              await this.app.vault.modifyBinary(current, originalBytes);
              const restored = await this.app.vault.readBinary(current);
              const restoredSha = await calculateCanonicalGitBlobSha(restored, path);
              const originalSha = await calculateCanonicalGitBlobSha(originalBytes, path);
              if (restoredSha !== originalSha) throw new Error("restored content hash mismatch");
              rollbackMessage = " Original local content was restored.";
              rollbackSucceeded = true;
            } catch (rollbackErr) {
              rollbackMessage = ` Automatic rollback failed: ${sanitizeErrorMessage(rollbackErr)}.`;
            }
          }
          if (rollbackSucceeded && recoveryJournal) {
            await StorageManager.completePullWriteRecovery(this.app, recoveryJournal);
          }
          counts.failed++;
          results.push({
            path,
            action: "PULL_UPDATE",
            status: "FAILED",
            remoteSha: remoteBlob.sha,
            message: `Failed to update file: ${sanitizeErrorMessage(err)}.${rollbackMessage}`,
          });
        }
        continue;
      }

      // 7.9 Handle POTENTIAL_CONFLICT
      if (item.category === "POTENTIAL_CONFLICT") {
        try {
          const rawBytes = await this.githubClient.getRawBlobBytes(remoteBlob.sha, remoteBlob.size);

          // If supported text file and no previous baseline, check if canonical text is identical!
          if (isCanonicalTextPath(path) && !state.files[path]) {
            const canonicalRemoteBytes = canonicalizeTextBytes(rawBytes);
            const canonicalRemoteSha = await calculateRawGitBlobSha(canonicalRemoteBytes);

            if (item.localSha && canonicalRemoteSha === item.localSha) {
              // EOL-only difference with no content conflict: establish baseline!
              state.files[path] = {
                localSha: item.localSha,
                remoteSha: remoteBlob.sha,
                syncedAt: timestamp,
              };
              stateModified = true;
              counts.unchanged++;
              results.push({
                path,
                action: "ESTABLISH_BASELINE",
                status: "SUCCESS",
                localSha: item.localSha,
                remoteSha: remoteBlob.sha,
                message: "Text content matches canonically (line ending parity). Baseline established.",
              });
              continue;
            }
          }

          // Content actually differs or is binary: preserve remote version in conflict folder
          const conflictPath = await this.preserveConflictCopy(
            path,
            rawBytes,
            timestamp,
            item.localSha,
            remoteBlob.sha,
            remoteCommitSha
          );
          counts.conflictsPreserved++;
          results.push({
            path,
            action: "PRESERVE_CONFLICT",
            status: "CONFLICT_PRESERVED",
            localSha: item.localSha,
            remoteSha: remoteBlob.sha,
            conflictPath,
            message: `Conflict detected. Local original preserved untouched. Remote version saved to: ${conflictPath}`,
          });
        } catch (err) {
          counts.failed++;
          results.push({
            path,
            action: "PRESERVE_CONFLICT",
            status: "FAILED",
            remoteSha: remoteBlob.sha,
            message: `Failed to preserve conflict copy: ${sanitizeErrorMessage(err)}`,
          });
        }
      }
    }

    // Step 8: Persist state if modified
    if (stateModified || (!state.lastSyncedCommitSha && counts.failed === 0)) {
      onProgress?.({ phase: "UPDATING_STATE", completed: 0, total: 1, message: "Updating sync state..." });
      if (counts.failed === 0) {
        state.lastSyncedCommitSha = remoteCommitSha;
        state.lastSyncedAt = timestamp;
      }
      try {
        await this.saveState(state);
        statePersisted = true;
      } catch (stateErr) {
        counts.failed++;
        results.push({
          path: StorageManager.getStateFilePath(this.app),
          action: "UPDATE_STATE",
          status: "FAILED",
          message: `Failed to persist sync state: ${sanitizeErrorMessage(stateErr)}`,
        });
        onProgress?.({ phase: "FAILED", completed: 0, total: 1, message: "Local changes were applied, but sync state could not be saved." });
      }
    }

    if (statePersisted) {
      for (const journalPath of pendingRecoveryJournals) {
        await StorageManager.completePullWriteRecovery(this.app, journalPath);
      }
      for (const journalPath of pendingDeleteRecoveryJournals) {
        await StorageManager.completeDeleteRecovery(this.app, journalPath);
      }
    }

    // Step 9: Determine overall execution status
    let status: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" = "PASS";
    if (counts.failed > 0) {
      status = "FAIL";
    } else if (counts.conflictsPreserved > 0 || counts.skippedOversized > 0 || counts.skippedUnsafe > 0) {
      status = "PASS_WITH_WARNINGS";
    }

    const summaryParts: string[] = [];
    if (counts.pulledCreated > 0) summaryParts.push(`${counts.pulledCreated} created`);
    if (counts.pulledUpdated > 0) summaryParts.push(`${counts.pulledUpdated} updated`);
    if (counts.pulledDeleted > 0) summaryParts.push(`${counts.pulledDeleted} deleted`);
    if (counts.conflictsPreserved > 0) summaryParts.push(`${counts.conflictsPreserved} conflicts preserved`);
    if (counts.skippedOversized > 0) summaryParts.push(`${counts.skippedOversized} oversized skipped`);
    if (counts.skippedUnsafe > 0) summaryParts.push(`${counts.skippedUnsafe} unsafe skipped`);
    if (counts.failed > 0) summaryParts.push(`${counts.failed} failed`);

    const summaryMessage =
      summaryParts.length > 0 ? `Safe Pull completed: ${summaryParts.join(", ")}.` : "Safe Pull completed: Vault is in sync.";

    onProgress?.({
      phase: status === "FAIL" ? "FAILED" : "COMPLETE",
      completed: status === "FAIL" ? 0 : 1,
      total: 1,
      message: summaryMessage,
    });
    return {
      timestamp,
      branch: branchName,
      remoteCommitSha,
      status,
      results,
      counts,
      summaryMessage,
    };
  }

  /**
   * Preserves conflicting remote content under internal storage (.obsidian/vault-relay/conflicts/).
   * Guaranteed never to write or recreate root _vault-relay.
   * Registers the conflict in ConflictManager so it is reviewable in UI.
   */
  private async preserveConflictCopy(
    originalPath: string,
    rawBytes: Uint8Array,
    timestamp: number,
    localSha?: string,
    remoteSha?: string,
    remoteCommitSha?: string
  ): Promise<string> {
    const conflictPath = await StorageManager.saveConflictPayload(this.app, originalPath, rawBytes.buffer as ArrayBuffer);

    // Register conflict record in ConflictManager
    try {
      const conflictManager = new ConflictManager(this.app, this.settings, this.githubClient);
      const effRemoteSha = remoteSha || (await calculateRawGitBlobSha(rawBytes));
      let effLocalSha = localSha || "";
      if (!effLocalSha) {
        const localAbstract = this.app.vault.getAbstractFileByPath(originalPath);
        if (localAbstract instanceof TFile) {
          const localBytes = await this.app.vault.readBinary(localAbstract);
          effLocalSha = await calculateCanonicalGitBlobSha(localBytes, originalPath);
        }
      }
      await conflictManager.recordConflict(
        originalPath,
        effLocalSha,
        effRemoteSha,
        remoteCommitSha,
        undefined,
        conflictPath
      );
    } catch (recordErr) {
      console.warn(`[Vault Relay] Failed to record conflict metadata for ${originalPath}:`, recordErr);
    }

    return conflictPath;
  }
}
