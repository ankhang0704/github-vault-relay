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
 * - Reserved path (.obsidian, .git, _fit, _vault-relay) and path traversal guards.
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
import { detectCaseCollisions } from "./pathSafety";
import { classifySyncState } from "./syncClassifier";
import { deserializeState, serializeState, STATE_FILE_PATH } from "./syncState";
import {
  LocalFileEntry,
  PushExecutionReport,
  RemoteBlobEntry,
  SyncStateData,
} from "./syncTypes";
import { sanitizeErrorMessage } from "../security/redact";

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
   * Loads sync state from _vault-relay/state.json.
   */
  public async loadState(): Promise<SyncStateData> {
    try {
      const stateFile = this.app.vault.getAbstractFileByPath(STATE_FILE_PATH);
      if (stateFile instanceof TFile) {
        const content = await this.app.vault.read(stateFile);
        return deserializeState(content);
      }
    } catch {
      // Fallback
    }
    return deserializeState("");
  }

  /**
   * Saves updated sync state to _vault-relay/state.json.
   */
  public async saveState(state: SyncStateData): Promise<void> {
    const content = serializeState(state);
    const existing = this.app.vault.getAbstractFileByPath(STATE_FILE_PATH);

    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      // Ensure parent directory exists
      const lastSlash = STATE_FILE_PATH.lastIndexOf("/");
      if (lastSlash !== -1) {
        const folder = STATE_FILE_PATH.substring(0, lastSlash);
        if (!this.app.vault.getAbstractFileByPath(folder)) {
          try {
            await this.app.vault.createFolder(folder);
          } catch {
            // continue
          }
        }
      }
      await this.app.vault.create(STATE_FILE_PATH, content);
    }
  }

  /**
   * Executes the full conservative Safe Push workflow.
   */
  public async executeSafePush(): Promise<PushExecutionReport> {
    const report: PushExecutionReport = {
      timestamp: Date.now(),
      branch: this.settings.branch,
      status: "PASS",
      results: [],
      counts: {
        pushedCreated: 0,
        pushedUpdated: 0,
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
      branchInfo = await this.githubClient.getBranch();
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
      category: "LOCAL_ONLY" | "LOCAL_CHANGED";
      localSha: string;
      localFile: TFile;
      rawBytes: Uint8Array;
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
      action: "PUSH_CREATE" | "PUSH_UPDATE";
    }
    const uploadedRecords: UploadedFileRecord[] = [];

    for (const item of eligibleItems) {
      try {
        let bytesToUpload = item.rawBytes;
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

    // 10. Optimistic Concurrency Ref Update (force: false)
    try {
      await this.githubClient.updateBranchRef(this.settings.branch, newCommitSha, false);
    } catch (refErr) {
      const safeMsg = sanitizeErrorMessage(refErr);
      // If remote HEAD changed during push (e.g. 422 Unprocessable Entity)
      report.status = "ABORTED";
      report.summaryMessage = `Optimistic concurrency check aborted ref update (remote branch HEAD was modified during push): ${safeMsg}`;
      return report;
    }

    // 11. Authoritative Post-Push Verification (with bounded retry for edge replication)
    try {
      let verifiedHeadSha: string | undefined;
      const maxRetries = 3;
      const delays = [300, 600, 1200];

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const refResp = await this.githubClient.getBranchRef(this.settings.branch);
          if (refResp.object?.sha?.toLowerCase() === newCommitSha.toLowerCase()) {
            verifiedHeadSha = refResp.object.sha;
            break;
          }
        } catch {
          // Fallback to getBranch if git/ref endpoint is not directly available
          try {
            const freshBranch = await this.githubClient.getBranch(this.settings.branch);
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
          `Post-push verification failed: Authoritative Git branch ref does not match new commit SHA (${newCommitSha}) after verification budget.`
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
      console.warn("[Vault Relay] Failed to save state.json after successful push:", stateSaveErr);
    }

    if (report.counts.skippedConflicts > 0 || report.counts.skippedOversized > 0 || report.counts.skippedUnsafe > 0) {
      report.status = "PASS_WITH_WARNINGS";
      report.summaryMessage = `Safe Push completed with warnings. Pushed ${uploadedRecords.length} file(s) into commit ${newCommitSha.substring(0, 7)}.`;
    } else {
      report.status = "PASS";
      report.summaryMessage = `Safe Push completed successfully. Pushed ${uploadedRecords.length} file(s) into commit ${newCommitSha.substring(0, 7)}.`;
    }

    return report;
  }
}
