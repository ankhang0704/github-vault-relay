/**
 * Storage Manager for Vault Relay
 *
 * Manages plugin-private internal state and conflict snapshots under
 * Obsidian's hidden configuration directory (${app.vault.configDir}/plugins/github-vault-relay/).
 *
 * Ensures normal vault content is 100% clean of _vault-relay files.
 * Provides idempotent, crash-safe migration from legacy _vault-relay directories.
 */

import { App, TFile } from "obsidian";
import { calculateRawGitBlobSha, calculateCanonicalGitBlobSha } from "./hashUtils";
import { SyncStateData } from "./syncTypes";
import { createEmptyState, deserializeState, serializeState } from "./syncState";

export const PLUGIN_ID = "github-vault-relay";
export const LEGACY_ROOT_DIR = "_vault-relay";
export const LEGACY_STATE_FILE = "_vault-relay/state.json";
export const LEGACY_CONFLICTS_DIR = "_vault-relay/conflicts";

export class StorageManager {
  /**
   * Returns the internal plugin storage directory path.
   * Example: .obsidian/plugins/github-vault-relay
   */
  /**
   * Returns the internal plugin storage directory path.
   * Example: .obsidian/vault-relay
   * Stored directly under configDir (.obsidian/vault-relay) so it is:
   * 1. 100% hidden from user vault notes.
   * 2. Completely safe from BRAT updates/reinstalls (BRAT wipes .obsidian/plugins/github-vault-relay).
   * 3. Completely safe from Obsidian Community Plugin updates.
   */
  public static getPluginStorageDir(app: App): string {
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
   */
  public static getStateFilePath(app: App): string {
    return `${this.getPluginStorageDir(app)}/state.json`;
  }

  /**
   * Returns the internal conflicts directory path.
   */
  public static getConflictsDirPath(app: App): string {
    return `${this.getPluginStorageDir(app)}/conflicts`;
  }

  /**
   * Loads sync state from internal storage, falling back to legacy path if not yet migrated.
   */
  public static async loadState(app: App): Promise<SyncStateData> {
    const internalPath = this.getStateFilePath(app);

    // 1. Try reading from internal storage
    if (await app.vault.adapter.exists(internalPath)) {
      try {
        const content = await app.vault.adapter.read(internalPath);
        return deserializeState(content);
      } catch (err) {
        console.warn(`[Vault Relay] Failed to read internal state at ${internalPath}:`, err);
      }
    }

    // 2. Fall back to intermediate plugin-dir state if present
    const intermediatePath = this.getIntermediatePluginStateFilePath(app);
    if (await app.vault.adapter.exists(intermediatePath)) {
      try {
        const content = await app.vault.adapter.read(intermediatePath);
        return deserializeState(content);
      } catch (err) {
        console.warn(`[Vault Relay] Failed to read intermediate state at ${intermediatePath}:`, err);
      }
    }

    // 3. Fall back to legacy root path if present
    if (await app.vault.adapter.exists(LEGACY_STATE_FILE)) {
      try {
        const content = await app.vault.adapter.read(LEGACY_STATE_FILE);
        return deserializeState(content);
      } catch (err) {
        console.warn(`[Vault Relay] Failed to read legacy state at ${LEGACY_STATE_FILE}:`, err);
      }
    }

    return createEmptyState();
  }

  /**
   * Saves sync state to internal storage.
   */
  public static async saveState(app: App, state: SyncStateData): Promise<void> {
    const internalPath = this.getStateFilePath(app);
    const serialized = serializeState(state);

    const dir = this.getPluginStorageDir(app);
    if (!(await app.vault.adapter.exists(dir))) {
      await app.vault.adapter.mkdir(dir);
    }

    await app.vault.adapter.write(internalPath, serialized);
  }

  /**
   * Preserves a conflict payload in internal plugin storage.
   * Returns the relative path within internal conflicts.
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
    const cleanPath = originalPath.replace(/[\\/]/g, "_");
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
   * Idempotent, crash-safe migration from legacy _vault-relay folder to internal plugin storage.
   */
    /**
   * Idempotent, crash-safe migration from legacy _vault-relay folder to internal plugin storage.
   * Recursively discovers all legacy conflict copies (including nested C3 timestamped folders)
   * and moves them into .obsidian/vault-relay/conflicts/ with byte-exact verification.
   * Registers migrated conflicts in conflicts_meta.json so they appear in Conflict Review.
   * Recursively deletes _vault-relay only after 100% verified copy.
   */
  public static async migrateLegacyStorage(app: App): Promise<{ migrated: boolean; error?: string }> {
    try {
      const hasLegacyState = await app.vault.adapter.exists(LEGACY_STATE_FILE);
      const hasLegacyDir = await app.vault.adapter.exists(LEGACY_ROOT_DIR);
      const intermediatePath = this.getIntermediatePluginStateFilePath(app);
      const hasIntermediateState = await app.vault.adapter.exists(intermediatePath);

      if (!hasLegacyState && !hasLegacyDir && !hasIntermediateState) {
        return { migrated: false };
      }

      // Ensure internal directories exist
      const internalDir = this.getPluginStorageDir(app);
      if (!(await app.vault.adapter.exists(internalDir))) {
        await app.vault.adapter.mkdir(internalDir);
      }
      const internalConflictsDir = this.getConflictsDirPath(app);
      if (!(await app.vault.adapter.exists(internalConflictsDir))) {
        await app.vault.adapter.mkdir(internalConflictsDir);
      }

      const internalStatePath = this.getStateFilePath(app);
      const internalStateExists = await app.vault.adapter.exists(internalStatePath);

      // 1. Migrate state.json if not already migrated
      if ((hasLegacyState || hasIntermediateState) && !internalStateExists) {
        const sourcePath = hasIntermediateState ? intermediatePath : LEGACY_STATE_FILE;
        const legacyContent = await app.vault.adapter.read(sourcePath);
        // Strict JSON validation: throws on syntax corruption, ensuring legacy file is kept
        JSON.parse(legacyContent);
        const parsed = deserializeState(legacyContent);
        await app.vault.adapter.write(internalStatePath, serializeState(parsed));

        // Verify written file
        const verifyContent = await app.vault.adapter.read(internalStatePath);
        const verifyParsed = deserializeState(verifyContent);
        if (Object.keys(verifyParsed.files).length !== Object.keys(parsed.files).length) {
          throw new Error("Verification failed: Migrated state file record count mismatch.");
        }
      }

      // Helper for recursive file listing
      const listFilesRecursively = async (dir: string): Promise<string[]> => {
        const results: string[] = [];
        if (!app.vault.adapter.list) return results;
        try {
          const res = await app.vault.adapter.list(dir);
          if (res && res.files) {
            results.push(...res.files);
          }
          if (res && res.folders) {
            for (const folder of res.folders) {
              const sub = await listFilesRecursively(folder);
              results.push(...sub);
            }
          }
        } catch (e) {
          console.warn(`[Vault Relay] Error listing ${dir}:`, e);
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
                try {
                  await app.vault.adapter.remove(file);
                } catch (e) {
                  console.warn(`[Vault Relay] Failed to remove file ${file}:`, e);
                }
              }
            }
            if (res && res.folders) {
              for (const folder of res.folders) {
                await deleteDirectoryRecursively(folder);
              }
            }
          } catch (e) {
            console.warn(`[Vault Relay] Failed to list folder for deletion ${dir}:`, e);
          }
        }
        if (app.vault.adapter.rmdir) {
          try {
            await app.vault.adapter.rmdir(dir, true);
          } catch (e) {
            console.warn(`[Vault Relay] Rmdir failed for ${dir}:`, e);
          }
        }
        try {
          const abstract = app.vault.getAbstractFileByPath(dir);
          const vaultWithDelete = app.vault as unknown as { delete?: (f: unknown, force?: boolean) => Promise<void> };
          if (abstract && typeof vaultWithDelete.delete === "function") {
            await vaultWithDelete.delete(abstract, true);
          }
        } catch (e) {
          console.warn(`[Vault Relay] Delete abstract file failed for ${dir}:`, e);
        }
      };

      // 2. Migrate legacy conflicts if present
      const hasLegacyConflicts = await app.vault.adapter.exists(LEGACY_CONFLICTS_DIR);
      if (hasLegacyConflicts) {
        const legacyFiles = await listFilesRecursively(LEGACY_CONFLICTS_DIR);
        const metaPath = `${internalDir}/conflicts_meta.json`;
        let metaRecords: Array<{
          id: string;
          path: string;
          localSha: string;
          remoteSha: string;
          detectedAt: number;
          snapshotPath?: string;
        }> = [];

        if (await app.vault.adapter.exists(metaPath)) {
          try {
            metaRecords = JSON.parse(await app.vault.adapter.read(metaPath));
          } catch (e) {
            console.warn("[Vault Relay] Failed to parse existing metadata:", e);
          }
        }

        for (const file of legacyFiles) {
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
          const dest = `${internalConflictsDir}/${destFileName}`;

          if (!(await app.vault.adapter.exists(dest))) {
            const buf = await app.vault.adapter.readBinary(file);
            await app.vault.adapter.writeBinary(dest, buf);

            // Byte-exact verification: length and content comparison
            const verifyBuf = await app.vault.adapter.readBinary(dest);
            if (verifyBuf.byteLength !== buf.byteLength) {
              throw new Error(`Verification failed: Byte length mismatch for migrated conflict ${file}`);
            }
            const srcBytes = new Uint8Array(buf);
            const destBytes = new Uint8Array(verifyBuf);
            for (let i = 0; i < srcBytes.length; i++) {
              if (srcBytes[i] !== destBytes[i]) {
                throw new Error(`Verification failed: Byte content mismatch for migrated conflict ${file}`);
              }
            }

            // Register in metadata so ConflictResolutionModal displays it
            const remoteSha = await calculateRawGitBlobSha(srcBytes);
            let localSha = "";
            const localFile = app.vault.getAbstractFileByPath(originalPath);
            if (localFile instanceof TFile) {
              const localBytes = await app.vault.readBinary(localFile);
              localSha = await calculateCanonicalGitBlobSha(localBytes, originalPath);
            }

            if (!metaRecords.some((r) => r.path === originalPath)) {
              metaRecords.push({
                id: `legacy_${detectedAt}_${destFileName}`,
                path: originalPath,
                localSha: localSha || remoteSha,
                remoteSha,
                detectedAt,
                snapshotPath: dest,
              });
            }
          }
        }

        if (metaRecords.length > 0) {
          await app.vault.adapter.write(metaPath, JSON.stringify(metaRecords, null, 2));
        }
      }

      // 3. Clean up legacy directory only after successful copy and verification
      try {
        if (hasLegacyDir) {
          await deleteDirectoryRecursively(LEGACY_ROOT_DIR);
        }
        if (hasIntermediateState) {
          await app.vault.adapter.remove(intermediatePath);
        }
      } catch (cleanErr) {
        console.warn("[Vault Relay] Failed to clean up legacy _vault-relay directory:", cleanErr);
      }

      return { migrated: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Vault Relay] Storage migration failed:", msg);
      return { migrated: false, error: msg };
    }
    }
}
