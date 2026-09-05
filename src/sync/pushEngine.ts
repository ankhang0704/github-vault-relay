/**
 * Safe Push Engine for Vault Relay (Checkpoint 3: Local Obsidian -> GitHub)
 *
 * Implements the conservative Safe Push workflow:
 * - Fresh HEAD and tree re-validation before remote mutation.
 * - 3-way sync classification against fresh remote state.
 * - Pushes only eligible safe local changes (LOCAL_ONLY, LOCAL_CHANGED).
 * - Zero pushes for REMOTE_ONLY, REMOTE_CHANGED, POTENTIAL_CONFLICT, UNCHANGED.
 * - Deletion deferred (local deletions never delete remote files).
 * - 25 MiB mobile safety ceiling check.
 * - Reserved path (.obsidian, .git, _fit) and path traversal guards.
 * - Case collision detection and safety blocks.
 * - In-memory LF canonicalization for text (.md, .txt, .canvas), byte-exact for binary.
 * - Atomic Git commit creation (all files in ONE commit and ONE ref update).
 * - Optimistic concurrency via force: false (aborts if remote HEAD advanced during push).
 * - Post-push remote verification (re-fetches HEAD and tree to verify all objects).
 * - Advances local baseline state.json ONLY after verified remote success.
 */

import { App, TFile } from "obsidian";
import { GitHubClient, GitHubError } from "../github/githubClient";
import { GitHubTreeItemInput } from "../github/githubTypes";
import { VaultRelaySettings } from "../settings";
import { isCanonicalTextPath, canonicalizeTextBytes } from "./canonicalContent";
import { isOversized } from "./fileSizePolicy";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "./hashUtils";
import { isPathExcluded } from "./pathFilter";
import { detectCaseCollisions, validatePathSafety } from "./pathSafety";
import { classifySyncState } from "./syncClassifier";
import { StorageManager } from "./storageManager";
import { SyncProgressCallback } from "./progressTypes";
import {
  LocalFileEntry,
  PushExecutionReport,
  RemoteBlobEntry,
  SyncStateData,
} from "./syncTypes";
import { sanitizeErrorMessage } from "../security/redact";
import {
  acquireMutationLease,
  getActiveMutationLabel,
  MutationLease,
  ownsMutationLease,
  releaseMutationLease,
} from "./mutationCoordinator";

/**
 * Converts a Uint8Array into a base64 string safely across Node, Desktop, and Mobile.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export interface AuthorizedConflictResolution {
  path: string;
  expectedLocalSha?: string;
  expectedRemoteSha?: string;
  expectedRemoteCommitSha?: string;
  action?: "PUSH_CONTENT" | "PUSH_DELETE";
}

export class PushEngine {
  private app: App;
  private settings: VaultRelaySettings;
  private githubClient: GitHubClient;

  constructor(app: App, settings: VaultRelaySettings, githubClient: GitHubClient) {
    this.app = app;
    this.settings = settings;
    this.githubClient = githubClient;
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
   * Executes the full conservative Safe Push workflow.
   */
  public async executeSafePush(
    onProgress?: SyncProgressCallback,
    existingLease?: MutationLease
  ): Promise<PushExecutionReport> {
    const ownsExistingLease = ownsMutationLease(this.app, existingLease);
    const mutationLease = ownsExistingLease ? existingLease : acquireMutationLease(this.app, "Safe Push");
    if (!mutationLease) {
      return this.createBlockedReport(
        `Safe Push blocked because another vault mutation is in progress (${getActiveMutationLabel(this.app) || "unknown operation"}).`
      );
    }

    try {
      return await this.executeSafePushUnlocked(onProgress);
    } finally {
      if (!ownsExistingLease) releaseMutationLease(mutationLease);
    }
  }

  private createBlockedReport(summaryMessage: string): PushExecutionReport {
    return {
      timestamp: Date.now(),
      branch: this.settings.branch,
      status: "ABORTED",
      results: [],
      counts: {
        pushedCreated: 0,
        pushedUpdated: 0,
        pushedDeleted: 0,
        unchanged: 0,
        skippedRemoteOnly: 0,
        skippedRemoteChanged: 0,
        skippedConflicts: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      summaryMessage,
    };
  }

  private async executeSafePushUnlocked(onProgress?: SyncProgressCallback): Promise<PushExecutionReport> {
    const report: PushExecutionReport = {
      timestamp: Date.now(),
      branch: this.settings.branch,
      status: "PASS",
      results: [],
      counts: {
        pushedCreated: 0,
        pushedUpdated: 0,
        pushedDeleted: 0,
        unchanged: 0,
        skippedRemoteOnly: 0,
        skippedRemoteChanged: 0,
        skippedConflicts: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      summaryMessage: "",
    };

    // Offline preflight check
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      report.status = "ABORTED";
      report.summaryMessage = "Device is offline. Safe Push aborted before any remote mutation.";
      return report;
    }

    // 1. Fresh Remote Revalidation
    let branchInfo;
    try {
      branchInfo = await this.githubClient.getBranch(undefined, true);
    } catch (err) {
      report.status = "ABORTED";
      report.summaryMessage = `Failed to fetch remote branch: ${sanitizeErrorMessage(err)}`;
      return report;
    }

    const baseCommitSha = branchInfo.commit?.sha;
    report.baseCommitSha = baseCommitSha;

    if (!baseCommitSha) {
      report.status = "ABORTED";
      report.summaryMessage = "Branch has no HEAD commit. Safe Push aborted.";
      return report;
    }

    let treeResponse;
    try {
      treeResponse = await this.githubClient.getTreeRecursive(baseCommitSha);
    } catch (err) {
      report.status = "ABORTED";
      report.summaryMessage = `Failed to fetch remote tree: ${sanitizeErrorMessage(err)}`;
      return report;
    }

    if (treeResponse.truncated) {
      report.status = "ABORTED";
      report.summaryMessage = "Remote Git tree is truncated (>100,000 objects). Safe Push aborted to protect repository integrity.";
      return report;
    }

    // 2. Scan Local Vault & Load State
    const localFiles = await this.scanLocalVault();
    const state = await this.loadState();

    // 3. Build Remote Blobs Map
    const remoteFiles = new Map<string, RemoteBlobEntry>();
    for (const item of treeResponse.tree) {
      if (item.type === "blob") {
        if (!isPathExcluded(item.path, this.settings.excludedPaths)) {
          remoteFiles.set(item.path, {
            path: item.path,
            sha: item.sha,
            size: item.size,
            mode: item.mode,
          });
        }
      }
    }

    // 4. Case Collisions Check
    const allScannedPaths = Array.from(new Set([...localFiles.keys(), ...remoteFiles.keys()]));
    const caseCollisions = detectCaseCollisions(allScannedPaths);
    const collidedPathsSet = new Set<string>();
    for (const pathList of caseCollisions.values()) {
      for (const p of pathList) {
        collidedPathsSet.add(p);
      }
    }

    // 5. 3-Way Classification
    const classification = classifySyncState({
      localFiles,
      remoteBlobs: remoteFiles,
      state,
      excludedPaths: this.settings.excludedPaths,
    });

    interface EligiblePushItem {
      path: string;
      category: "LOCAL_ONLY" | "LOCAL_CHANGED" | "LOCAL_DELETED";
      localSha: string;
      localFile?: TFile;
      rawBytes?: Uint8Array;
      remotePriorSha?: string;
    }

    const eligibleItems: EligiblePushItem[] = [];

    for (const previewItem of classification.items) {
      const path = previewItem.path;
      const localEntry = localFiles.get(path);
      const remoteEntry = remoteFiles.get(path);

      // Path safety check
      if (previewItem.unsafeReason) {
        report.results.push({
          path,
          action: "SKIP_UNSAFE",
          status: "SKIPPED",
          message: `Path unsafe: ${previewItem.unsafeReason}`,
        });
        report.counts.skippedUnsafe++;
        continue;
      }

      // Case collision check
      if (collidedPathsSet.has(path)) {
        report.results.push({
          path,
          action: "SKIP_UNSAFE",
          status: "SKIPPED",
          message: "Case collision detected. Skipped to prevent ambiguous sync.",
        });
        report.counts.skippedUnsafe++;
        continue;
      }

      // Oversized check
      if (previewItem.isOversized || (localEntry && isOversized(localEntry.size))) {
        report.results.push({
          path,
          action: "SKIP_OVERSIZED",
          status: "SKIPPED",
          message: `Local file size (${localEntry?.size} bytes) exceeds Vault Relay 25 MiB safety ceiling.`,
        });
        report.counts.skippedOversized++;
        continue;
      }

      switch (previewItem.category) {
        case "LOCAL_ONLY": {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile && localEntry) {
            try {
              const arrayBuf = await this.app.vault.readBinary(file);
              const rawBytes = new Uint8Array(arrayBuf);
              eligibleItems.push({
                path,
                category: "LOCAL_ONLY",
                localSha: localEntry.sha,
                localFile: file,
                rawBytes,
              });
            } catch (err) {
              report.results.push({
                path,
                action: "PUSH_CREATE",
                status: "FAILED",
                message: `Failed to read local file: ${sanitizeErrorMessage(err)}`,
              });
              report.counts.failed++;
            }
          }
          break;
        }

        case "LOCAL_CHANGED": {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile && localEntry) {
            try {
              const arrayBuf = await this.app.vault.readBinary(file);
              const rawBytes = new Uint8Array(arrayBuf);
              eligibleItems.push({
                path,
                category: "LOCAL_CHANGED",
                localSha: localEntry.sha,
                localFile: file,
                rawBytes,
                remotePriorSha: remoteEntry?.sha,
              });
            } catch (err) {
              report.results.push({
                path,
                action: "PUSH_UPDATE",
                status: "FAILED",
                message: `Failed to read local file: ${sanitizeErrorMessage(err)}`,
              });
              report.counts.failed++;
            }
          }
          break;
        }

        case "LOCAL_DELETED": {
          eligibleItems.push({
            path,
            category: "LOCAL_DELETED",
            localSha: "",
            remotePriorSha: remoteEntry?.sha,
          });
          break;
        }

        case "DELETE_CONFLICT":
          report.results.push({
            path,
            action: "SKIP_CONFLICT",
            status: "BLOCKED_CONFLICT",
            localSha: localEntry?.sha,
            message: "Conflicting delete vs edit detected. Push skipped.",
          });
          report.counts.skippedConflicts++;
          break;

        case "REMOTE_DELETED":
          report.results.push({
            path,
            action: "SKIP_REMOTE_ONLY",
            status: "SKIPPED",
            message: "Remote deletion detected. Push skipped.",
          });
          report.counts.skippedRemoteOnly++;
          break;

        case "DELETED":
          report.results.push({
            path,
            action: "SKIP_UNCHANGED",
            status: "SKIPPED",
            message: "File deleted on both sides. Cleaned from baseline.",
          });
          report.counts.unchanged++;
          break;

        case "POTENTIAL_CONFLICT":
          report.results.push({
            path,
            action: "SKIP_CONFLICT",
            status: "BLOCKED_CONFLICT",
            localSha: localEntry?.sha,
            message: "Conflicting remote change detected. Local note was NOT pushed to protect data.",
          });
          report.counts.skippedConflicts++;
          break;

        case "REMOTE_CHANGED":
          report.results.push({
            path,
            action: "SKIP_REMOTE_CHANGED",
            status: "SKIPPED",
            message: "Remote note was updated on GitHub. Push skipped.",
          });
          report.counts.skippedRemoteChanged++;
          break;

        case "REMOTE_ONLY":
          report.results.push({
            path,
            action: "SKIP_REMOTE_ONLY",
            status: "SKIPPED",
            message: "Remote-only note on GitHub. Push skipped.",
          });
          report.counts.skippedRemoteOnly++;
          break;

        case "UNCHANGED":
          report.results.push({
            path,
            action: "SKIP_UNCHANGED",
            status: "SKIPPED",
            localSha: localEntry?.sha,
            remoteBlobSha: remoteEntry?.sha,
          });
          report.counts.unchanged++;
          break;
      }
    }

    // 6. Check if anything is eligible to push
    if (eligibleItems.length === 0) {
      // Phase 10: Auto-heal/converge baseline for UNCHANGED files missing from state.files (e.g. from previous false-negative verification)
      let healedCount = 0;
      for (const item of classification.items) {
        if (item.category === "UNCHANGED" && item.localSha && item.remoteSha && item.localSha === item.remoteSha) {
          if (!state.files[item.path] || state.files[item.path].remoteSha !== item.remoteSha) {
            state.files[item.path] = {
              localSha: item.localSha,
              remoteSha: item.remoteSha,
              syncedAt: Date.now(),
            };
            healedCount++;
          }
        }
      }
      if (healedCount > 0) {
        state.lastSyncedCommitSha = baseCommitSha;
        state.lastSyncedAt = Date.now();
        try {
          await this.saveState(state);
        } catch (saveErr) {
          report.status = "PASS_WITH_WARNINGS";
          report.counts.failed++;
          report.summaryMessage = `Repository is unchanged, but local sync state could not be saved: ${sanitizeErrorMessage(saveErr)}. A fresh scan is required.`;
          onProgress?.({ phase: "FAILED", completed: 0, total: 1, message: report.summaryMessage });
          return report;
        }
      }

      if (report.counts.skippedConflicts > 0 || report.counts.skippedOversized > 0 || report.counts.skippedUnsafe > 0) {
        report.status = "PASS_WITH_WARNINGS";
      } else {
        report.status = "PASS";
      }
      report.summaryMessage = "No local changes eligible for Safe Push. Repository is up to date.";
      return report;
    }

    // 7. Upload Blobs to GitHub Git Data API
    const treeItemsToPush: GitHubTreeItemInput[] = [];
    interface UploadedFileRecord {
      path: string;
      localSha: string;
      remoteBlobSha: string;
      action: "PUSH_CREATE" | "PUSH_UPDATE" | "PUSH_DELETE";
    }
    const uploadedRecords: UploadedFileRecord[] = [];

    onProgress?.({ phase: "PLANNING", completed: 0, total: eligibleItems.length, message: "Planning safe push..." });
    let uploadIndex = 0;
    for (const item of eligibleItems) {
      uploadIndex++;
      onProgress?.({ phase: "UPLOADING", completed: uploadIndex, total: eligibleItems.length, currentPath: item.path });

      if (item.category === "LOCAL_DELETED") {
        treeItemsToPush.push({
          path: item.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
        uploadedRecords.push({
          path: item.path,
          localSha: "",
          remoteBlobSha: "",
          action: "PUSH_DELETE",
        });
        continue;
      }

      try {
        let bytesToUpload = item.rawBytes!;
        let expectedSha: string;

        if (isCanonicalTextPath(item.path)) {
          bytesToUpload = canonicalizeTextBytes(bytesToUpload);
          expectedSha = await calculateRawGitBlobSha(bytesToUpload);
        } else {
          expectedSha = await calculateRawGitBlobSha(bytesToUpload);
        }

        const base64Content = uint8ArrayToBase64(bytesToUpload);
        const blobResp = await this.githubClient.createBlob(base64Content, "base64");

        if (blobResp.sha.toLowerCase() !== expectedSha.toLowerCase()) {
          throw new GitHubError(
            `Cryptographic SHA mismatch during blob upload for ${item.path}. Expected ${expectedSha}, received ${blobResp.sha}.`
          );
        }

        treeItemsToPush.push({
          path: item.path,
          mode: "100644",
          type: "blob",
          sha: blobResp.sha,
        });

        const actionType = item.category === "LOCAL_ONLY" ? "PUSH_CREATE" : "PUSH_UPDATE";
        uploadedRecords.push({
          path: item.path,
          localSha: item.localSha,
          remoteBlobSha: blobResp.sha,
          action: actionType,
        });
      } catch (uploadErr) {
        const safeMsg = sanitizeErrorMessage(uploadErr);
        report.status = "FAIL";
        report.summaryMessage = `Blob upload failed for ${item.path}: ${safeMsg}`;
        report.results.push({
          path: item.path,
          action: item.category === "LOCAL_ONLY" ? "PUSH_CREATE" : "PUSH_UPDATE",
          status: "FAILED",
          message: safeMsg,
        });
        report.counts.failed++;
        return report;
      }
    }

    onProgress?.({ phase: "CREATING_TREE", completed: 0, total: 1, message: "Creating Git tree..." });
    // 8. Create Git Tree (on top of baseCommit tree)
    let newTreeResp;
    try {
      newTreeResp = await this.githubClient.createTree(treeItemsToPush, treeResponse.sha);
    } catch (treeErr) {
      const safeMsg = sanitizeErrorMessage(treeErr);
      report.status = "FAIL";
      report.summaryMessage = `Tree creation failed: ${safeMsg}`;
      return report;
    }

    onProgress?.({ phase: "CREATING_COMMIT", completed: 0, total: 1, message: "Creating Git commit..." });
    // 9. Create Single Git Commit
    let newCommitResp;
    const commitCount = uploadedRecords.length;
    const commitMsg = `Vault Relay safe push: ${commitCount} file${commitCount > 1 ? "s" : ""}`;
    try {
      newCommitResp = await this.githubClient.createCommit(commitMsg, newTreeResp.sha, [baseCommitSha]);
    } catch (commitErr) {
      const safeMsg = sanitizeErrorMessage(commitErr);
      report.status = "FAIL";
      report.summaryMessage = `Commit creation failed: ${safeMsg}`;
      return report;
    }

    const newCommitSha = newCommitResp.sha;
    report.newCommitSha = newCommitSha;

    // Local bytes may change while immutable Git objects are uploaded. Re-read every
    // eligible file before moving the branch ref; stale objects may remain dangling,
    // but unreviewed local bytes must never be committed.
    for (const item of eligibleItems) {
      if (item.category === "LOCAL_DELETED") {
        const currentFile = this.app.vault.getAbstractFileByPath(item.path);
        if (currentFile) {
          report.status = "ABORTED";
          report.summaryMessage = `Local file was recreated during Push: ${item.path}. Branch update was not attempted.`;
          return report;
        }
        continue;
      }
      const currentFile = this.app.vault.getAbstractFileByPath(item.path);
      if (!(currentFile instanceof TFile)) {
        report.status = "ABORTED";
        report.summaryMessage = `Local file changed or disappeared during Push: ${item.path}. Branch update was not attempted.`;
        return report;
      }
      const currentBytes = await this.app.vault.readBinary(currentFile);
      const currentSha = await calculateCanonicalGitBlobSha(currentBytes, item.path);
      if (currentSha.toLowerCase() !== item.localSha.toLowerCase()) {
        report.status = "ABORTED";
        report.summaryMessage = `Local file changed during Push: ${item.path}. Branch update was not attempted.`;
        return report;
      }
    }

    onProgress?.({ phase: "UPDATING_REF", completed: 0, total: 1, message: "Updating remote branch..." });
    // 10. Optimistic Concurrency Ref Update (force: false)
    let patchRefResp;
    try {
      patchRefResp = await this.githubClient.updateBranchRef(this.settings.branch, newCommitSha, false);
      console.info(`[Vault Relay:SafePush:T4] PATCH ref successful: ${patchRefResp.object?.sha}`);
    } catch (refErr) {
      const safeMsg = sanitizeErrorMessage(refErr);
      let recoveredLostResponse = false;
      const responseWasAmbiguous = !(refErr instanceof GitHubError) || refErr.status === undefined || refErr.status === 0;
      if (responseWasAmbiguous) {
        try {
          const authoritativeRef = await this.githubClient.getBranchRef(this.settings.branch);
          recoveredLostResponse =
            authoritativeRef.object?.sha?.toLowerCase() === newCommitSha.toLowerCase();
        } catch {
          // The update remains uncertain; keep the local baseline unchanged.
        }
      }
      if (!recoveredLostResponse) {
        report.status = "ABORTED";
        report.summaryMessage = `Optimistic concurrency check aborted ref update or could not confirm it: ${safeMsg}`;
        return report;
      }
      console.warn("[Vault Relay:SafePush:T4] PATCH response was lost, but the authoritative branch ref confirms the new commit.");
    }

    // 11. Authoritative Post-Push Verification (with bounded retry for edge replication)
    try {
      let verifiedHeadSha: string | undefined;
      let lastObservedSha: string | undefined;
      const maxRetries = 3;
      const delays = [500, 1000, 2000];

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        onProgress?.({ phase: "VERIFYING_REMOTE", completed: attempt, total: maxRetries + 1, message: "Verifying remote ref..." });
        try {
          const refResp = await this.githubClient.getBranchRef(this.settings.branch);
          lastObservedSha = refResp.object?.sha;
          console.info(`[Vault Relay:SafePush:T6] Verification attempt #${attempt + 1}: returned SHA ${lastObservedSha}`);
          if (refResp.object?.sha?.toLowerCase() === newCommitSha.toLowerCase()) {
            verifiedHeadSha = refResp.object.sha;
            break;
          }
        } catch {
          // Fallback to getBranch bypassing cache
          try {
            const freshBranch = await this.githubClient.getBranch(this.settings.branch, true);
            lastObservedSha = freshBranch.commit?.sha;
            console.info(`[Vault Relay:SafePush:T6-fallback] Verification attempt #${attempt + 1}: returned SHA ${lastObservedSha}`);
            if (freshBranch.commit?.sha?.toLowerCase() === newCommitSha.toLowerCase()) {
              verifiedHeadSha = freshBranch.commit.sha;
              break;
            }
          } catch {
            // continue bounded retry
          }
        }

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        }
      }

      if (!verifiedHeadSha) {
        throw new GitHubError(
          `Authoritative Git branch ref returned (${lastObservedSha || "unknown"}) instead of new commit SHA (${newCommitSha}) after ${maxRetries + 1} verification attempts.`
        );
      }

      const freshTree = await this.githubClient.getTreeRecursive(newCommitSha);
      const remoteTreeMap = new Map<string, string>();
      for (const item of freshTree.tree) {
        if (item.type === "blob") {
          remoteTreeMap.set(item.path, item.sha);
        }
      }

      for (const rec of uploadedRecords) {
        if (rec.action === "PUSH_DELETE") {
          if (remoteTreeMap.has(rec.path)) {
            throw new GitHubError(
              `Post-push verification failed: Deleted file ${rec.path} still present in remote tree.`
            );
          }
          continue;
        }

        const verifiedRemoteSha = remoteTreeMap.get(rec.path);
        if (verifiedRemoteSha?.toLowerCase() !== rec.remoteBlobSha.toLowerCase()) {
          throw new GitHubError(
            `Post-push verification failed: Remote tree blob SHA for ${rec.path} (${verifiedRemoteSha}) does not match uploaded blob SHA (${rec.remoteBlobSha}).`
          );
        }
      }
    } catch (verifyErr) {
      const safeMsg = sanitizeErrorMessage(verifyErr);
      report.status = "FAIL";
      report.summaryMessage = `Post-push verification failed: ${safeMsg}. Baseline was not updated.`;
      return report;
    }

    // 12. Advance Local Baseline State (Only after verified remote success)
    state.lastSyncedCommitSha = newCommitSha;
    state.lastSyncedAt = Date.now();

    for (const rec of uploadedRecords) {
      if (rec.action === "PUSH_DELETE") {
        delete state.files[rec.path];
        report.results.push({
          path: rec.path,
          action: "PUSH_DELETE",
          status: "SUCCESS",
        });
        report.counts.pushedDeleted++;
        continue;
      }

      state.files[rec.path] = {
        localSha: rec.localSha,
        remoteSha: rec.remoteBlobSha,
        syncedAt: Date.now(),
      };

      report.results.push({
        path: rec.path,
        action: rec.action,
        status: "SUCCESS",
        localSha: rec.localSha,
        remoteBlobSha: rec.remoteBlobSha,
      });

      if (rec.action === "PUSH_CREATE") {
        report.counts.pushedCreated++;
      } else {
        report.counts.pushedUpdated++;
      }
    }

    try {
      await this.saveState(state);
    } catch (stateSaveErr) {
      report.status = "PASS_WITH_WARNINGS";
      report.counts.failed++;
      report.summaryMessage = `Remote commit ${newCommitSha.substring(0, 7)} was verified, but local sync state could not be saved: ${sanitizeErrorMessage(stateSaveErr)}. A fresh scan is required.`;
      onProgress?.({ phase: "FAILED", completed: 0, total: 1, message: report.summaryMessage });
      return report;
    }

    if (report.counts.skippedConflicts > 0 || report.counts.skippedOversized > 0 || report.counts.skippedUnsafe > 0) {
      report.status = "PASS_WITH_WARNINGS";
      report.summaryMessage = `Safe Push completed with warnings. Pushed ${uploadedRecords.length} file(s) into commit ${newCommitSha.substring(0, 7)}.`;
    } else {
      report.status = "PASS";
      report.summaryMessage = `Safe Push completed successfully. Pushed ${uploadedRecords.length} file(s) into commit ${newCommitSha.substring(0, 7)}.`;
    }

    onProgress?.({ phase: "COMPLETE", completed: 1, total: 1, message: "Push complete." });
    return report;
  }

  /**
   * Narrowly scoped safe push authorized for resolving a single specific conflict note.
   *
   * Crucial invariants:
   * - Does NOT modify or bypass normal PushEngine conflict blocking for other files.
   * - Revalidates current local file SHA matches reviewed expectedLocalSha (prevents LOCAL RACE).
   * - Revalidates remote branch HEAD matches reviewed expectedRemoteCommitSha (prevents REMOTE RACE).
   * - Revalidates remote tree blob SHA matches reviewed expectedRemoteSha (prevents REMOTE RACE).
   * - Pushes ONLY the single authorized conflict path; no other vault files are mutated on remote.
   * - Uses force: false to prevent clobbering concurrent remote commits.
   * - Authoritatively verifies remote ref and tree blob after push before updating baseline.
   * - Never fakes or modifies baseline state beforehand.
   */
  public async executeAuthorizedConflictPush(
    resolution: AuthorizedConflictResolution,
    onProgress?: SyncProgressCallback,
    existingLease?: MutationLease
  ): Promise<PushExecutionReport> {
    const ownsExistingLease = ownsMutationLease(this.app, existingLease);
    const mutationLease = ownsExistingLease ? existingLease : acquireMutationLease(this.app, "Keep Local conflict resolution");
    if (!mutationLease) {
      return this.createBlockedReport(
        `Conflict resolution blocked because another vault mutation is in progress (${getActiveMutationLabel(this.app) || "unknown operation"}).`
      );
    }

    try {
      return await this.executeAuthorizedConflictPushUnlocked(resolution, onProgress);
    } finally {
      if (!ownsExistingLease) releaseMutationLease(mutationLease);
    }
  }

  private async executeAuthorizedConflictPushUnlocked(
    resolution: AuthorizedConflictResolution,
    onProgress?: SyncProgressCallback
  ): Promise<PushExecutionReport> {
    const report: PushExecutionReport = {
      timestamp: Date.now(),
      branch: this.settings.branch,
      status: "PASS",
      summaryMessage: "",
      counts: {
        pushedCreated: 0,
        pushedUpdated: 0,
        pushedDeleted: 0,
        unchanged: 0,
        skippedRemoteOnly: 0,
        skippedRemoteChanged: 0,
        skippedConflicts: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      results: [],
    };

    const isDeletionResolution = resolution.action === "PUSH_DELETE";

    // 1. Offline preflight check
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      report.status = "ABORTED";
      report.summaryMessage = "Device is offline. Push aborted before any remote mutation.";
      return report;
    }

    // 2. Path safety and exclusion checks
    const safety = validatePathSafety(resolution.path, this.settings.excludedPaths);
    if (!safety.valid) {
      report.status = "FAIL";
      report.summaryMessage = `Conflict path validation failed: ${safety.reason}`;
      return report;
    }

    if (isPathExcluded(resolution.path, this.settings.excludedPaths)) {
      report.status = "FAIL";
      report.summaryMessage = `Conflict path is excluded by settings: ${resolution.path}`;
      return report;
    }

    // 3. Remote revalidation (Guards against REMOTE RACE)
    onProgress?.({ phase: "PLANNING", completed: 0, total: 1, message: "Revalidating remote branch..." });
    let branchInfo;
    try {
      branchInfo = await this.githubClient.getBranch(this.settings.branch, true);
    } catch (branchErr) {
      const safeMsg = sanitizeErrorMessage(branchErr);
      report.status = "FAIL";
      report.summaryMessage = `Failed to fetch remote branch: ${safeMsg}`;
      return report;
    }

    const baseCommitSha = branchInfo.commit.sha;
    report.baseCommitSha = baseCommitSha;

    if (resolution.expectedRemoteCommitSha && baseCommitSha.toLowerCase() !== resolution.expectedRemoteCommitSha.toLowerCase()) {
      report.status = "ABORTED";
      report.summaryMessage = `Remote branch changed concurrently since conflict was reviewed (reviewed commit ${resolution.expectedRemoteCommitSha.slice(0, 7)}, current ${baseCommitSha.slice(0, 7)}). Push blocked.`;
      return report;
    }

    // Fetch base commit tree
    let baseTreeResp;
    try {
      baseTreeResp = await this.githubClient.getTreeRecursive(baseCommitSha);
    } catch (treeErr) {
      const safeMsg = sanitizeErrorMessage(treeErr);
      report.status = "FAIL";
      report.summaryMessage = `Failed to fetch base tree: ${safeMsg}`;
      return report;
    }

    if (resolution.expectedRemoteSha) {
      const remoteTreeItem = baseTreeResp.tree.find((item) => item.path === resolution.path);
      const currentRemoteSha = remoteTreeItem?.sha;
      if (currentRemoteSha?.toLowerCase() !== resolution.expectedRemoteSha.toLowerCase()) {
        report.status = "ABORTED";
        report.summaryMessage = `Remote file changed concurrently since conflict was reviewed (reviewed ${resolution.expectedRemoteSha.slice(0, 7)}, current ${currentRemoteSha ? currentRemoteSha.slice(0, 7) : "missing"}). Push blocked.`;
        return report;
      }
    } else if (resolution.expectedRemoteSha === "") {
      const remoteTreeItem = baseTreeResp.tree.find((item) => item.path === resolution.path);
      if (remoteTreeItem) {
        report.status = "ABORTED";
        report.summaryMessage = `Remote file was recreated concurrently since conflict was reviewed. Push blocked.`;
        return report;
      }
    }

    let currentLocalSha = "";
    let uploadedBlobSha: string | null = null;

    if (isDeletionResolution) {
      // For authorized deletion, local file must be absent
      const file = this.app.vault.getAbstractFileByPath(resolution.path);
      if (file) {
        report.status = "FAIL";
        report.summaryMessage = `Cannot push deletion: local file still exists at ${resolution.path}.`;
        return report;
      }
    } else {
      // 4. Local file revalidation (Guards against LOCAL RACE)
      const file = this.app.vault.getAbstractFileByPath(resolution.path);
      if (!file || !(file instanceof TFile)) {
        report.status = "FAIL";
        report.summaryMessage = `Local file no longer exists or is not a file: ${resolution.path}. Safe Push aborted.`;
        return report;
      }

      let rawBytes: Uint8Array;
      try {
        const arrayBuffer = await this.app.vault.readBinary(file);
        rawBytes = new Uint8Array(arrayBuffer);
      } catch (err) {
        report.status = "FAIL";
        report.summaryMessage = `Failed to read local file ${resolution.path}: ${sanitizeErrorMessage(err)}`;
        return report;
      }

      if (isOversized(rawBytes.byteLength)) {
        report.status = "FAIL";
        report.summaryMessage = `Conflict file exceeds mobile size limit (25 MiB): ${resolution.path}`;
        return report;
      }

      currentLocalSha = await calculateCanonicalGitBlobSha(rawBytes, resolution.path);
      if (resolution.expectedLocalSha && currentLocalSha.toLowerCase() !== resolution.expectedLocalSha.toLowerCase()) {
        report.status = "FAIL";
        report.summaryMessage = `Local file changed concurrently since conflict was reviewed (reviewed ${resolution.expectedLocalSha.slice(0, 7)}, current ${currentLocalSha.slice(0, 7)}). Push blocked to prevent pushing unreviewed changes.`;
        return report;
      }

      // 5. Upload blob for the single authorized conflict file
      onProgress?.({ phase: "UPLOADING", completed: 1, total: 1, currentPath: resolution.path });
      let bytesToUpload = rawBytes;
      if (isCanonicalTextPath(resolution.path)) {
        bytesToUpload = canonicalizeTextBytes(bytesToUpload);
      }
      const expectedBlobSha = await calculateRawGitBlobSha(bytesToUpload);
      const base64Content = uint8ArrayToBase64(bytesToUpload);

      let blobResp;
      try {
        blobResp = await this.githubClient.createBlob(base64Content, "base64");
      } catch (blobErr) {
        const safeMsg = sanitizeErrorMessage(blobErr);
        report.status = "FAIL";
        report.summaryMessage = `Blob upload failed for ${resolution.path}: ${safeMsg}`;
        return report;
      }

      if (blobResp.sha.toLowerCase() !== expectedBlobSha.toLowerCase()) {
        report.status = "FAIL";
        report.summaryMessage = `Cryptographic SHA mismatch during blob upload for ${resolution.path}. Expected ${expectedBlobSha}, received ${blobResp.sha}.`;
        return report;
      }
      uploadedBlobSha = blobResp.sha;
    }

    // 6. Create Git tree on top of baseTreeResp.sha updating ONLY the authorized path
    onProgress?.({ phase: "CREATING_TREE", completed: 0, total: 1, message: "Creating Git tree..." });
    let newTreeResp;
    const treeItemsToPush: GitHubTreeItemInput[] = [
      {
        path: resolution.path,
        mode: "100644",
        type: "blob",
        sha: uploadedBlobSha, // null if deletion
      },
    ];

    try {
      newTreeResp = await this.githubClient.createTree(treeItemsToPush, baseTreeResp.sha);
    } catch (treeErr) {
      const safeMsg = sanitizeErrorMessage(treeErr);
      report.status = "FAIL";
      report.summaryMessage = `Tree creation failed: ${safeMsg}`;
      return report;
    }

    // 7. Create Single Git commit with parent = verified baseCommitSha
    onProgress?.({ phase: "CREATING_COMMIT", completed: 0, total: 1, message: "Creating Git commit..." });
    const commitMsg = isDeletionResolution
      ? `Vault Relay safe conflict resolution: Delete remote for ${resolution.path}`
      : `Vault Relay safe conflict resolution: Keep local for ${resolution.path}`;
    let newCommitResp;
    try {
      newCommitResp = await this.githubClient.createCommit(commitMsg, newTreeResp.sha, [baseCommitSha]);
    } catch (commitErr) {
      const safeMsg = sanitizeErrorMessage(commitErr);
      report.status = "FAIL";
      report.summaryMessage = `Commit creation failed: ${safeMsg}`;
      return report;
    }

    const newCommitSha = newCommitResp.sha;
    report.newCommitSha = newCommitSha;

    if (isDeletionResolution) {
      if (this.app.vault.getAbstractFileByPath(resolution.path)) {
        report.status = "ABORTED";
        report.summaryMessage = `Local file was recreated during conflict deletion: ${resolution.path}. Branch update was not attempted.`;
        return report;
      }
    } else {
      const latestFile = this.app.vault.getAbstractFileByPath(resolution.path);
      if (!(latestFile instanceof TFile)) {
        report.status = "ABORTED";
        report.summaryMessage = `Local file changed or disappeared during conflict resolution: ${resolution.path}. Branch update was not attempted.`;
        return report;
      }
      const latestBytes = await this.app.vault.readBinary(latestFile);
      const latestLocalSha = await calculateCanonicalGitBlobSha(latestBytes, resolution.path);
      if (latestLocalSha.toLowerCase() !== currentLocalSha.toLowerCase()) {
        report.status = "ABORTED";
        report.summaryMessage = `Local file changed during conflict resolution: ${resolution.path}. Branch update was not attempted.`;
        return report;
      }
    }

    // 8. Optimistic Concurrency Ref Update (force: false is MANDATORY)
    onProgress?.({ phase: "UPDATING_REF", completed: 0, total: 1, message: "Updating remote branch..." });
    try {
      await this.githubClient.updateBranchRef(this.settings.branch, newCommitSha, false);
      console.info(`[Vault Relay:AuthorizedPush] PATCH ref successful: ${newCommitSha}`);
    } catch (refErr) {
      const safeMsg = sanitizeErrorMessage(refErr);
      report.status = "ABORTED";
      report.summaryMessage = `Optimistic concurrency check aborted ref update (remote branch HEAD was modified during push): ${safeMsg}`;
      return report;
    }

    // 9. Authoritative Post-Push Verification
    try {
      let verifiedHeadSha: string | undefined;
      let lastObservedSha: string | undefined;
      const maxRetries = 3;
      const delays = [500, 1000, 2000];

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        onProgress?.({ phase: "VERIFYING_REMOTE", completed: attempt, total: maxRetries + 1, message: "Verifying remote ref..." });
        try {
          const refResp = await this.githubClient.getBranchRef(this.settings.branch);
          lastObservedSha = refResp.object?.sha;
          if (refResp.object?.sha?.toLowerCase() === newCommitSha.toLowerCase()) {
            verifiedHeadSha = refResp.object.sha;
            break;
          }
        } catch {
          try {
            const freshBranch = await this.githubClient.getBranch(this.settings.branch, true);
            lastObservedSha = freshBranch.commit?.sha;
            if (freshBranch.commit?.sha?.toLowerCase() === newCommitSha.toLowerCase()) {
              verifiedHeadSha = freshBranch.commit.sha;
              break;
            }
          } catch {
            // continue bounded retry
          }
        }

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        }
      }

      if (!verifiedHeadSha) {
        throw new GitHubError(
          `Authoritative Git branch ref returned (${lastObservedSha || "unknown"}) instead of new commit SHA (${newCommitSha}) after ${maxRetries + 1} verification attempts.`
        );
      }

      const freshTree = await this.githubClient.getTreeRecursive(newCommitSha);
      if (isDeletionResolution) {
        const stillInTree = freshTree.tree.some((i) => i.path === resolution.path);
        if (stillInTree) {
          throw new GitHubError(
            `Post-push verification failed: Deleted file ${resolution.path} still present in remote tree.`
          );
        }
      } else {
        const verifiedRemoteItem = freshTree.tree.find((i) => i.path === resolution.path && i.type === "blob");
        if (verifiedRemoteItem?.sha?.toLowerCase() !== uploadedBlobSha?.toLowerCase()) {
          throw new GitHubError(
            `Post-push verification failed: Remote tree blob SHA for ${resolution.path} (${verifiedRemoteItem?.sha}) does not match uploaded blob SHA (${uploadedBlobSha}).`
          );
        }
      }
    } catch (verifyErr) {
      const safeMsg = sanitizeErrorMessage(verifyErr);
      report.status = "FAIL";
      report.summaryMessage = `Post-push verification failed: ${safeMsg}. Baseline was not updated.`;
      return report;
    }

    // 10. Advance Local Baseline State ONLY AFTER verified remote success
    const state = await this.loadState();
    state.lastSyncedCommitSha = newCommitSha;
    state.lastSyncedAt = Date.now();

    if (isDeletionResolution) {
      delete state.files[resolution.path];
    } else {
      state.files[resolution.path] = {
        localSha: currentLocalSha,
        remoteSha: uploadedBlobSha!,
        syncedAt: Date.now(),
      };
    }

    try {
      await this.saveState(state);
    } catch (saveErr) {
      report.status = "PASS_WITH_WARNINGS";
      report.counts.failed++;
      report.summaryMessage = `Remote conflict resolution was verified, but local sync state could not be saved: ${sanitizeErrorMessage(saveErr)}. Conflict evidence was preserved.`;
      onProgress?.({ phase: "FAILED", completed: 0, total: 1, message: report.summaryMessage });
      return report;
    }

    report.status = "PASS";
    if (isDeletionResolution) {
      report.summaryMessage = `Successfully pushed authorized deletion for ${resolution.path}.`;
      report.results.push({
        path: resolution.path,
        action: "PUSH_DELETE",
        status: "SUCCESS",
      });
      report.counts.pushedDeleted = 1;
    } else {
      report.summaryMessage = `Successfully pushed authorized conflict resolution for ${resolution.path}.`;
      report.results.push({
        path: resolution.path,
        action: "PUSH_UPDATE",
        status: "SUCCESS",
        localSha: currentLocalSha,
        remoteBlobSha: uploadedBlobSha!,
      });
      report.counts.pushedUpdated = 1;
    }
    onProgress?.({ phase: "COMPLETE", completed: 1, total: 1, message: "Authorized conflict push complete." });
    return report;
  }
}
