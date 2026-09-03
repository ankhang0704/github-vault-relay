/**
 * Storage Manager for Vault Relay
 *
 * Manages plugin-private internal state and conflict snapshots under
 * Obsidian's hidden configuration directory (${app.vault.configDir}/plugins/github-vault-relay/).
 *
 * Ensures normal vault content is 100% clean of _vault-relay files.
 * Provides idempotent, crash-safe migration from legacy _vault-relay directories.
 */

import { App } from "obsidian";
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
  public static getPluginStorageDir(app: App): string {
    const configDir = (app.vault as unknown as { configDir?: string }).configDir || ".obsidian";
    return `${configDir}/plugins/${PLUGIN_ID}`;
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

    // 2. Fall back to legacy path if present
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
    const conflictFileName = `${timestamp}_${cleanPath}`;
    const targetPath = `${conflictsDir}/${conflictFileName}`;

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
  public static async migrateLegacyStorage(app: App): Promise<{ migrated: boolean; error?: string }> {
    try {
      const hasLegacyState = await app.vault.adapter.exists(LEGACY_STATE_FILE);
      const hasLegacyDir = await app.vault.adapter.exists(LEGACY_ROOT_DIR);

      if (!hasLegacyState && !hasLegacyDir) {
        return { migrated: false };
      }

      // Ensure internal directory exists
      const internalDir = this.getPluginStorageDir(app);
      if (!(await app.vault.adapter.exists(internalDir))) {
        await app.vault.adapter.mkdir(internalDir);
      }

      const internalStatePath = this.getStateFilePath(app);
      const internalStateExists = await app.vault.adapter.exists(internalStatePath);

      // 1. Migrate state.json if not already migrated
      if (hasLegacyState && !internalStateExists) {
        const legacyContent = await app.vault.adapter.read(LEGACY_STATE_FILE);
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

      // 2. Migrate legacy conflicts if present
      const hasLegacyConflicts = await app.vault.adapter.exists(LEGACY_CONFLICTS_DIR);
      if (hasLegacyConflicts && app.vault.adapter.list) {
        const internalConflictsDir = this.getConflictsDirPath(app);
        if (!(await app.vault.adapter.exists(internalConflictsDir))) {
          await app.vault.adapter.mkdir(internalConflictsDir);
        }

        try {
          const listResult = await app.vault.adapter.list(LEGACY_CONFLICTS_DIR);
          for (const file of listResult.files) {
            const fileName = file.split("/").pop() || file;
            const dest = `${internalConflictsDir}/${fileName}`;
            if (!(await app.vault.adapter.exists(dest))) {
              const buf = await app.vault.adapter.readBinary(file);
              await app.vault.adapter.writeBinary(dest, buf);
            }
          }
        } catch (conflictErr) {
          console.warn("[Vault Relay] Could not migrate all legacy conflicts:", conflictErr);
        }
      }

      // 3. Clean up legacy directory only after successful copy and verification
      try {
        if (app.vault.adapter.rmdir) {
          await app.vault.adapter.rmdir(LEGACY_ROOT_DIR, true);
        } else {
          // Fallback if rmdir is not available
          const legacyAbstract = app.vault.getAbstractFileByPath(LEGACY_ROOT_DIR);
          if (legacyAbstract && (app.vault as unknown as { delete?: (f: unknown) => Promise<void> }).delete) {
            await (app.vault as unknown as { delete: (f: unknown) => Promise<void> }).delete(legacyAbstract);
          }
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
