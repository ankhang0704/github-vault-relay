/**
 * Sync Engine for Vault Relay
 *
 * Scans local Obsidian vault, fetches remote GitHub Git tree,
 * and produces a read-only sync classification report with case collision checks.
 */

import { App, TFile } from "obsidian";
import { GitHubClient } from "../github/githubClient";
import { VaultRelaySettings } from "../settings";
import { calculateCanonicalGitBlobSha } from "./hashUtils";
import { isPathExcluded } from "./pathFilter";
import { classifySyncState } from "./syncClassifier";
import { deserializeState, STATE_FILE_PATH } from "./syncState";
import { detectCaseCollisions } from "./pathSafety";
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
        token: "",
        owner: settings.owner,
        repo: settings.repo,
        branch: settings.branch,
      });
  }

  /**
   * Scans local files in the Obsidian vault, computing canonical Git hashes.
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
      // Return undefined if state file does not exist
    }
    return undefined;
  }

  /**
   * Generates a complete Read-Only Sync Preview.
   */
  public async generatePreview(): Promise<SyncPreviewReport> {
    const branchName = this.settings.branch || "main";

    // 1. Fetch fresh remote branch HEAD
    const branchInfo = await this.githubClient.getBranch(branchName);
    const remoteCommitSha = branchInfo.commit.sha;
    const treeSha = branchInfo.commit.commit?.tree?.sha || branchInfo.commit.sha;

    // 2. Fetch remote tree recursively
    const treeResponse = await this.githubClient.getTreeRecursive(treeSha);

    // 3. Filter remote blobs
    const remoteBlobs = new Map<string, RemoteBlobEntry>();
    const remotePaths: string[] = [];

    for (const item of treeResponse.tree) {
      if (item.type !== "blob") continue;
      if (isPathExcluded(item.path, this.settings.excludedPaths)) continue;

      remoteBlobs.set(item.path, {
        path: item.path,
        sha: item.sha,
        size: item.size,
        mode: item.mode,
      });
      remotePaths.push(item.path);
    }

    // 4. Scan local vault
    const localFiles = await this.scanLocalVault();

    // 5. Detect case collisions
    const allScannedPaths = Array.from(new Set([...localFiles.keys(), ...remotePaths]));
    const collisionMap = detectCaseCollisions(allScannedPaths);
    const caseCollisions: Array<{ key: string; paths: string[] }> = [];
    for (const [key, paths] of collisionMap.entries()) {
      caseCollisions.push({ key, paths });
    }

    // 6. Load state
    const state = await this.loadLocalState();

    // 7. Run pure classification
    const { items, counts } = classifySyncState({
      localFiles,
      remoteBlobs,
      state,
      excludedPaths: this.settings.excludedPaths,
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
      caseCollisions,
    };
  }
}
