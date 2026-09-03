/**
 * Sync Engine for Vault Relay
 *
 * Scans local Obsidian vault, fetches remote GitHub Git tree,
 * and produces a read-only sync classification report with case collision checks.
 *
 * C4 Hardened:
 * - Uses authoritative, cache-safe Git ref reading (bypassing 60s edge/browser caches)
 * - Uses StorageManager for hidden plugin storage (.obsidian/plugins/github-vault-relay/)
 * - Incorporates high-performance LocalHashCache (mtime+size) for fast local scanning
 * - Collects truthful operation timings
 */

import { App } from "obsidian";
import { GitHubClient } from "../github/githubClient";
import { VaultRelaySettings } from "../settings";
import { calculateCanonicalGitBlobSha } from "./hashUtils";
import { isPathExcluded } from "./pathFilter";
import { classifySyncState } from "./syncClassifier";
import { StorageManager } from "./storageManager";
import { detectCaseCollisions } from "./pathSafety";
import {
  LocalFileEntry,
  RemoteBlobEntry,
  SyncPreviewReport,
  SyncPreviewTimings,
  SyncStateData,
} from "./syncTypes";

export interface HashCacheEntry {
  mtime: number;
  size: number;
  sha: string;
}

export class SyncEngine {
  private app: App;
  private settings: VaultRelaySettings;
  private githubClient: GitHubClient;
  private localHashCache = new Map<string, HashCacheEntry>();

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
   * Clears the in-memory local hash cache.
   */
  public clearLocalHashCache(): void {
    this.localHashCache.clear();
  }

  /**
   * Scans local files in the Obsidian vault, computing canonical Git hashes.
   * Utilizes mtime + size cache to avoid redundant SHA calculations on unchanged local files.
   */
  public async scanLocalVault(): Promise<Map<string, LocalFileEntry>> {
    const localFiles = new Map<string, LocalFileEntry>();
    const allVaultFiles = this.app.vault.getFiles();

    for (const file of allVaultFiles) {
      if (isPathExcluded(file.path, this.settings.excludedPaths)) {
        continue;
      }

      try {
        const mtime = file.stat.mtime;
        const size = file.stat.size;

        const cached = this.localHashCache.get(file.path);
        let sha: string;

        if (cached && cached.mtime === mtime && cached.size === size) {
          sha = cached.sha;
        } else {
          const binaryContent = await this.app.vault.readBinary(file);
          sha = await calculateCanonicalGitBlobSha(binaryContent, file.path);
          this.localHashCache.set(file.path, { mtime, size, sha });
        }

        localFiles.set(file.path, {
          path: file.path,
          sha,
          size,
          mtime,
        });
      } catch (err) {
        console.warn(`[Vault Relay] Failed to calculate hash for ${file.path}:`, err);
      }
    }

    return localFiles;
  }

  /**
   * Loads the local state file from internal storage.
   */
  public async loadLocalState(): Promise<SyncStateData | undefined> {
    try {
      return await StorageManager.loadState(this.app);
    } catch {
      return undefined;
    }
  }

  /**
   * Generates a complete Read-Only Sync Preview with authoritative cache-busting reads.
   */
  public async generatePreview(): Promise<SyncPreviewReport> {
    const branchName = (this.settings.branch || "main").trim();
    const tStart = Date.now();

    // 1. Fetch fresh remote branch HEAD authoritatively with cache-busting
    const branchInfo = await this.githubClient.getBranch(branchName, true);
    const remoteCommitSha = branchInfo.commit.sha;
    const treeSha = branchInfo.commit.commit?.tree?.sha || branchInfo.commit.sha;

    const tHead = Date.now();

    // 2. Fetch remote tree recursively
    const treeResponse = await this.githubClient.getTreeRecursive(treeSha);
    const tTree = Date.now();

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
    const tLocal = Date.now();

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

    const tClassify = Date.now();

    const timings: SyncPreviewTimings = {
      remoteHeadMs: tHead - tStart,
      remoteTreeMs: tTree - tHead,
      localScanMs: tLocal - tTree,
      classificationMs: tClassify - tLocal,
      totalMs: tClassify - tStart,
    };

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
      timings,
    };
  }
}
