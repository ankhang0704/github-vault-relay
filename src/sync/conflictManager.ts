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

export interface ConflictRecord {
  id: string;
  path: string;
  localSha: string;
  remoteSha: string;
  remoteCommitSha?: string;
  baseSha?: string;
  detectedAt: number;
  snapshotPath?: string;
}

export class ConflictManager {
  private app: App;
  private settings: VaultRelaySettings;
  private githubClient: GitHubClient;

  constructor(app: App, settings: VaultRelaySettings, githubClient: GitHubClient) {
    this.app = app;
    this.settings = settings;
    this.githubClient = githubClient;
  }

  private getMetadataPath(): string {
    return `${StorageManager.getPluginStorageDir(this.app)}/conflicts_meta.json`;
  }

  /**
   * Loads all active conflict records from internal storage.
   */
  public async loadConflictRecords(): Promise<ConflictRecord[]> {
    const metaPath = this.getMetadataPath();
    if (await this.app.vault.adapter.exists(metaPath)) {
      try {
        const raw = await this.app.vault.adapter.read(metaPath);
        return JSON.parse(raw);
      } catch (err) {
        console.warn("[Vault Relay] Failed to read conflicts metadata:", err);
      }
    }
    return [];
  }

  /**
   * Saves conflict records to internal storage.
   */
  public async saveConflictRecords(records: ConflictRecord[]): Promise<void> {
    const metaPath = this.getMetadataPath();
    const dir = StorageManager.getPluginStorageDir(this.app);
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(metaPath, JSON.stringify(records, null, 2));
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

    // 1. Ensure all active POTENTIAL_CONFLICT items exist in records
    for (const item of report.items) {
      if (item.category === "POTENTIAL_CONFLICT") {
        const existing = records.find((r) => r.path === item.path);
        if (!existing) {
          records.push({
            id: `${Date.now()}_${item.path.replace(/[\\/]/g, "_")}`,
            path: item.path,
            localSha: item.localSha || "",
            remoteSha: item.remoteSha || "",
            baseSha: item.baseSha,
            detectedAt: Date.now(),
          });
          modified = true;
        } else {
          if (item.localSha && existing.localSha !== item.localSha) {
            existing.localSha = item.localSha;
            modified = true;
          }
          if (item.remoteSha && existing.remoteSha !== item.remoteSha) {
            existing.remoteSha = item.remoteSha;
            modified = true;
          }
          if (item.baseSha && existing.baseSha !== item.baseSha) {
            existing.baseSha = item.baseSha;
            modified = true;
          }
        }
      }
    }

    // 2. Remove any records that are now confirmed UNCHANGED in the report
    const unchangedPaths = new Set(
      report.items.filter((i) => i.category === "UNCHANGED").map((i) => i.path)
    );
    const remaining = records.filter((r) => !unchangedPaths.has(r.path));
    if (remaining.length !== records.length) {
      records.length = 0;
      records.push(...remaining);
      modified = true;
    }

    if (modified) {
      await this.saveConflictRecords(records);
    }
    return records;
  }


  /**
   * Removes a conflict record after resolution.
   */
  public async removeConflict(path: string): Promise<void> {
    const records = await this.loadConflictRecords();
    const filtered = records.filter((r) => r.path !== path);
    await this.saveConflictRecords(filtered);
  }

  /**
   * Resolution: Keep Local
   * Local version becomes intended authority.
   * Revalidates remote state: if remote has advanced past record.remoteCommitSha, aborts.
   * Uses verified Safe Push path to update remote.
   */
  public async resolveKeepLocal(record: ConflictRecord): Promise<{ success: boolean; message: string }> {
    // 1. Revalidate remote state
    const branchInfo = await this.githubClient.getBranch(this.settings.branch, true);
    if (record.remoteCommitSha && branchInfo.commit.sha !== record.remoteCommitSha) {
      return {
        success: false,
        message: "Remote branch changed concurrently since conflict was reviewed. Please refresh and review again.",
      };
    }

    // 2. Push local version via PushEngine
    const pushEngine = new PushEngine(this.app, this.settings, this.githubClient);
    const report = await pushEngine.executeSafePush();

    if (report.status === "PASS" || report.status === "PASS_WITH_WARNINGS") {
      await this.removeConflict(record.path);
      return { success: true, message: `Successfully pushed local version for ${record.path}.` };
    }

    return {
      success: false,
      message: `Failed to push local resolution: ${report.summaryMessage}`,
    };
  }

  /**
   * Resolution: Use Remote
   * Remote version safely overwrites the local conflict file.
   * Pre-write check: verifies current local bytes still match reviewed localSha.
   */
  public async resolveUseRemote(record: ConflictRecord): Promise<{ success: boolean; message: string }> {
    const file = this.app.vault.getAbstractFileByPath(record.path);
    if (file instanceof TFile) {
      const currentBytes = await this.app.vault.readBinary(file);
      const currentLocalSha = await calculateCanonicalGitBlobSha(currentBytes, file.path);
      if (currentLocalSha.toLowerCase() !== record.localSha.toLowerCase()) {
        return {
          success: false,
          message: "Local file was modified since conflict was reviewed. Aborted to prevent data loss.",
        };
      }
    }

    // Fetch remote blob using verified getRawBlobBytes (integrity + 25 MiB ceiling checked)
    const bytes = await this.githubClient.getRawBlobBytes(record.remoteSha);

    // Overwrite local file
    if (file instanceof TFile) {
      await this.app.vault.modifyBinary(file, bytes.buffer as ArrayBuffer);
    } else {
      await this.app.vault.createBinary(record.path, bytes.buffer as ArrayBuffer);
    }

    // Update baseline in state
    const state = await StorageManager.loadState(this.app);
    state.files[record.path] = {
      localSha: record.remoteSha,
      remoteSha: record.remoteSha,
      syncedAt: Date.now(),
    };
    await StorageManager.saveState(this.app, state);

    await this.removeConflict(record.path);
    return { success: true, message: `Local file updated to remote version for ${record.path}.` };
  }

  /**
   * Resolution: Keep Both
   * Preserves local file untouched and saves remote version as a conflict copy.
   */
  public async resolveKeepBoth(record: ConflictRecord): Promise<{ success: boolean; message: string; copyPath?: string }> {
    // Fetch remote blob using verified getRawBlobBytes (integrity + 25 MiB ceiling checked)
    const bytes = await this.githubClient.getRawBlobBytes(record.remoteSha);

    // Generate deterministic collision-safe second filename
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

    const lastDot = record.path.lastIndexOf(".");
    const base = lastDot !== -1 ? record.path.substring(0, lastDot) : record.path;
    const ext = lastDot !== -1 ? record.path.substring(lastDot) : "";

    let copyPath = `${base} (remote conflict ${dateStr})${ext}`;
    let suffix = 1;
    while (this.app.vault.getAbstractFileByPath(copyPath)) {
      copyPath = `${base} (remote conflict ${dateStr}_${suffix})${ext}`;
      suffix++;
    }

    await this.app.vault.createBinary(copyPath, bytes.buffer as ArrayBuffer);

    // Update baseline state for local note
    const state = await StorageManager.loadState(this.app);
    if (!state.files[record.path]) {
      state.files[record.path] = {
        localSha: record.localSha,
        remoteSha: record.localSha,
        syncedAt: Date.now(),
      };
      await StorageManager.saveState(this.app, state);
    }

    await this.removeConflict(record.path);
    return {
      success: true,
      message: `Preserved both versions. Remote copy saved to: ${copyPath}`,
      copyPath,
    };
  }
}
