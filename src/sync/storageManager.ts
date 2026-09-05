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
import { calculateRawGitBlobSha, calculateCanonicalGitBlobSha } from "./hashUtils";
import { SyncStateData } from "./syncTypes";
import { createEmptyState, deserializeState, serializeState } from "./syncState";
import { normalizePath } from "./pathFilter";
import { validatePathSafety } from "./pathSafety";

export const PLUGIN_ID = "github-vault-relay";
export const LEGACY_ROOT_DIR = "_vault-relay";
export const LEGACY_STATE_FILE = "_vault-relay/state.json";
export const LEGACY_CONFLICTS_DIR = "_vault-relay/conflicts";

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
  private static isStateValue(value: unknown): boolean {
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
          console.warn(`[Vault Relay] Deferred cleanup of atomic backup ${backupPath}:`, cleanupErr);
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
    const configDir = (app.vault as unknown as { configDir?: string }).configDir || ".obsidian";
    return `${configDir}/${PLUGIN_ID}`;
  }

  /**
   * Returns the intermediate C4 storage directory path for migration.
   * Example: .obsidian/vault-relay
   */
  public static getIntermediateC4Dir(app: App): string {
    const configDir = (app.vault as unknown as { configDir?: string }).configDir || ".obsidian";
    return `${configDir}/vault-relay`;
  }

  /**
   * Returns intermediate plugin-dir state file path for migration.
   */
  public static getIntermediatePluginStateFilePath(app: App): string {
    const configDir = (app.vault as unknown as { configDir?: string }).configDir || ".obsidian";
    return `${configDir}/plugins/${PLUGIN_ID}/state.json`;
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
        const safePath = validatePathSafety(record.path);
        if (record.version !== 1 || !safePath.valid || typeof record.remoteSha !== "string") {
          throw new Error("Invalid recovery journal.");
        }

        const current = app.vault.getAbstractFileByPath(record.path);
        if (current instanceof TFile) {
          const currentBytes = await app.vault.readBinary(current);
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

        const target = app.vault.getAbstractFileByPath(record.path);
        if (target instanceof TFile) {
          await app.vault.modifyBinary(target, backup);
        } else {
          await app.vault.createBinary(record.path, backup);
        }
        const restored = app.vault.getAbstractFileByPath(record.path);
        if (!(restored instanceof TFile)) throw new Error("Recovered file is missing.");
        const restoredSha = await calculateCanonicalGitBlobSha(await app.vault.readBinary(restored), record.path);
        if (restoredSha !== record.originalLocalSha) throw new Error("Recovered file hash mismatch.");
        rolledBack++;
        cleanupImmediately.push(journalPath);
      } catch (err) {
        preserved++;
        console.warn(`[Vault Relay] Preserving interrupted Pull evidence ${journalPath}:`, err);
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

  public static async recoverInterruptedDeletes(
    app: App
  ): Promise<{ scanned: number; completed: number; restored: number; preserved: number }> {
    const recoveryDir = this.getDeleteRecoveryDirPath(app);
    if (!(await app.vault.adapter.exists(recoveryDir))) {
      return { scanned: 0, completed: 0, restored: 0, preserved: 0 };
    }

    const listing = await app.vault.adapter.list(recoveryDir);
    const journalPaths = listing.files.filter((path) => path.endsWith(".json"));
    const state = await this.loadState(app);
    const cleanupImmediately: string[] = [];
    let completed = 0;
    let restored = 0;
    let preserved = 0;

    for (const journalPath of journalPaths) {
      try {
        const record = JSON.parse(await app.vault.adapter.read(journalPath)) as DeleteRecoveryRecord;
        const safePath = validatePathSafety(record.path);
        if (record.version !== 1 || !safePath.valid || typeof record.originalSha !== "string") {
          throw new Error("Invalid delete recovery journal.");
        }

        const isStillInState = !!state.files[record.path];
        const fileOnDisk = app.vault.getAbstractFileByPath(record.path);

        if (!isStillInState) {
          // State was already updated to delete this path. The delete was successful.
          completed++;
          cleanupImmediately.push(journalPath);
          continue;
        }

        // State still expects the file, but file is missing or corrupted -> restore from backup
        if (!fileOnDisk) {
          const normalizedBackup = normalizePath(record.backupPath);
          const normalizedRecoveryDir = normalizePath(recoveryDir);
          if (!normalizedBackup.startsWith(`${normalizedRecoveryDir}/`) || normalizedBackup.includes("..")) {
            throw new Error("Invalid delete backup path.");
          }
          if (await app.vault.adapter.exists(normalizedBackup)) {
            const backup = await app.vault.adapter.readBinary(normalizedBackup);
            const backupSha = await calculateCanonicalGitBlobSha(backup, record.path);
            if (backupSha === record.originalSha) {
              await app.vault.createBinary(record.path, backup);
              restored++;
              cleanupImmediately.push(journalPath);
              continue;
            }
          }
        }

        preserved++;
      } catch (err) {
        preserved++;
        console.warn(`[Vault Relay] Preserving interrupted Delete evidence ${journalPath}:`, err);
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
   * Loads sync state from internal storage, falling back gracefully to intermediate
   * or legacy paths if not yet migrated.
   */
  public static async loadState(app: App): Promise<SyncStateData> {
    const canonicalPath = this.getStateFilePath(app);
    await this.recoverAtomicStorage(app);

    // 1. Try reading from canonical internal storage (.obsidian/github-vault-relay/state.json)
    if (await app.vault.adapter.exists(canonicalPath)) {
      try {
        const content = await app.vault.adapter.read(canonicalPath);
        if (!this.isStateValue(JSON.parse(content))) throw new Error("Canonical state schema is invalid.");
        return deserializeState(content);
      } catch (err) {
        console.warn(`[Vault Relay] Failed to read canonical state at ${canonicalPath}:`, err);
      }
    }

    // 2. Fall back to intermediate C4 storage (.obsidian/vault-relay/state.json) if present
    const interC4State = `${this.getIntermediateC4Dir(app)}/state.json`;
    if (await app.vault.adapter.exists(interC4State)) {
      try {
        const content = await app.vault.adapter.read(interC4State);
        if (!this.isStateValue(JSON.parse(content))) throw new Error("Intermediate state schema is invalid.");
        return deserializeState(content);
      } catch (err) {
        console.warn("[Vault Relay] Failed to read intermediate C4 state:", err);
      }
    }

    // 3. Fall back to intermediate plugin-dir storage (.obsidian/plugins/github-vault-relay/state.json)
    const intermediatePath = this.getIntermediatePluginStateFilePath(app);
    if (await app.vault.adapter.exists(intermediatePath)) {
      try {
        const content = await app.vault.adapter.read(intermediatePath);
        if (!this.isStateValue(JSON.parse(content))) throw new Error("Plugin-directory state schema is invalid.");
        return deserializeState(content);
      } catch (err) {
        console.warn("[Vault Relay] Failed to read intermediate plugin-dir state:", err);
      }
    }

    // 4. Fall back to legacy root path (_vault-relay/state.json) if present
    if (await app.vault.adapter.exists(LEGACY_STATE_FILE)) {
      try {
        const content = await app.vault.adapter.read(LEGACY_STATE_FILE);
        if (!this.isStateValue(JSON.parse(content))) throw new Error("Legacy state schema is invalid.");
        return deserializeState(content);
      } catch (err) {
        console.warn(`[Vault Relay] Failed to read legacy state at ${LEGACY_STATE_FILE}:`, err);
      }
    }

    return createEmptyState();
  }

  /**
   * Persists sync state strictly to canonical internal storage (.obsidian/github-vault-relay/state.json).
   * Guaranteed never to touch or write to _vault-relay/ or .obsidian/vault-relay/.
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
        console.warn(`[Vault Relay] Failed to remove conflict payload ${target}:`, err);
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
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item.snapshotPath === "string") {
              activePayloadPaths.add(normalizePath(item.snapshotPath));
            }
          }
        }
      } catch (err) {
        console.warn("[Vault Relay] Failed to read conflicts metadata during GC; aborting to preserve evidence:", err);
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
        console.warn(`[Vault Relay] Failed to list conflicts directory ${currentDir}:`, listErr);
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
          console.info(`[Vault Relay:GC] Reclaimed orphan conflict payload: ${normalized} (${size} bytes)`);
        } catch (err) {
          console.warn(`[Vault Relay:GC] Failed to remove orphan conflict payload ${normalized}:`, err);
        }
      }
    }

    return { scanned: filesToScan.length, removed, bytesReclaimed };
  }

  /**
   * Idempotent, crash-safe, binary-safe migration from previous layouts to canonical storage
   * (.obsidian/github-vault-relay/):
   *
   * 1. Intermediate C4 (.obsidian/vault-relay/):
   *    Migrates state.json, conflicts/, and conflicts_meta.json with verification, then removes directory.
   *
   * 2. Intermediate plugin-dir (.obsidian/plugins/github-vault-relay/state.json):
   *    Migrates state.json and removes file.
   *
   * 3. Legacy C2/C3 (VaultRoot/_vault-relay/):
   *    - Positive detection: Only migrates state.json if valid Vault Relay schema.
   *    - Positive detection: Recursively migrates recognized conflicts under _vault-relay/conflicts/.
   *    - Mixed-content safety: Preserves user files in _vault-relay/ intact. Only removes _vault-relay/
   *      if it is completely empty after removing plugin artifacts.
   */
  public static async migrateLegacyStorage(app: App): Promise<{ migrated: boolean; error?: string }> {
    try {
      await this.recoverAtomicStorage(app);
      const canonicalDir = this.getPluginStorageDir(app);
      const canonicalConflictsDir = this.getConflictsDirPath(app);
      const canonicalStatePath = this.getStateFilePath(app);
      const canonicalMetaPath = this.getConflictsMetaFilePath(app);

      const intermediateC4Dir = this.getIntermediateC4Dir(app);
      const intermediatePluginState = this.getIntermediatePluginStateFilePath(app);

      const hasLegacyState = await app.vault.adapter.exists(LEGACY_STATE_FILE);
      const hasLegacyDir = await app.vault.adapter.exists(LEGACY_ROOT_DIR);
      const hasIntermediateC4 = await app.vault.adapter.exists(intermediateC4Dir);
      const hasIntermediatePluginState = await app.vault.adapter.exists(intermediatePluginState);

      if (!hasLegacyState && !hasLegacyDir && !hasIntermediateC4 && !hasIntermediatePluginState) {
        return { migrated: false };
      }

      // Ensure canonical storage directories exist
      if (!(await app.vault.adapter.exists(canonicalDir))) {
        await app.vault.adapter.mkdir(canonicalDir);
      }
      if (!(await app.vault.adapter.exists(canonicalConflictsDir))) {
        await app.vault.adapter.mkdir(canonicalConflictsDir);
      }

      let canonicalStateExists = await this.isValidJsonFile(app, canonicalStatePath, this.isStateValue);
      let didMigrateSomething = false;
      let cleanupIntermediateC4 = false;
      let inspectLegacyRootAfterMigration = false;
      const legacyConflictFilesToRemove: string[] = [];
      const migratedConflictPaths = new Map<string, string>();

      // Helper for recursive file listing
      const listFilesRecursively = async (dir: string): Promise<string[]> => {
        const results: string[] = [];
        if (!app.vault.adapter.list) return results;
        try {
          const res = await app.vault.adapter.list(dir);
          if (res && res.files) results.push(...res.files);
          if (res && res.folders) {
            for (const folder of res.folders) {
              const sub = await listFilesRecursively(folder);
              results.push(...sub);
            }
          }
        } catch (_e) {
          console.warn(`[Vault Relay] Error listing ${dir}:`, _e);
        }
        return results;
      };

      // Helper for recursive directory deletion
      const deleteDirectoryRecursively = async (dir: string): Promise<void> => {
        if (app.vault.adapter.list) {
          try {
            const res = await app.vault.adapter.list(dir);
            if (res && res.files) {
              for (const file of res.files) {
                try { await app.vault.adapter.remove(file); } catch (_e) { /* ignore */ }
              }
            }
            if (res && res.folders) {
              for (const folder of res.folders) {
                await deleteDirectoryRecursively(folder);
              }
            }
          } catch (_e) {
            /* ignore */
          }
        }
        if (app.vault.adapter.rmdir) {
          try { await app.vault.adapter.rmdir(dir, true); } catch (_e) { /* ignore */ }
        }
        try {
          const abstract = app.vault.getAbstractFileByPath(dir);
          const vaultWithDelete = app.vault as unknown as { delete?: (f: unknown, force?: boolean) => Promise<void> };
          if (abstract && typeof vaultWithDelete.delete === "function") {
            await vaultWithDelete.delete(abstract, true);
          }
        } catch (_e) {
          /* ignore */
        }
      };

      const copyConflictFileVerified = async (source: string, preferredDestination: string): Promise<string> => {
        const sourceBytes = new Uint8Array(await app.vault.adapter.readBinary(source));
        const lastDot = preferredDestination.lastIndexOf(".");
        const base = lastDot > preferredDestination.lastIndexOf("/")
          ? preferredDestination.substring(0, lastDot)
          : preferredDestination;
        const ext = lastDot > preferredDestination.lastIndexOf("/")
          ? preferredDestination.substring(lastDot)
          : "";
        let destination = preferredDestination;
        let suffix = 1;

        while (await app.vault.adapter.exists(destination)) {
          const existing = new Uint8Array(await app.vault.adapter.readBinary(destination));
          if (
            existing.byteLength === sourceBytes.byteLength &&
            existing.every((byte, index) => byte === sourceBytes[index])
          ) {
            return destination;
          }
          destination = `${base}_${suffix}${ext}`;
          suffix++;
        }

        await app.vault.adapter.writeBinary(destination, sourceBytes.buffer as ArrayBuffer);
        const verified = new Uint8Array(await app.vault.adapter.readBinary(destination));
        if (
          verified.byteLength !== sourceBytes.byteLength ||
          !verified.every((byte, index) => byte === sourceBytes[index])
        ) {
          throw new Error(`Verification failed: Byte content mismatch for ${source}.`);
        }
        return destination;
      };

      // Load existing metadata in canonical destination
      let metaRecords: Array<{
        id: string;
        path: string;
        localSha: string;
        remoteSha: string;
        detectedAt: number;
        snapshotPath?: string;
      }> = [];
      if (await app.vault.adapter.exists(canonicalMetaPath)) {
        const parsedMetadata = JSON.parse(await app.vault.adapter.read(canonicalMetaPath));
        if (!Array.isArray(parsedMetadata)) {
          throw new Error("Canonical conflicts metadata is invalid; migration was stopped to preserve evidence.");
        }
        metaRecords = parsedMetadata;
      }

      // ==========================================
      // PHASE 1: Migrate Intermediate C4 (.obsidian/vault-relay/)
      // ==========================================
      if (hasIntermediateC4) {
        const interStatePath = `${intermediateC4Dir}/state.json`;
        const interConflictsDir = `${intermediateC4Dir}/conflicts`;
        const interMetaPath = `${intermediateC4Dir}/conflicts_meta.json`;

        // 1.1 Migrate state.json if canonical does not exist
        if ((await app.vault.adapter.exists(interStatePath)) && !canonicalStateExists) {
          const content = await app.vault.adapter.read(interStatePath);
          if (!this.isStateValue(JSON.parse(content))) {
            throw new Error("Intermediate state schema is invalid; source storage was preserved.");
          }
          const parsed = deserializeState(content);
          await this.saveState(app, parsed);

          const verifyContent = await app.vault.adapter.read(canonicalStatePath);
          const verifyParsed = deserializeState(verifyContent);
          if (Object.keys(verifyParsed.files).length !== Object.keys(parsed.files).length) {
            throw new Error("Verification failed: Migrated C4 intermediate state record mismatch.");
          }
          canonicalStateExists = true;
          didMigrateSomething = true;
        }

        // 1.2 Migrate conflicts/
        if (await app.vault.adapter.exists(interConflictsDir)) {
          const interConflictFiles = await listFilesRecursively(interConflictsDir);
          if (interConflictFiles.length > 0 && !(await app.vault.adapter.exists(interMetaPath))) {
            throw new Error("Intermediate conflict payloads have no readable metadata; source storage was preserved for manual recovery.");
          }
          for (const file of interConflictFiles) {
            const fileName = file.split("/").pop() || file;
            const dest = await copyConflictFileVerified(file, `${canonicalConflictsDir}/${fileName}`);
            migratedConflictPaths.set(normalizePath(file), normalizePath(dest));
          }
          didMigrateSomething = true;
        }

        // 1.3 Migrate conflicts_meta.json
        if (await app.vault.adapter.exists(interMetaPath)) {
          const interMeta = JSON.parse(await app.vault.adapter.read(interMetaPath));
          if (!Array.isArray(interMeta)) {
            throw new Error("Intermediate conflicts metadata is not an array; source storage was preserved.");
          }
          for (const rec of interMeta) {
            if (!metaRecords.some((r) => r.id === rec.id)) {
              if (rec.snapshotPath) {
                const mappedPath = migratedConflictPaths.get(normalizePath(rec.snapshotPath));
                rec.snapshotPath = mappedPath || rec.snapshotPath.replace(".obsidian/vault-relay/", `${canonicalDir}/`);
              }
              metaRecords.push(rec);
            }
          }
          didMigrateSomething = true;
        }

        // Cleanup is deferred until canonical conflict metadata is durably written.
        cleanupIntermediateC4 = true;
      }

      // ==========================================
      // PHASE 2: Migrate Intermediate Plugin Dir (.obsidian/plugins/github-vault-relay/state.json)
      // ==========================================
      if (hasIntermediatePluginState) {
        if (!canonicalStateExists) {
          const content = await app.vault.adapter.read(intermediatePluginState);
          if (!this.isStateValue(JSON.parse(content))) {
            throw new Error("Plugin-directory state schema is invalid; source storage was preserved.");
          }
          const parsed = deserializeState(content);
          await this.saveState(app, parsed);
          canonicalStateExists = true;
          didMigrateSomething = true;
        }
        await app.vault.adapter.remove(intermediatePluginState);
      }

      // ==========================================
      // PHASE 3: Migrate Legacy C2/C3 (VaultRoot/_vault-relay/) with Positive Artifact Detection
      // ==========================================
      if (hasLegacyDir || hasLegacyState) {
        // 3.1 Positive Detection: Migrate _vault-relay/state.json ONLY if valid Vault Relay state
        if (await app.vault.adapter.exists(LEGACY_STATE_FILE)) {
          const legacyContent = await app.vault.adapter.read(LEGACY_STATE_FILE);
          // Strict JSON validation: throws on syntax corruption, ensuring legacy file is kept
          const parsedJson = JSON.parse(legacyContent);
          if (this.isStateValue(parsedJson)) {
            if (!canonicalStateExists) {
              const parsedState = deserializeState(legacyContent);
              await this.saveState(app, parsedState);
              const verifyContent = await app.vault.adapter.read(canonicalStatePath);
              const verifyParsed = deserializeState(verifyContent);
              if (Object.keys(verifyParsed.files).length !== Object.keys(parsedState.files).length) {
                throw new Error("Verification failed: Migrated legacy state record mismatch.");
              }
              canonicalStateExists = true;
            }
            // Verified: remove legacy state.json
            await app.vault.adapter.remove(LEGACY_STATE_FILE);
            didMigrateSomething = true;
          } else {
            throw new Error("Legacy state.json does not match Vault Relay state schema");
          }
        }

        // 3.2 Positive Detection: Migrate recognized legacy conflicts under _vault-relay/conflicts/
        if (await app.vault.adapter.exists(LEGACY_CONFLICTS_DIR)) {
          const legacyConflictFiles = await listFilesRecursively(LEGACY_CONFLICTS_DIR);
          for (const file of legacyConflictFiles) {
            const prefix = `${LEGACY_CONFLICTS_DIR}/`;
            const relPath = file.startsWith(prefix) ? file.substring(prefix.length) : file;
            const segments = relPath.split(/[/\\]/);

            let originalPath: string;
            let detectedAt = Date.now();

            if (segments.length > 1 && /^\d+(_\d+)?$/.test(segments[0])) {
              const parsedTs = parseInt(segments[0].split("_")[0], 10);
              if (!isNaN(parsedTs)) detectedAt = parsedTs;
              originalPath = segments.slice(1).join("/");
            } else {
              originalPath = segments.join("/");
            }

            const destFileName = segments.length > 1
              ? `${segments[0]}_${segments.slice(1).join("__")}`
              : segments[0];
            const dest = await copyConflictFileVerified(file, `${canonicalConflictsDir}/${destFileName}`);

            if (!metaRecords.some((r) => r.snapshotPath === dest)) {
              // Register metadata
              const migratedBytes = new Uint8Array(await app.vault.adapter.readBinary(dest));
              const remoteSha = await calculateRawGitBlobSha(migratedBytes);
              let localSha = "";
              const localFile = app.vault.getAbstractFileByPath(originalPath);
              if (localFile instanceof TFile) {
                const localBytes = await app.vault.readBinary(localFile);
                localSha = await calculateCanonicalGitBlobSha(localBytes, originalPath);
              }

              metaRecords.push({
                id: `legacy_${detectedAt}_${dest.split("/").pop() || destFileName}`,
                path: originalPath,
                localSha: localSha || remoteSha,
                remoteSha,
                detectedAt,
                snapshotPath: dest,
              });
            }

            legacyConflictFilesToRemove.push(file);
          }
          didMigrateSomething = true;
        }

        inspectLegacyRootAfterMigration = true;
      }

      // Save updated metadata to canonical storage
      if (metaRecords.length > 0) {
        await this.saveConflictRecords(app, metaRecords);
      }

      for (const file of legacyConflictFilesToRemove) {
        await app.vault.adapter.remove(file);
      }
      if (legacyConflictFilesToRemove.length > 0) {
        await deleteDirectoryRecursively(LEGACY_CONFLICTS_DIR);
      }
      if (inspectLegacyRootAfterMigration && (await app.vault.adapter.exists(LEGACY_ROOT_DIR))) {
        const rootList = await app.vault.adapter.list(LEGACY_ROOT_DIR);
        const hasRemainingContent = rootList.files.length > 0 || rootList.folders.length > 0;
        if (hasRemainingContent) {
          console.info("[Vault Relay] Preserving _vault-relay/ as user-owned content");
        } else {
          await deleteDirectoryRecursively(LEGACY_ROOT_DIR);
        }
      }
      if (cleanupIntermediateC4) {
        await deleteDirectoryRecursively(intermediateC4Dir);
      }

      return { migrated: didMigrateSomething };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Vault Relay] Storage migration failed:", msg);
      return { migrated: false, error: msg };
    }
  }
}
