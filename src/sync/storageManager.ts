/**
 * Storage Manager for Vault Relay (C4 Final Namespace Hardening)
 *
 * Manages plugin-private internal state and conflict snapshots under
 * Obsidian's hidden configuration directory (${app.vault.configDir}/github-vault-relay/).
 *
 * Ensures normal vault content is 100% clean of internal plugin files.
 * Provides idempotent, crash-safe, binary-safe migration from:
 * 1. Legacy C2/C3: VaultRoot/_vault-relay/
 * 2. Intermediate C4: ${configDir}/vault-relay/
 * 3. Intermediate plugin-dir: ${configDir}/plugins/github-vault-relay/
 *
 * Preserves user-created content under _vault-relay/ (now a normal user folder).
 */

import { App, TFile } from "obsidian";
import { calculateCanonicalGitBlobSha } from "./hashUtils";
import { SyncStateData } from "./syncTypes";
import { createEmptyState, deserializeState, serializeState } from "./syncState";
import { getDefaultExclusions, normalizePath } from "./pathFilter";
import { validatePathSafety } from "./pathSafety";
import { sanitizeErrorMessage } from "../security/redact";
import { LocalFileStore, usesAdapter } from "./localFileStore";

export const PLUGIN_ID = "github-vault-relay";

interface PullWriteRecoveryRecord {
  version: 1;
  path: string;
  expectedLocalSha: string;
  remoteSha: string;
  originalLocalSha?: string;
  backupPath?: string;
  createdAt: number;
}

interface DeleteRecoveryRecord {
  version: 1;
  path: string;
  originalSha: string;
  backupPath: string;
  createdAt: number;
}

let recoverySequence = 0;

export class StorageManager {
  private static isStateValue(this: void, value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const state = value as { version?: unknown; files?: unknown };
    return typeof state.version === "number" && !!state.files && typeof state.files === "object";
  }

  private static async isValidJsonFile(
    app: App,
    path: string,
    validator: (value: unknown) => boolean
  ): Promise<boolean> {
    if (!(await app.vault.adapter.exists(path))) return false;
    try {
      return validator(JSON.parse(await app.vault.adapter.read(path)));
    } catch {
      return false;
    }
  }

  private static async recoverAtomicJsonFile(
    app: App,
    path: string,
    validator: (value: unknown) => boolean
  ): Promise<void> {
    const tempPath = `${path}.tmp`;
    const backupPath = `${path}.bak`;
    const targetValid = await this.isValidJsonFile(app, path, validator);

    if (targetValid) {
      if (await app.vault.adapter.exists(tempPath)) await app.vault.adapter.remove(tempPath);
      if (await app.vault.adapter.exists(backupPath)) await app.vault.adapter.remove(backupPath);
      return;
    }

    const backupValid = await this.isValidJsonFile(app, backupPath, validator);
    const tempValid = await this.isValidJsonFile(app, tempPath, validator);
    const recoveryPath = backupValid ? backupPath : tempValid ? tempPath : undefined;
    if (!recoveryPath) return;

    if (await app.vault.adapter.exists(path)) await app.vault.adapter.remove(path);
    await app.vault.adapter.rename(recoveryPath, path);
    if (await app.vault.adapter.exists(tempPath)) await app.vault.adapter.remove(tempPath);
    if (await app.vault.adapter.exists(backupPath)) await app.vault.adapter.remove(backupPath);
  }

  private static async writeAtomicJson(
    app: App,
    path: string,
    content: string,
    validator: (value: unknown) => boolean
  ): Promise<void> {
    const tempPath = `${path}.tmp`;
    const backupPath = `${path}.bak`;
    await this.recoverAtomicJsonFile(app, path, validator);

    await app.vault.adapter.write(tempPath, content);
    const tempContent = await app.vault.adapter.read(tempPath);
    if (tempContent !== content || !validator(JSON.parse(tempContent))) {
      throw new Error(`Verification failed while staging ${path}.`);
    }

    const hadTarget = await app.vault.adapter.exists(path);
    if (hadTarget) await app.vault.adapter.rename(path, backupPath);
    try {
      await app.vault.adapter.rename(tempPath, path);
      if (!(await this.isValidJsonFile(app, path, validator))) {
        throw new Error(`Verification failed after replacing ${path}.`);
      }
      if (await app.vault.adapter.exists(backupPath)) {
        try {
          await app.vault.adapter.remove(backupPath);
        } catch (cleanupErr) {
          console.warn(`[Vault Relay] Deferred cleanup of atomic backup ${backupPath}:`, sanitizeErrorMessage(cleanupErr));
        }
      }
    } catch (err) {
      const backupExists = await app.vault.adapter.exists(backupPath);
      const targetExists = await app.vault.adapter.exists(path);
      const targetValid = targetExists && (await this.isValidJsonFile(app, path, validator));
      if (backupExists && !targetValid) {
        if (targetExists) await app.vault.adapter.remove(path);
        await app.vault.adapter.rename(backupPath, path);
      }
      throw err;
    }
  }

  public static async recoverAtomicStorage(app: App): Promise<void> {
    const isConflictMetadata = (value: unknown): boolean => Array.isArray(value);

    await this.recoverAtomicJsonFile(app, this.getStateFilePath(app), this.isStateValue);
    await this.recoverAtomicJsonFile(app, this.getConflictsMetaFilePath(app), isConflictMetadata);
  }

  /**
   * Returns the canonical internal plugin storage directory path.
   * Example: .obsidian/github-vault-relay
   * Stored directly under configDir (.obsidian/github-vault-relay) so it is:
   * 1. 100% hidden from user vault notes.
   * 2. Completely safe from BRAT updates/reinstalls (BRAT wipes .obsidian/plugins/github-vault-relay).
   * 3. Completely safe from Obsidian Community Plugin updates.
   */
  public static getPluginStorageDir(app: App): string {
    const configDir = app.vault.configDir;
    return `${configDir}/${PLUGIN_ID}`;
  }

  /**
   * Returns the internal state file path.
   * Example: .obsidian/github-vault-relay/state.json
   */
  public static getStateFilePath(app: App): string {
    return `${this.getPluginStorageDir(app)}/state.json`;
  }

  /**
   * Returns the internal conflicts directory path.
   * Example: .obsidian/github-vault-relay/conflicts
   */
  public static getConflictsDirPath(app: App): string {
    return `${this.getPluginStorageDir(app)}/conflicts`;
  }

  /**
   * Returns the internal conflicts metadata file path.
   * Example: .obsidian/github-vault-relay/conflicts_meta.json
   */
  public static getConflictsMetaFilePath(app: App): string {
    return `${this.getPluginStorageDir(app)}/conflicts_meta.json`;
  }

  public static getPullRecoveryDirPath(app: App): string {
    return `${this.getPluginStorageDir(app)}/pull-recovery`;
  }

  public static async beginPullWriteRecovery(
    app: App,
    path: string,
    expectedLocalSha: string,
    remoteSha: string,
    originalBytes?: ArrayBuffer
  ): Promise<string> {
    const recoveryDir = this.getPullRecoveryDirPath(app);
    if (!(await app.vault.adapter.exists(recoveryDir))) await app.vault.adapter.mkdir(recoveryDir);

    recoverySequence++;
    const id = `${Date.now()}_${recoverySequence}_${path.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const journalPath = `${recoveryDir}/${id}.json`;
    let backupPath: string | undefined;
    let originalLocalSha: string | undefined;

    if (originalBytes) {
      backupPath = `${recoveryDir}/${id}.bin`;
      originalLocalSha = await calculateCanonicalGitBlobSha(originalBytes, path);
      await app.vault.adapter.writeBinary(backupPath, originalBytes);
      const verifiedBackup = await app.vault.adapter.readBinary(backupPath);
      const verifiedSha = await calculateCanonicalGitBlobSha(verifiedBackup, path);
      if (verifiedSha !== originalLocalSha) {
        throw new Error(`Could not verify local recovery backup for ${path}.`);
      }
    }

    const record: PullWriteRecoveryRecord = {
      version: 1,
      path,
      expectedLocalSha,
      remoteSha,
      originalLocalSha,
      backupPath,
      createdAt: Date.now(),
    };
    await this.writeAtomicJson(app, journalPath, JSON.stringify(record, null, 2), (value) => {
      if (!value || typeof value !== "object") return false;
      const parsed = value as Partial<PullWriteRecoveryRecord>;
      return (
        parsed.version === 1 &&
        typeof parsed.path === "string" &&
        typeof parsed.expectedLocalSha === "string" &&
        typeof parsed.remoteSha === "string"
      );
    });
    return journalPath;
  }

  public static async completePullWriteRecovery(app: App, journalPath: string): Promise<void> {
    const recoveryDir = normalizePath(this.getPullRecoveryDirPath(app));
    const normalizedJournal = normalizePath(journalPath);
    if (!normalizedJournal.startsWith(`${recoveryDir}/`) || normalizedJournal.includes("..")) return;

    let backupPath: string | undefined;
    if (await app.vault.adapter.exists(normalizedJournal)) {
      try {
        const record = JSON.parse(await app.vault.adapter.read(normalizedJournal)) as PullWriteRecoveryRecord;
        backupPath = record.backupPath;
      } catch {
        return;
      }
    }
    await app.vault.adapter.remove(normalizedJournal);
    if (backupPath && normalizePath(backupPath).startsWith(`${recoveryDir}/`) && (await app.vault.adapter.exists(backupPath))) {
      await app.vault.adapter.remove(backupPath);
    }
    for (const suffix of [".tmp", ".bak"]) {
      const artifact = `${normalizedJournal}${suffix}`;
      if (await app.vault.adapter.exists(artifact)) await app.vault.adapter.remove(artifact);
    }
  }

  public static async recoverInterruptedPullWrites(
    app: App
  ): Promise<{ scanned: number; completed: number; rolledBack: number; preserved: number }> {
    const recoveryDir = this.getPullRecoveryDirPath(app);
    if (!(await app.vault.adapter.exists(recoveryDir))) {
      return { scanned: 0, completed: 0, rolledBack: 0, preserved: 0 };
    }

    const listing = await app.vault.adapter.list(recoveryDir);
    const localStore = new LocalFileStore(app, getDefaultExclusions(app.vault.configDir));
    const journalPaths = listing.files.filter((path) => path.endsWith(".json"));
    const state = await this.loadState(app);
    const cleanupAfterStateSave: string[] = [];
    const cleanupImmediately: string[] = [];
    let stateModified = false;
    let completed = 0;
    let rolledBack = 0;
    let preserved = 0;

    for (const journalPath of journalPaths) {
      try {
        const record = JSON.parse(await app.vault.adapter.read(journalPath)) as PullWriteRecoveryRecord;
        const safePath = validatePathSafety(record.path, getDefaultExclusions(app.vault.configDir));
        if (record.version !== 1 || !safePath.valid || typeof record.remoteSha !== "string") {
          throw new Error("Invalid recovery journal.");
        }

        if (await localStore.exists(record.path)) {
          const currentBytes = await localStore.readBinary(record.path);
          const currentSha = await calculateCanonicalGitBlobSha(currentBytes, record.path);
          if (currentSha === record.expectedLocalSha) {
            state.files[record.path] = {
              localSha: record.expectedLocalSha,
              remoteSha: record.remoteSha,
              syncedAt: Date.now(),
            };
            stateModified = true;
            completed++;
            cleanupAfterStateSave.push(journalPath);
            continue;
          }
        }

        if (!record.backupPath || !record.originalLocalSha) {
          preserved++;
          cleanupImmediately.push(journalPath);
          continue;
        }
        const normalizedBackup = normalizePath(record.backupPath);
        const normalizedRecoveryDir = normalizePath(recoveryDir);
        if (!normalizedBackup.startsWith(`${normalizedRecoveryDir}/`) || normalizedBackup.includes("..")) {
          throw new Error("Invalid recovery backup path.");
        }

        const backup = await app.vault.adapter.readBinary(normalizedBackup);
        const backupSha = await calculateCanonicalGitBlobSha(backup, record.path);
        if (backupSha !== record.originalLocalSha) throw new Error("Recovery backup hash mismatch.");

        await localStore.writeBinary(record.path, backup);
        const restoredSha = await calculateCanonicalGitBlobSha(await localStore.readBinary(record.path), record.path);
        if (restoredSha !== record.originalLocalSha) throw new Error("Recovered file hash mismatch.");
        rolledBack++;
        cleanupImmediately.push(journalPath);
      } catch (err) {
        preserved++;
        console.warn(`[Vault Relay] Preserving interrupted Pull evidence ${journalPath}:`, sanitizeErrorMessage(err));
      }
    }

    if (stateModified) await this.saveState(app, state);
    for (const journalPath of [...cleanupImmediately, ...cleanupAfterStateSave]) {
      await this.completePullWriteRecovery(app, journalPath);
    }

    const remaining = await app.vault.adapter.list(recoveryDir);
    for (const artifact of remaining.files) {
      let journalPath: string | undefined;
      if (artifact.endsWith(".bin")) journalPath = `${artifact.slice(0, -4)}.json`;
      if (artifact.endsWith(".json.tmp")) journalPath = artifact.slice(0, -4);
      if (artifact.endsWith(".json.bak")) journalPath = artifact.slice(0, -4);
      if (journalPath && !(await app.vault.adapter.exists(journalPath))) {
        await app.vault.adapter.remove(artifact);
      }
    }
    return { scanned: journalPaths.length, completed, rolledBack, preserved };
  }

  public static getDeleteRecoveryDirPath(app: App): string {
    return `${this.getPluginStorageDir(app)}/delete-recovery`;
  }

  public static async beginDeleteRecovery(
    app: App,
    path: string,
    originalSha: string,
    originalBytes: ArrayBuffer
  ): Promise<string> {
    const recoveryDir = this.getDeleteRecoveryDirPath(app);
    if (!(await app.vault.adapter.exists(recoveryDir))) await app.vault.adapter.mkdir(recoveryDir);

    recoverySequence++;
    const id = `${Date.now()}_${recoverySequence}_${path.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const journalPath = `${recoveryDir}/${id}.json`;
    const backupPath = `${recoveryDir}/${id}.bin`;

    const verifiedSha = await calculateCanonicalGitBlobSha(originalBytes, path);
    if (verifiedSha !== originalSha) {
      throw new Error(`Cannot begin delete recovery for ${path}: byte SHA does not match expected SHA.`);
    }

    await app.vault.adapter.writeBinary(backupPath, originalBytes);
    const readBack = await app.vault.adapter.readBinary(backupPath);
    const readBackSha = await calculateCanonicalGitBlobSha(readBack, path);
    if (readBackSha !== originalSha) {
      throw new Error(`Could not verify local recovery backup before deleting ${path}.`);
    }

    const record: DeleteRecoveryRecord = {
      version: 1,
      path,
      originalSha,
      backupPath,
      createdAt: Date.now(),
    };

    await this.writeAtomicJson(app, journalPath, JSON.stringify(record, null, 2), (value) => {
      if (!value || typeof value !== "object") return false;
      const parsed = value as Partial<DeleteRecoveryRecord>;
      return (
        parsed.version === 1 &&
        typeof parsed.path === "string" &&
        typeof parsed.originalSha === "string" &&
        typeof parsed.backupPath === "string"
      );
    });

    return journalPath;
  }

  public static async completeDeleteRecovery(app: App, journalPath: string): Promise<void> {
    const recoveryDir = normalizePath(this.getDeleteRecoveryDirPath(app));
    const normalizedJournal = normalizePath(journalPath);
    if (!normalizedJournal.startsWith(`${recoveryDir}/`) || normalizedJournal.includes("..")) return;

    let backupPath: string | undefined;
    if (await app.vault.adapter.exists(normalizedJournal)) {
      try {
        const record = JSON.parse(await app.vault.adapter.read(normalizedJournal)) as DeleteRecoveryRecord;
        backupPath = record.backupPath;
      } catch {
        return;
      }
    }
    await app.vault.adapter.remove(normalizedJournal);
    if (backupPath && normalizePath(backupPath).startsWith(`${recoveryDir}/`) && (await app.vault.adapter.exists(backupPath))) {
      await app.vault.adapter.remove(backupPath);
    }
    for (const suffix of [".tmp", ".bak"]) {
      const artifact = `${normalizedJournal}${suffix}`;
      if (await app.vault.adapter.exists(artifact)) await app.vault.adapter.remove(artifact);
    }
  }

  /**
   * Safely deletes a file from the vault, respecting the user's Obsidian trash preference
   * via app.fileManager.trashFile.
   */
  public static async deleteVaultFile(app: App, fileOrPath: TFile | string): Promise<void> {
    if (fileOrPath instanceof TFile) {
      await app.fileManager.trashFile(fileOrPath);
      return;
    }

    const safePath = validatePathSafety(fileOrPath, getDefaultExclusions(app.vault.configDir));
    if (!safePath.valid) throw new Error(`Unsafe local delete path: ${safePath.reason}`);
    if (!usesAdapter(safePath.normalizedPath)) {
      const file = app.vault.getAbstractFileByPath(safePath.normalizedPath);
      if (!(file instanceof TFile)) throw new Error(`Local file is missing: ${safePath.normalizedPath}`);
      await app.fileManager.trashFile(file);
      return;
    }

    // DataAdapter.trashLocal preserves the user's vault-trash semantics without
    // requiring a TFile. There is deliberately no destructive remove fallback.
    await app.vault.adapter.trashLocal(safePath.normalizedPath);
  }

  public static async recoverInterruptedDeletes(
    app: App
  ): Promise<{ scanned: number; completed: number; restored: number; preserved: number }> {
    const recoveryDir = this.getDeleteRecoveryDirPath(app);
    if (!(await app.vault.adapter.exists(recoveryDir))) {
      return { scanned: 0, completed: 0, restored: 0, preserved: 0 };
    }

    const listing = await app.vault.adapter.list(recoveryDir);
    const localStore = new LocalFileStore(app, getDefaultExclusions(app.vault.configDir));
    const journalPaths = listing.files.filter((path) => path.endsWith(".json"));
    const state = await this.loadState(app);
    const cleanupImmediately: string[] = [];
    let completed = 0;
    let restored = 0;
    let preserved = 0;

    for (const journalPath of journalPaths) {
      try {
        const record = JSON.parse(await app.vault.adapter.read(journalPath)) as DeleteRecoveryRecord;
        const safePath = validatePathSafety(record.path, getDefaultExclusions(app.vault.configDir));
        if (record.version !== 1 || !safePath.valid || typeof record.originalSha !== "string") {
          throw new Error("Invalid delete recovery journal.");
        }

        const isStillInState = !!state.files[record.path];
        const fileOnDisk = await localStore.exists(record.path);

        if (!isStillInState) {
          // COMMITTED DELETE: Baseline was already successfully updated to prune this path.
          // The delete is committed; do NOT resurrect the file. Clean up stale journal and backup.
          completed++;
          cleanupImmediately.push(journalPath);
          continue;
        }

        // UNCOMMITTED DELETE: Baseline still expects the file, meaning operation crashed before state persistence.
        if (!fileOnDisk) {
          // Crash after local delete before baseline prune: restore exact file
          const normalizedBackup = normalizePath(record.backupPath);
          const normalizedRecoveryDir = normalizePath(recoveryDir);
          if (!normalizedBackup.startsWith(`${normalizedRecoveryDir}/`) || normalizedBackup.includes("..")) {
            throw new Error("Invalid delete backup path.");
          }
          if (await app.vault.adapter.exists(normalizedBackup)) {
            const backup = await app.vault.adapter.readBinary(normalizedBackup);
            const backupSha = await calculateCanonicalGitBlobSha(backup, record.path);
            if (backupSha === record.originalSha) {
              await localStore.writeBinary(record.path, backup);
              restored++;
              cleanupImmediately.push(journalPath);
              continue;
            }
          }
        } else {
          // Crash occurred before local delete was executed
          if (fileOnDisk) {
            const diskBytes = await localStore.readBinary(record.path);
            const diskSha = await calculateCanonicalGitBlobSha(diskBytes, record.path);
            if (diskSha === record.originalSha) {
              // Local file is completely intact. Delete was never executed.
              completed++;
              cleanupImmediately.push(journalPath);
              continue;
            }
          }

          // If local file exists but is corrupted/truncated, restore original bytes from backup
          const normalizedBackup = normalizePath(record.backupPath);
          const normalizedRecoveryDir = normalizePath(recoveryDir);
          if (
            normalizedBackup.startsWith(`${normalizedRecoveryDir}/`) &&
            !normalizedBackup.includes("..") &&
            (await app.vault.adapter.exists(normalizedBackup))
          ) {
            const backup = await app.vault.adapter.readBinary(normalizedBackup);
            const backupSha = await calculateCanonicalGitBlobSha(backup, record.path);
            if (backupSha === record.originalSha && fileOnDisk) {
              await localStore.writeBinary(record.path, backup);
              restored++;
              cleanupImmediately.push(journalPath);
              continue;
            }
          }
        }

        preserved++;
      } catch (err) {
        preserved++;
        console.warn(`[Vault Relay] Preserving interrupted Delete evidence ${journalPath}:`, sanitizeErrorMessage(err));
      }
    }

    for (const journalPath of cleanupImmediately) {
      await this.completeDeleteRecovery(app, journalPath);
    }

    const remaining = await app.vault.adapter.list(recoveryDir);
    for (const artifact of remaining.files) {
      let journalPath: string | undefined;
      if (artifact.endsWith(".bin")) journalPath = `${artifact.slice(0, -4)}.json`;
      if (artifact.endsWith(".json.tmp")) journalPath = artifact.slice(0, -4);
      if (artifact.endsWith(".json.bak")) journalPath = artifact.slice(0, -4);
      if (journalPath && !(await app.vault.adapter.exists(journalPath))) {
        await app.vault.adapter.remove(artifact);
      }
    }

    return { scanned: journalPaths.length, completed, restored, preserved };
  }

  /**
   * Loads sync state from canonical internal storage (.obsidian/github-vault-relay/state.json).
   */
  public static async loadState(app: App): Promise<SyncStateData> {
    const canonicalPath = this.getStateFilePath(app);
    await this.recoverAtomicStorage(app);

    if (await app.vault.adapter.exists(canonicalPath)) {
      try {
        const content = await app.vault.adapter.read(canonicalPath);
        if (!this.isStateValue(JSON.parse(content))) throw new Error("Canonical state schema is invalid.");
        return deserializeState(content);
      } catch (err) {
        console.warn(`[Vault Relay] Failed to read canonical state at ${canonicalPath}:`, sanitizeErrorMessage(err));
      }
    }

    return createEmptyState();
  }

  /**
   * Persists sync state strictly to canonical internal storage under the live configDir.
   * Guaranteed never to touch or write to user-owned _vault-relay/ content or legacy source paths.
   */
  public static async saveState(app: App, state: SyncStateData): Promise<void> {
    const dir = this.getPluginStorageDir(app);
    if (!(await app.vault.adapter.exists(dir))) {
      await app.vault.adapter.mkdir(dir);
    }
    const path = this.getStateFilePath(app);
    await this.writeAtomicJson(app, path, serializeState(state), this.isStateValue);
  }

  public static async saveConflictRecords(app: App, records: unknown[]): Promise<void> {
    const dir = this.getPluginStorageDir(app);
    if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
    await this.writeAtomicJson(
      app,
      this.getConflictsMetaFilePath(app),
      JSON.stringify(records, null, 2),
      Array.isArray
    );
  }

  /**
   * Saves conflict content securely under internal storage (.obsidian/github-vault-relay/conflicts/).
   * Collision-safe with timestamp and incremental suffix.
   * Returns the saved file path.
   */
  public static async saveConflictPayload(
    app: App,
    originalPath: string,
    content: ArrayBuffer | string
  ): Promise<string> {
    const conflictsDir = this.getConflictsDirPath(app);
    if (!(await app.vault.adapter.exists(conflictsDir))) {
      await app.vault.adapter.mkdir(conflictsDir);
    }

    const timestamp = Date.now();
    const cleanPath = originalPath.replace(/[/\\]/g, "_");
    let conflictFileName = `${timestamp}_${cleanPath}`;
    let targetPath = `${conflictsDir}/${conflictFileName}`;
    let suffix = 1;
    while (await app.vault.adapter.exists(targetPath)) {
      conflictFileName = `${timestamp}_${suffix}_${cleanPath}`;
      targetPath = `${conflictsDir}/${conflictFileName}`;
      suffix++;
    }

    if (typeof content === "string") {
      await app.vault.adapter.write(targetPath, content);
    } else {
      await app.vault.adapter.writeBinary(targetPath, content);
    }

    return targetPath;
  }

  /**
   * Safely deletes a specific internal conflict payload file from storage.
   *
   * Crucial safety invariants:
   * - Positively verifies the target path is strictly within the plugin's canonical conflicts dir.
   * - Prevents path traversal ('..') or deleting files outside conflicts dir.
   * - Never touches user vault notes or settings.
   */
  public static async deleteConflictPayload(app: App, payloadPath: string): Promise<boolean> {
    if (!payloadPath || typeof payloadPath !== "string") return false;
    const conflictsDir = normalizePath(this.getConflictsDirPath(app));
    const target = normalizePath(payloadPath);

    // Safety: strictly ensure the file is within the canonical conflicts directory
    if (!target.startsWith(`${conflictsDir}/`)) {
      console.warn(`[Vault Relay] Refusing to delete payload outside canonical conflicts dir: ${payloadPath}`);
      return false;
    }

    // Safety: reject path traversal
    if (target.includes("..")) {
      console.warn(`[Vault Relay] Refusing to delete path with traversal: ${payloadPath}`);
      return false;
    }

    if (await app.vault.adapter.exists(target)) {
      try {
        await app.vault.adapter.remove(target);
        return true;
      } catch (err) {
        console.warn(`[Vault Relay] Failed to remove conflict payload ${target}:`, sanitizeErrorMessage(err));
        return false;
      }
    }
    return false;
  }

  /**
   * Crash-safe orphan garbage collection:
   * Reconciles plugin-owned internal conflicts directory against active conflict records.
   * Removes any obsolete/orphan payload files left behind by crashes or uncleaned resolutions.
   *
   * Safety invariants:
   * - Only scans ${configDir}/github-vault-relay/conflicts/
   * - Never touches files outside this canonical directory
   * - If conflicts_meta.json cannot be parsed or read, preserves files to prevent data loss
   * - Never deletes any active conflict payload referenced in conflicts_meta.json
   */
  public static async cleanOrphanConflictPayloads(
    app: App
  ): Promise<{ scanned: number; removed: number; bytesReclaimed: number }> {
    await this.recoverAtomicStorage(app);
    const conflictsDir = this.getConflictsDirPath(app);
    if (!(await app.vault.adapter.exists(conflictsDir))) {
      return { scanned: 0, removed: 0, bytesReclaimed: 0 };
    }

    const metaPath = this.getConflictsMetaFilePath(app);
    const activePayloadPaths = new Set<string>();

    if (await app.vault.adapter.exists(metaPath)) {
      try {
        const raw = await app.vault.adapter.read(metaPath);
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (
              typeof item === "object" &&
              item !== null &&
              "snapshotPath" in item &&
              typeof (item as Record<string, unknown>).snapshotPath === "string"
            ) {
              activePayloadPaths.add(normalizePath((item as Record<string, unknown>).snapshotPath as string));
            }
          }
        }
      } catch (err) {
        console.warn("[Vault Relay] Failed to read conflicts metadata during GC; aborting to preserve evidence:", sanitizeErrorMessage(err));
        return { scanned: 0, removed: 0, bytesReclaimed: 0 };
      }
    }

    const canonicalConflictsDir = normalizePath(conflictsDir);
    const filesToScan: string[] = [];
    const queue = [conflictsDir];

    while (queue.length > 0) {
      const currentDir = queue.shift()!;
      try {
        const res = await app.vault.adapter.list(currentDir);
        filesToScan.push(...res.files);
        queue.push(...res.folders);
      } catch (listErr) {
        console.warn(`[Vault Relay] Failed to list conflicts directory ${currentDir}:`, sanitizeErrorMessage(listErr));
      }
    }

    let removed = 0;
    let bytesReclaimed = 0;

    for (const filePath of filesToScan) {
      const normalized = normalizePath(filePath);

      // Strict containment check: must be inside conflicts directory
      if (!normalized.startsWith(`${canonicalConflictsDir}/`)) {
        continue;
      }

      // Traversal safety
      if (normalized.includes("..")) {
        continue;
      }

      // Protected metadata check
      if (normalized.endsWith("conflicts_meta.json") || normalized.endsWith("state.json")) {
        continue;
      }

      // Check if this payload is referenced by any active conflict record
      if (!activePayloadPaths.has(normalized)) {
        try {
          let size = 0;
          if (typeof app.vault.adapter.stat === "function") {
            const stat = await app.vault.adapter.stat(normalized);
            size = stat?.size || 0;
          }
          await app.vault.adapter.remove(normalized);
          removed++;
          bytesReclaimed += size;
        } catch (err) {
          console.warn(`[Vault Relay:GC] Failed to remove orphan conflict payload ${normalized}:`, sanitizeErrorMessage(err));
        }
      }
    }

    return { scanned: filesToScan.length, removed, bytesReclaimed };
  }
}
