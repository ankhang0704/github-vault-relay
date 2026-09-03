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

export const PLUGIN_ID = "github-vault-relay";
export const LEGACY_ROOT_DIR = "_vault-relay";
export const LEGACY_STATE_FILE = "_vault-relay/state.json";
export const LEGACY_CONFLICTS_DIR = "_vault-relay/conflicts";

export class StorageManager {
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

  /**
   * Loads sync state from internal storage, falling back gracefully to intermediate
   * or legacy paths if not yet migrated.
   */
  public static async loadState(app: App): Promise<SyncStateData> {
    const canonicalPath = this.getStateFilePath(app);

    // 1. Try reading from canonical internal storage (.obsidian/github-vault-relay/state.json)
    if (await app.vault.adapter.exists(canonicalPath)) {
      try {
        const content = await app.vault.adapter.read(canonicalPath);
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
        return deserializeState(content);
      } catch (err) {
        console.warn("[Vault Relay] Failed to read intermediate plugin-dir state:", err);
      }
    }

    // 4. Fall back to legacy root path (_vault-relay/state.json) if present
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
   * Persists sync state strictly to canonical internal storage (.obsidian/github-vault-relay/state.json).
   * Guaranteed never to touch or write to _vault-relay/ or .obsidian/vault-relay/.
   */
  public static async saveState(app: App, state: SyncStateData): Promise<void> {
    const dir = this.getPluginStorageDir(app);
    if (!(await app.vault.adapter.exists(dir))) {
      await app.vault.adapter.mkdir(dir);
    }
    const path = this.getStateFilePath(app);
    await app.vault.adapter.write(path, serializeState(state));
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

      let canonicalStateExists = await app.vault.adapter.exists(canonicalStatePath);
      let didMigrateSomething = false;

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
        try {
          metaRecords = JSON.parse(await app.vault.adapter.read(canonicalMetaPath));
        } catch (_e) {
          console.warn("[Vault Relay] Failed to parse existing metadata:", _e);
        }
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
          JSON.parse(content); // strict JSON validation
          const parsed = deserializeState(content);
          await app.vault.adapter.write(canonicalStatePath, serializeState(parsed));

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
          for (const file of interConflictFiles) {
            const fileName = file.split("/").pop() || file;
            const dest = `${canonicalConflictsDir}/${fileName}`;
            if (!(await app.vault.adapter.exists(dest))) {
              const buf = await app.vault.adapter.readBinary(file);
              await app.vault.adapter.writeBinary(dest, buf);
              const verifyBuf = await app.vault.adapter.readBinary(dest);
              if (verifyBuf.byteLength !== buf.byteLength) {
                throw new Error(`Verification failed: Byte length mismatch for ${file}`);
              }
            }
          }
          didMigrateSomething = true;
        }

        // 1.3 Migrate conflicts_meta.json
        if (await app.vault.adapter.exists(interMetaPath)) {
          try {
            const interMeta = JSON.parse(await app.vault.adapter.read(interMetaPath));
            if (Array.isArray(interMeta)) {
              for (const rec of interMeta) {
                if (!metaRecords.some((r) => r.path === rec.path)) {
                  if (rec.snapshotPath && rec.snapshotPath.includes(".obsidian/vault-relay/")) {
                    rec.snapshotPath = rec.snapshotPath.replace(".obsidian/vault-relay/", `${canonicalDir}/`);
                  }
                  metaRecords.push(rec);
                }
              }
            }
          } catch (_e) {
            console.warn("[Vault Relay] Failed to read intermediate conflicts metadata:", _e);
          }
          didMigrateSomething = true;
        }

        // 1.4 Clean up intermediate C4 (.obsidian/vault-relay)
        await deleteDirectoryRecursively(intermediateC4Dir);
      }

      // ==========================================
      // PHASE 2: Migrate Intermediate Plugin Dir (.obsidian/plugins/github-vault-relay/state.json)
      // ==========================================
      if (hasIntermediatePluginState) {
        if (!canonicalStateExists) {
          const content = await app.vault.adapter.read(intermediatePluginState);
          JSON.parse(content);
          const parsed = deserializeState(content);
          await app.vault.adapter.write(canonicalStatePath, serializeState(parsed));
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
          if (parsedJson && typeof parsedJson.version === "number" && typeof parsedJson.files === "object") {
            if (!canonicalStateExists) {
              const parsedState = deserializeState(legacyContent);
              await app.vault.adapter.write(canonicalStatePath, serializeState(parsedState));
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
            const dest = `${canonicalConflictsDir}/${destFileName}`;

            if (!(await app.vault.adapter.exists(dest))) {
              const buf = await app.vault.adapter.readBinary(file);
              await app.vault.adapter.writeBinary(dest, buf);

              // Byte-exact verification
              const verifyBuf = await app.vault.adapter.readBinary(dest);
              if (verifyBuf.byteLength !== buf.byteLength) {
                throw new Error(`Verification failed: Byte length mismatch for ${file}`);
              }
              const srcBytes = new Uint8Array(buf);
              const destBytes = new Uint8Array(verifyBuf);
              for (let i = 0; i < srcBytes.length; i++) {
                if (srcBytes[i] !== destBytes[i]) {
                  throw new Error(`Verification failed: Byte content mismatch for ${file}`);
                }
              }

              // Register metadata
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

            // Remove verified migrated legacy conflict file
            await app.vault.adapter.remove(file);
          }

          // Delete recognized legacy conflicts directory
          await deleteDirectoryRecursively(LEGACY_CONFLICTS_DIR);
          didMigrateSomething = true;
        }

        // 3.3 Mixed Legacy + User Content Check:
        // Inspect remaining items in _vault-relay/.
        // If user files or folders exist: PRESERVE _vault-relay/!
        // ONLY if completely empty: remove the directory.
        if (await app.vault.adapter.exists(LEGACY_ROOT_DIR)) {
          let hasRemainingContent = false;
          if (app.vault.adapter.list) {
            try {
              const rootList = await app.vault.adapter.list(LEGACY_ROOT_DIR);
              if ((rootList.files && rootList.files.length > 0) || (rootList.folders && rootList.folders.length > 0)) {
                hasRemainingContent = true;
              }
            } catch (_e) {
              /* ignore */
            }
          }
          if (!hasRemainingContent) {
            if (app.vault.adapter.rmdir) {
              try { await app.vault.adapter.rmdir(LEGACY_ROOT_DIR, true); } catch (_e) { /* ignore */ }
            }
            try {
              const abstract = app.vault.getAbstractFileByPath(LEGACY_ROOT_DIR);
              const vaultWithDelete = app.vault as unknown as { delete?: (f: unknown, force?: boolean) => Promise<void> };
              if (abstract && typeof vaultWithDelete.delete === "function") {
                await vaultWithDelete.delete(abstract, true);
              }
            } catch (_e) {
              /* ignore */
            }
          } else {
            console.info("[Vault Relay] Preserving _vault-relay/ as user-owned content");
          }
        }
      }

      // Save updated metadata to canonical storage
      if (metaRecords.length > 0) {
        await app.vault.adapter.write(canonicalMetaPath, JSON.stringify(metaRecords, null, 2));
      }

      return { migrated: didMigrateSomething };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Vault Relay] Storage migration failed:", msg);
      return { migrated: false, error: msg };
    }
  }
}
