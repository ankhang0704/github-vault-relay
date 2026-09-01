/**
 * Sync Engine for Vault Relay (Checkpoint 1: Read-Only Preview)
 *
 * Scans local Obsidian vault, fetches remote GitHub Git tree,
 * and produces a read-only sync classification report.
 *
 * Strictly NO file creation, modification, deletion, git commits, or uploads.
 */

import { App, TFile } from "obsidian";
import { GitHubClient } from "../github/githubClient";
import { VaultRelaySettings } from "../settings";
import { calculateGitBlobSha } from "./hashUtils";
import { isPathExcluded } from "./pathFilter";
import { classifySyncState } from "./syncClassifier";
import { deserializeState, STATE_FILE_PATH } from "./syncState";
import {
  LocalFileEntry,
  RemoteBlobEntry,
  SyncPreviewReport,
  SyncStateData,
} from "./syncTypes";

export class SyncEngine {
  private app: App;
  private settings: VaultRelaySettings;
  private githubClient: GitHubClient;

  constructor(app: App, settings: VaultRelaySettings, githubClient?: GitHubClient) {
    this.app = app;
    this.settings = settings;
    this.githubClient =
      githubClient ||
      new GitHubClient({
        token: settings.token,
        owner: settings.owner,
        repo: settings.repo,
        branch: settings.branch,
      });
  }

  /**
   * Scans local files in the Obsidian vault, filtering out excluded directories.
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
        const sha = await calculateGitBlobSha(binaryContent);

        localFiles.set(file.path, {
          path: file.path,
          sha,
          size: file.stat.size,
          mtime: file.stat.mtime,
        });
      } catch (err) {
        console.warn(`[Vault Relay] Failed to calculate hash for ${file.path}:`, err);
      }
    }

    return localFiles;
  }

  /**
   * Loads the local state file (_vault-relay/state.json) if it exists.
   */
  public async loadLocalState(): Promise<SyncStateData | undefined> {
    try {
      const stateFile = this.app.vault.getAbstractFileByPath(STATE_FILE_PATH);
      if (stateFile instanceof TFile) {
        const content = await this.app.vault.read(stateFile);
        return deserializeState(content);
      }
    } catch {
      // If state does not exist or cannot be read, return undefined
    }
    return undefined;
  }

  /**
   * Generates a complete Read-Only Sync Preview.
   */
  public async generatePreview(): Promise<SyncPreviewReport> {
    const branchName = this.settings.branch || "main";

    // 1. Fetch remote branch HEAD
    const branchInfo = await this.githubClient.getBranch(branchName);
    const remoteCommitSha = branchInfo.commit.sha;
    const treeSha = branchInfo.commit.commit?.tree?.sha || branchInfo.commit.sha;

    // 2. Fetch remote tree recursively
    const treeResponse = await this.githubClient.getTreeRecursive(treeSha);

    // 3. Filter remote blobs
    const remoteBlobs = new Map<string, RemoteBlobEntry>();
    for (const item of treeResponse.tree) {
      if (item.type !== "blob") continue;
      if (isPathExcluded(item.path, this.settings.excludedPaths)) continue;

      remoteBlobs.set(item.path, {
        path: item.path,
        sha: item.sha,
        size: item.size,
        mode: item.mode,
      });
    }

    // 4. Scan local vault
    const localFiles = await this.scanLocalVault();

    // 5. Load state (if available)
    const state = await this.loadLocalState();

    // 6. Run pure classification
    const { items, counts } = classifySyncState({
      localFiles,
      remoteBlobs,
      state,
    });

    return {
      timestamp: Date.now(),
      branch: branchName,
      remoteCommitSha,
      remoteTreeSha: treeResponse.sha,
      items,
      counts,
      totalScannedLocal: localFiles.size,
      totalScannedRemote: remoteBlobs.size,
      truncatedRemoteTree: !!treeResponse.truncated,
    };
  }
}
