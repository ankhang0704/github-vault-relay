/**
 * Conflict Manager for Vault Relay (C4)
 *
 * Manages conflict metadata, snapshot retrieval, and resolution actions:
 * - Keep Local: revalidates remote, then safe-pushes local version to GitHub.
 * - Use Remote: verifies local has not changed, then safely overwrites with remote content.
 * - Keep Both: preserves local note untouched and saves remote version as a conflict copy.
 */

import { App, TFile } from "obsidian";
import { GitHubClient } from "../github/githubClient";
import { VaultRelaySettings } from "../settings";
import { StorageManager } from "./storageManager";
import { calculateCanonicalGitBlobSha } from "./hashUtils";
import { PushEngine } from "./pushEngine";
import { SyncPreviewReport } from "./syncTypes";
import { sanitizeErrorMessage } from "../security/redact";
import { prepareContentBytesForPath } from "./canonicalContent";
import { validatePathSafety } from "./pathSafety";
import {
  acquireMutationLease,
  getActiveMutationLabel,
  releaseMutationLease,
} from "./mutationCoordinator";

export interface ConflictRecord {
  id: string;
  path: string;
  localSha: string;
  remoteSha: string;
  remoteCommitSha?: string;
  baseSha?: string;
  detectedAt: number;
  snapshotPath?: string;
  conflictType?: "CONTENT" | "DELETE_LOCAL_REMOTE_MODIFIED" | "DELETE_REMOTE_LOCAL_MODIFIED";
}

export class ConflictManager {
  private app: App;
  private settings: VaultRelaySettings;
  private githubClient: GitHubClient;
  private inFlightResolutions: Set<string> = new Set();
  private resolvedRecordIds: Set<string> = new Set();

  constructor(app: App, settings: VaultRelaySettings, githubClient: GitHubClient) {
    this.app = app;
    this.settings = settings;
    this.githubClient = githubClient;
  }

  public isResolving(path: string): boolean {
    return this.inFlightResolutions.has(path);
  }

  private markResolved(id: string | undefined): void {
    if (!id) return;
    this.resolvedRecordIds.add(id);
    while (this.resolvedRecordIds.size > 256) {
      const oldest = this.resolvedRecordIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.resolvedRecordIds.delete(oldest);
    }
  }

  private async revalidateRemoteRecord(record: ConflictRecord): Promise<string | undefined> {
    try {
      const branch = await this.githubClient.getBranch(this.settings.branch, true);
      if (
        record.remoteCommitSha &&
        branch.commit.sha.toLowerCase() !== record.remoteCommitSha.toLowerCase()
      ) {
        return "Remote branch changed since this conflict was reviewed. Refresh conflicts before resolving.";
      }

      const tree = await this.githubClient.getTreeRecursive(branch.commit.sha);
      if (tree.truncated) {
        return "Remote tree is truncated. Conflict resolution is blocked for safety.";
      }
      if (record.remoteSha) {
        const remote = tree.tree.find((item) => item.type === "blob" && item.path === record.path);
        if (!remote || remote.sha.toLowerCase() !== record.remoteSha.toLowerCase()) {
          return "Remote file changed since this conflict was reviewed. Refresh conflicts before resolving.";
        }
      } else {
        const remote = tree.tree.find((item) => item.path === record.path);
        if (remote) {
          return "Remote file was recreated since this conflict was reviewed. Refresh conflicts before resolving.";
        }
      }
      return undefined;
    } catch (err) {
      return `Could not revalidate the remote file: ${sanitizeErrorMessage(err)}`;
    }
  }

  private getMetadataPath(): string {
    return `${StorageManager.getPluginStorageDir(this.app)}/conflicts_meta.json`;
  }

  /**
   * Loads all active conflict records from internal storage.
   */
  public async loadConflictRecords(): Promise<ConflictRecord[]> {
    await StorageManager.recoverAtomicStorage(this.app);
    const metaPath = this.getMetadataPath();
    if (await this.app.vault.adapter.exists(metaPath)) {
      try {
        const raw = await this.app.vault.adapter.read(metaPath);
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("Conflict metadata is not an array.");
        return parsed;
      } catch (err) {
        console.warn("[Vault Relay] Failed to read conflicts metadata:", err);
        throw new Error("Conflict metadata is unreadable. Existing conflict evidence was preserved.");
      }
    }
    return [];
  }

  /**
   * Saves conflict records to internal storage.
   */
  public async saveConflictRecords(records: ConflictRecord[]): Promise<void> {
    await StorageManager.saveConflictRecords(this.app, records);
  }

  /**
   * Records a detected conflict.
   */
  public async recordConflict(
    path: string,
    localSha: string,
    remoteSha: string,
    remoteCommitSha?: string,
    baseSha?: string,
    snapshotPath?: string
  ): Promise<ConflictRecord> {
    const records = await this.loadConflictRecords();
    const existingIndex = records.findIndex((r) => r.path === path);

    const record: ConflictRecord = {
      id: `${Date.now()}_${path.replace(/[\\/]/g, "_")}`,
      path,
      localSha,
      remoteSha,
      remoteCommitSha,
      baseSha,
      detectedAt: Date.now(),
      snapshotPath,
    };

    if (existingIndex >= 0) {
      records[existingIndex] = record;
    } else {
      records.push(record);
    }

    await this.saveConflictRecords(records);
    return record;
  }

  /**
   * Synchronizes active conflict records with a fresh SyncPreviewReport.
   * Guarantees: Every POTENTIAL_CONFLICT in the preview report has a reviewable ConflictRecord.
   * Cleans up resolved conflicts that are now UNCHANGED.
   */
  public async syncWithPreviewReport(report: SyncPreviewReport): Promise<ConflictRecord[]> {
    const records = await this.loadConflictRecords();
    let modified = false;

    // 1. Ensure all active POTENTIAL_CONFLICT and DELETE_CONFLICT items exist in records
    for (const item of report.items) {
      if (item.category === "POTENTIAL_CONFLICT" || item.category === "DELETE_CONFLICT") {
        const existing = records.find((r) => r.path === item.path);
        const inferredType: ConflictRecord["conflictType"] =
          item.category === "DELETE_CONFLICT"
            ? (item.deleteConflictType === "LOCAL_DELETED_REMOTE_MODIFIED"
                ? "DELETE_LOCAL_REMOTE_MODIFIED"
                : "DELETE_REMOTE_LOCAL_MODIFIED")
            : "CONTENT";

        if (!existing) {
          records.push({
            id: `${Date.now()}_${item.path.replace(/[\\/]/g, "_")}`,
            path: item.path,
            localSha: item.localSha || "",
            remoteSha: item.remoteSha || "",
            remoteCommitSha: report.remoteCommitSha,
            baseSha: item.baseSha,
            detectedAt: Date.now(),
            conflictType: inferredType,
          });
          modified = true;
        } else {
          if (item.localSha !== undefined && existing.localSha !== item.localSha) {
            existing.localSha = item.localSha;
            modified = true;
          }
          if (item.remoteSha !== undefined && existing.remoteSha !== item.remoteSha) {
            existing.remoteSha = item.remoteSha;
            modified = true;
          }
          if (report.remoteCommitSha && existing.remoteCommitSha !== report.remoteCommitSha) {
            existing.remoteCommitSha = report.remoteCommitSha;
            modified = true;
          }
          if (item.baseSha && existing.baseSha !== item.baseSha) {
            existing.baseSha = item.baseSha;
            modified = true;
          }
          if (existing.conflictType !== inferredType) {
            existing.conflictType = inferredType;
            modified = true;
          }
        }
      }
    }

    // 2. Remove any records that are now confirmed UNCHANGED in the report
    const unchangedPaths = new Set(
      report.items.filter((i) => i.category === "UNCHANGED").map((i) => i.path)
    );
    const removedRecords = records.filter((r) => unchangedPaths.has(r.path));
    const remaining = records.filter((r) => !unchangedPaths.has(r.path));
    if (remaining.length !== records.length) {
      records.length = 0;
      records.push(...remaining);
      modified = true;

      for (const rec of removedRecords) {
        if (rec.snapshotPath) {
          const isReferencedElsewhere = remaining.some((r) => r.snapshotPath === rec.snapshotPath);
          if (!isReferencedElsewhere) {
            await StorageManager.deleteConflictPayload(this.app, rec.snapshotPath);
          }
        }
      }
    }

    if (modified) {
      await this.saveConflictRecords(records);
    }
    return records;
  }

  /**
   * Removes a conflict record after resolution and safely deletes its internal payload file.
   */
  public async removeConflict(path: string): Promise<void> {
    const records = await this.loadConflictRecords();
    const target = records.find((r) => r.path === path);
    const filtered = records.filter((r) => r.path !== path);
    await this.saveConflictRecords(filtered);

    // If target had a snapshotPath, clean it up if not referenced by any other active record
    if (target?.snapshotPath) {
      const isReferencedElsewhere = filtered.some((r) => r.snapshotPath === target.snapshotPath);
      if (!isReferencedElsewhere) {
        await StorageManager.deleteConflictPayload(this.app, target.snapshotPath);
      }
    }
  }

  /**
   * Reconciles internal conflict storage, removing any orphan payload files
   * that are not referenced by any active conflict record in conflicts_meta.json.
   */
  public async reconcileOrphanPayloads(): Promise<{ scanned: number; removed: number; bytesReclaimed: number }> {
    return await StorageManager.cleanOrphanConflictPayloads(this.app);
  }

  /**
   * Resolution: Keep Local
   * Local version becomes intended authority.
   * Revalidates remote state: if remote has advanced past record.remoteCommitSha, aborts.
   * Uses verified Safe Push path to update remote.
   */
  public async resolveKeepLocal(record: ConflictRecord): Promise<{ success: boolean; message: string }> {
    if (this.inFlightResolutions.has(record.path)) {
      return {
        success: false,
        message: `Resolution already in progress for ${record.path}.`,
      };
    }
    if (record.id && this.resolvedRecordIds.has(record.id)) {
      return {
        success: false,
        message: `Conflict for ${record.path} has already been resolved or does not exist.`,
      };
    }

    const mutationLease = acquireMutationLease(this.app, "Keep Local conflict resolution");
    if (!mutationLease) {
      return {
        success: false,
        message: `Another vault mutation is already in progress (${getActiveMutationLabel(this.app) || "unknown operation"}).`,
      };
    }

    this.inFlightResolutions.add(record.path);
    try {
      const pushEngine = new PushEngine(this.app, this.settings, this.githubClient);
      const report = await pushEngine.executeAuthorizedConflictPush(
        {
          path: record.path,
          expectedLocalSha: record.localSha,
          expectedRemoteSha: record.remoteSha,
          expectedRemoteCommitSha: record.remoteCommitSha,
        },
        undefined,
        mutationLease
      );

      if (report.status === "PASS") {
        await this.removeConflict(record.path);
        this.markResolved(record.id);
        return { success: true, message: `Successfully pushed local version for ${record.path}.` };
      }

      return {
        success: false,
        message: `Failed to push local resolution: ${report.summaryMessage}`,
      };
    } finally {
      this.inFlightResolutions.delete(record.path);
      releaseMutationLease(mutationLease);
    }
  }

  /**
   * Resolution: Use Remote
   * Remote version safely overwrites the local conflict file.
   * Pre-write check: verifies current local bytes still match reviewed localSha.
   */
  public async resolveUseRemote(record: ConflictRecord): Promise<{ success: boolean; message: string }> {
    if (this.inFlightResolutions.has(record.path)) {
      return {
        success: false,
        message: `Resolution already in progress for ${record.path}.`,
      };
    }
    if (record.id && this.resolvedRecordIds.has(record.id)) {
      return {
        success: false,
        message: `Conflict for ${record.path} has already been resolved or does not exist.`,
      };
    }

    const mutationLease = acquireMutationLease(this.app, "Use Remote conflict resolution");
    if (!mutationLease) {
      return {
        success: false,
        message: `Another vault mutation is already in progress (${getActiveMutationLabel(this.app) || "unknown operation"}).`,
      };
    }

    this.inFlightResolutions.add(record.path);
    try {
      const safety = validatePathSafety(record.path, this.settings.excludedPaths);
      if (!safety.valid) {
        return { success: false, message: `Conflict path is unsafe: ${safety.reason}` };
      }
      const file = this.app.vault.getAbstractFileByPath(record.path);
      if (!(file instanceof TFile)) {
        return {
          success: false,
          message: "Local file was removed since conflict was reviewed. Aborted to prevent data loss.",
        };
      }
      const currentBytes = await this.app.vault.readBinary(file);
      const currentLocalSha = await calculateCanonicalGitBlobSha(currentBytes, file.path);
      if (currentLocalSha.toLowerCase() !== record.localSha.toLowerCase()) {
        return {
          success: false,
          message: "Local file was modified since conflict was reviewed. Aborted to prevent data loss.",
        };
      }

      const staleRemoteMessage = await this.revalidateRemoteRecord(record);
      if (staleRemoteMessage) {
        return { success: false, message: staleRemoteMessage };
      }

      // Fetch remote blob using verified getRawBlobBytes (integrity + 25 MiB ceiling checked)
      const remoteBytes = await this.githubClient.getRawBlobBytes(record.remoteSha);
      const bytes = prepareContentBytesForPath(remoteBytes, record.path);
      const expectedLocalSha = await calculateCanonicalGitBlobSha(bytes, record.path);
      const recoveryJournal = await StorageManager.beginPullWriteRecovery(
        this.app,
        record.path,
        expectedLocalSha,
        record.remoteSha,
        currentBytes
      );

      try {
        await this.app.vault.modifyBinary(file, bytes.buffer as ArrayBuffer);
        const verifiedFile = this.app.vault.getAbstractFileByPath(record.path);
        if (!(verifiedFile instanceof TFile)) throw new Error("Local file is missing after write.");
        const verifiedSha = await calculateCanonicalGitBlobSha(
          await this.app.vault.readBinary(verifiedFile),
          record.path
        );
        if (verifiedSha !== expectedLocalSha) {
          throw new Error("Post-write verification failed for the remote conflict resolution.");
        }
      } catch (err) {
        try {
          const rollbackTarget = this.app.vault.getAbstractFileByPath(record.path);
          if (rollbackTarget instanceof TFile) {
            await this.app.vault.modifyBinary(rollbackTarget, currentBytes);
            const rollbackSha = await calculateCanonicalGitBlobSha(
              await this.app.vault.readBinary(rollbackTarget),
              record.path
            );
            if (rollbackSha === currentLocalSha) {
              await StorageManager.completePullWriteRecovery(this.app, recoveryJournal);
            }
          }
        } catch {
          // Preserve the recovery journal and verified backup for startup recovery.
        }
        throw err;
      }

      // Update baseline in state
      const state = await StorageManager.loadState(this.app);
      state.files[record.path] = {
        localSha: expectedLocalSha,
        remoteSha: record.remoteSha,
        syncedAt: Date.now(),
      };
      try {
        await StorageManager.saveState(this.app, state);
      } catch (err) {
        try {
          const rollbackTarget = this.app.vault.getAbstractFileByPath(record.path);
          if (rollbackTarget instanceof TFile) {
            await this.app.vault.modifyBinary(rollbackTarget, currentBytes);
            const rollbackSha = await calculateCanonicalGitBlobSha(
              await this.app.vault.readBinary(rollbackTarget),
              record.path
            );
            if (rollbackSha === currentLocalSha) {
              await StorageManager.completePullWriteRecovery(this.app, recoveryJournal);
            }
          }
        } catch {
          // Preserve the recovery journal and verified backup for startup recovery.
        }
        throw err;
      }

      await this.removeConflict(record.path);
      this.markResolved(record.id);
      try {
        await StorageManager.completePullWriteRecovery(this.app, recoveryJournal);
      } catch (cleanupErr) {
        console.warn("[Vault Relay] Deferred conflict recovery cleanup:", cleanupErr);
      }
      return { success: true, message: `Local file updated to remote version for ${record.path}.` };
    } finally {
      this.inFlightResolutions.delete(record.path);
      releaseMutationLease(mutationLease);
    }
  }

  /**
   * Resolution: Keep Both
   * Preserves local file untouched and saves remote version as a conflict copy.
   */
  public async resolveKeepBoth(record: ConflictRecord): Promise<{ success: boolean; message: string; copyPath?: string }> {
    if (this.inFlightResolutions.has(record.path)) {
      return {
        success: false,
        message: `Resolution already in progress for ${record.path}.`,
      };
    }
    if (record.id && this.resolvedRecordIds.has(record.id)) {
      return {
        success: false,
        message: `Conflict for ${record.path} has already been resolved or does not exist.`,
      };
    }

    const mutationLease = acquireMutationLease(this.app, "Keep Both conflict resolution");
    if (!mutationLease) {
      return {
        success: false,
        message: `Another vault mutation is already in progress (${getActiveMutationLabel(this.app) || "unknown operation"}).`,
      };
    }

    this.inFlightResolutions.add(record.path);
    try {
      const safety = validatePathSafety(record.path, this.settings.excludedPaths);
      if (!safety.valid) {
        return { success: false, message: `Conflict path is unsafe: ${safety.reason}` };
      }
      const file = this.app.vault.getAbstractFileByPath(record.path);
      if (!(file instanceof TFile)) {
        return {
          success: false,
          message: "Local file was removed since conflict was reviewed. Refresh conflicts before resolving.",
        };
      }
      const currentBytes = await this.app.vault.readBinary(file);
      const currentLocalSha = await calculateCanonicalGitBlobSha(currentBytes, record.path);
      if (currentLocalSha.toLowerCase() !== record.localSha.toLowerCase()) {
        return {
          success: false,
          message: "Local file was modified since conflict was reviewed. Refresh conflicts before resolving.",
        };
      }

      const staleRemoteMessage = await this.revalidateRemoteRecord(record);
      if (staleRemoteMessage) {
        return { success: false, message: staleRemoteMessage };
      }

      // Fetch remote blob using verified getRawBlobBytes (integrity + 25 MiB ceiling checked)
      const remoteBytes = await this.githubClient.getRawBlobBytes(record.remoteSha);
      const bytes = prepareContentBytesForPath(remoteBytes, record.path);

      // Generate deterministic collision-safe second filename
      const now = new Date(record.detectedAt);
      const pad = (n: number) => String(n).padStart(2, "0");
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

      const lastDot = record.path.lastIndexOf(".");
      const base = lastDot !== -1 ? record.path.substring(0, lastDot) : record.path;
      const ext = lastDot !== -1 ? record.path.substring(lastDot) : "";

      let copyPath = `${base} (remote conflict ${dateStr})${ext}`;
      let suffix = 1;
      let copyAlreadyExists = false;
      while (this.app.vault.getAbstractFileByPath(copyPath)) {
        const existing = this.app.vault.getAbstractFileByPath(copyPath);
        if (existing instanceof TFile) {
          const existingBytes = new Uint8Array(await this.app.vault.readBinary(existing));
          if (
            existingBytes.byteLength === bytes.byteLength &&
            existingBytes.every((byte, index) => byte === bytes[index])
          ) {
            copyAlreadyExists = true;
            break;
          }
        }
        copyPath = `${base} (remote conflict ${dateStr}_${suffix})${ext}`;
        suffix++;
      }

      if (!copyAlreadyExists) {
        await this.app.vault.createBinary(copyPath, bytes.buffer as ArrayBuffer);
      }
      const verifiedCopy = this.app.vault.getAbstractFileByPath(copyPath);
      if (!(verifiedCopy instanceof TFile)) throw new Error("Remote conflict copy is missing after write.");
      const verifiedBytes = new Uint8Array(await this.app.vault.readBinary(verifiedCopy));
      if (
        verifiedBytes.byteLength !== bytes.byteLength ||
        !verifiedBytes.every((byte, index) => byte === bytes[index])
      ) {
        throw new Error("Post-write verification failed for the remote conflict copy.");
      }

      // Update baseline state for local note
      const state = await StorageManager.loadState(this.app);
      state.files[record.path] = {
        localSha: currentLocalSha,
        remoteSha: record.remoteSha,
        syncedAt: Date.now(),
      };
      await StorageManager.saveState(this.app, state);

      await this.removeConflict(record.path);
      this.markResolved(record.id);
      return {
        success: true,
        message: `Preserved both versions. Remote copy saved to: ${copyPath}`,
        copyPath,
      };
    } finally {
      this.inFlightResolutions.delete(record.path);
      releaseMutationLease(mutationLease);
    }
  }

  /**
   * Resolution: Keep File (for DELETE_CONFLICT)
   * - LOCAL_DELETED_REMOTE_MODIFIED: restores the remote modified version locally.
   * - REMOTE_DELETED_LOCAL_MODIFIED: pushes the local modified version back to remote.
   */
  public async resolveKeepFile(record: ConflictRecord): Promise<{ success: boolean; message: string }> {
    if (record.conflictType !== "DELETE_LOCAL_REMOTE_MODIFIED" && record.conflictType !== "DELETE_REMOTE_LOCAL_MODIFIED") {
      return { success: false, message: "Keep File is only applicable to delete conflicts." };
    }

    if (this.inFlightResolutions.has(record.path)) {
      return { success: false, message: `Resolution already in progress for ${record.path}.` };
    }
    if (record.id && this.resolvedRecordIds.has(record.id)) {
      return { success: false, message: `Conflict for ${record.path} has already been resolved or does not exist.` };
    }

    const mutationLease = acquireMutationLease(this.app, "Keep File conflict resolution");
    if (!mutationLease) {
      return {
        success: false,
        message: `Another vault mutation is already in progress (${getActiveMutationLabel(this.app) || "unknown operation"}).`,
      };
    }

    this.inFlightResolutions.add(record.path);
    try {
      if (record.conflictType === "DELETE_LOCAL_REMOTE_MODIFIED") {
        // Restore remote modified version locally
        const safety = validatePathSafety(record.path, this.settings.excludedPaths);
        if (!safety.valid) {
          return { success: false, message: `Conflict path is unsafe: ${safety.reason}` };
        }

        const staleRemoteMessage = await this.revalidateRemoteRecord(record);
        if (staleRemoteMessage) {
          return { success: false, message: staleRemoteMessage };
        }

        const remoteBytes = await this.githubClient.getRawBlobBytes(record.remoteSha);
        const bytes = prepareContentBytesForPath(remoteBytes, record.path);
        const expectedLocalSha = await calculateCanonicalGitBlobSha(bytes, record.path);

        const existingFile = this.app.vault.getAbstractFileByPath(record.path);
        if (existingFile instanceof TFile) {
          await this.app.vault.modifyBinary(existingFile, bytes.buffer as ArrayBuffer);
        } else {
          await this.app.vault.createBinary(record.path, bytes.buffer as ArrayBuffer);
        }

        const verifiedFile = this.app.vault.getAbstractFileByPath(record.path);
        if (!(verifiedFile instanceof TFile)) {
          throw new Error("Failed to materialize restored remote file locally.");
        }
        const verifiedSha = await calculateCanonicalGitBlobSha(
          await this.app.vault.readBinary(verifiedFile),
          record.path
        );
        if (verifiedSha !== expectedLocalSha) {
          throw new Error("Post-write verification failed for restored remote file.");
        }

        const state = await StorageManager.loadState(this.app);
        state.files[record.path] = {
          localSha: expectedLocalSha,
          remoteSha: record.remoteSha,
          syncedAt: Date.now(),
        };
        await StorageManager.saveState(this.app, state);

        await this.removeConflict(record.path);
        this.markResolved(record.id);
        return { success: true, message: `Restored remote version locally for ${record.path}.` };
      } else {
        // REMOTE_DELETED_LOCAL_MODIFIED: push local modified version to remote
        const pushEngine = new PushEngine(this.app, this.settings, this.githubClient);
        const report = await pushEngine.executeAuthorizedConflictPush(
          {
            path: record.path,
            expectedLocalSha: record.localSha,
            expectedRemoteSha: "",
            expectedRemoteCommitSha: record.remoteCommitSha,
            action: "PUSH_CONTENT",
          },
          undefined,
          mutationLease
        );

        if (report.status === "PASS") {
          await this.removeConflict(record.path);
          this.markResolved(record.id);
          return { success: true, message: `Successfully pushed local version for ${record.path}.` };
        }

        return {
          success: false,
          message: `Failed to push local resolution: ${report.summaryMessage}`,
        };
      }
    } catch (err) {
      return { success: false, message: `Keep File resolution failed: ${sanitizeErrorMessage(err)}` };
    } finally {
      this.inFlightResolutions.delete(record.path);
      releaseMutationLease(mutationLease);
    }
  }

  /**
   * Resolution: Delete File (for DELETE_CONFLICT)
   * - LOCAL_DELETED_REMOTE_MODIFIED: authorizes remote deletion of the modified remote file.
   * - REMOTE_DELETED_LOCAL_MODIFIED: authorizes local deletion of the modified local file.
   */
  public async resolveDeleteFile(record: ConflictRecord): Promise<{ success: boolean; message: string }> {
    if (record.conflictType !== "DELETE_LOCAL_REMOTE_MODIFIED" && record.conflictType !== "DELETE_REMOTE_LOCAL_MODIFIED") {
      return { success: false, message: "Delete File is only applicable to delete conflicts." };
    }

    if (this.inFlightResolutions.has(record.path)) {
      return { success: false, message: `Resolution already in progress for ${record.path}.` };
    }
    if (record.id && this.resolvedRecordIds.has(record.id)) {
      return { success: false, message: `Conflict for ${record.path} has already been resolved or does not exist.` };
    }

    const mutationLease = acquireMutationLease(this.app, "Delete File conflict resolution");
    if (!mutationLease) {
      return {
        success: false,
        message: `Another vault mutation is already in progress (${getActiveMutationLabel(this.app) || "unknown operation"}).`,
      };
    }

    this.inFlightResolutions.add(record.path);
    try {
      if (record.conflictType === "DELETE_LOCAL_REMOTE_MODIFIED") {
        // Push remote deletion of the remote modified file
        const pushEngine = new PushEngine(this.app, this.settings, this.githubClient);
        const report = await pushEngine.executeAuthorizedConflictPush(
          {
            path: record.path,
            expectedLocalSha: "",
            expectedRemoteSha: record.remoteSha,
            expectedRemoteCommitSha: record.remoteCommitSha,
            action: "PUSH_DELETE",
          },
          undefined,
          mutationLease
        );

        if (report.status === "PASS") {
          await this.removeConflict(record.path);
          this.markResolved(record.id);
          return { success: true, message: `Successfully deleted remote file for ${record.path}.` };
        }

        return {
          success: false,
          message: `Failed to push remote deletion: ${report.summaryMessage}`,
        };
      } else {
        // REMOTE_DELETED_LOCAL_MODIFIED: delete local modified file with durable recovery
        const staleRemoteMessage = await this.revalidateRemoteRecord(record);
        if (staleRemoteMessage) {
          return { success: false, message: staleRemoteMessage };
        }

        const file = this.app.vault.getAbstractFileByPath(record.path);
        if (!file || !(file instanceof TFile)) {
          // Already absent locally
          const state = await StorageManager.loadState(this.app);
          delete state.files[record.path];
          await StorageManager.saveState(this.app, state);
          await this.removeConflict(record.path);
          this.markResolved(record.id);
          return { success: true, message: `Local file was already absent for ${record.path}.` };
        }

        const currentBytes = await this.app.vault.readBinary(file);
        const currentSha = await calculateCanonicalGitBlobSha(currentBytes, record.path);
        if (record.localSha && currentSha.toLowerCase() !== record.localSha.toLowerCase()) {
          return {
            success: false,
            message: "Local file was modified since conflict was reviewed. Aborted to prevent data loss.",
          };
        }

        const deleteJournal = await StorageManager.beginDeleteRecovery(
          this.app,
          record.path,
          currentSha,
          currentBytes
        );

        await this.app.vault.delete(file);

        const stillExists = await this.app.vault.adapter.exists(record.path);
        if (stillExists) {
          throw new Error(`Failed to delete local file ${record.path}: file is still present.`);
        }

        const state = await StorageManager.loadState(this.app);
        delete state.files[record.path];
        await StorageManager.saveState(this.app, state);

        await StorageManager.completeDeleteRecovery(this.app, deleteJournal);

        await this.removeConflict(record.path);
        this.markResolved(record.id);
        return { success: true, message: `Successfully deleted local file for ${record.path}.` };
      }
    } catch (err) {
      return { success: false, message: `Delete File resolution failed: ${sanitizeErrorMessage(err)}` };
    } finally {
      this.inFlightResolutions.delete(record.path);
      releaseMutationLease(mutationLease);
    }
  }
}
