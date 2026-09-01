/**
 * Pure Sync Classification Engine for Vault Relay
 *
 * Categorizes files into 6 states:
 * - LOCAL_ONLY
 * - REMOTE_ONLY
 * - LOCAL_CHANGED
 * - REMOTE_CHANGED
 * - POTENTIAL_CONFLICT
 * - UNCHANGED
 *
 * Also identifies oversized files (>25 MiB) and unsafe path segments.
 */

import { isOversized } from "./fileSizePolicy";
import { validatePathSafety } from "./pathSafety";
import {
  LocalFileEntry,
  RemoteBlobEntry,
  SyncCategory,
  SyncCategoryCounts,
  SyncPreviewItem,
  SyncStateData,
} from "./syncTypes";

export interface ClassificationInputs {
  localFiles: Map<string, LocalFileEntry>;
  remoteBlobs: Map<string, RemoteBlobEntry>;
  state?: SyncStateData;
  excludedPaths?: string[];
}

export interface ClassificationResult {
  items: SyncPreviewItem[];
  counts: SyncCategoryCounts;
}

/**
 * Pure function that classifies all files across local vault, remote tree, and sync state.
 */
export function classifySyncState(inputs: ClassificationInputs): ClassificationResult {
  const { localFiles, remoteBlobs, state, excludedPaths } = inputs;
  const allPaths = new Set<string>();

  for (const path of localFiles.keys()) {
    allPaths.add(path);
  }
  for (const path of remoteBlobs.keys()) {
    allPaths.add(path);
  }

  const items: SyncPreviewItem[] = [];
  const counts: SyncCategoryCounts = {
    LOCAL_ONLY: 0,
    REMOTE_ONLY: 0,
    LOCAL_CHANGED: 0,
    REMOTE_CHANGED: 0,
    POTENTIAL_CONFLICT: 0,
    UNCHANGED: 0,
    OVERSIZED: 0,
    UNSAFE: 0,
  };

  const sortedPaths = Array.from(allPaths).sort((a, b) => a.localeCompare(b));

  for (const path of sortedPaths) {
    const local = localFiles.get(path);
    const remote = remoteBlobs.get(path);
    const fileState = state?.files ? state.files[path] : undefined;

    // Validate path safety
    const pathCheck = validatePathSafety(path, excludedPaths);
    const isUnsafe = !pathCheck.valid;
    const oversized = isOversized(remote?.size || local?.size);

    if (isUnsafe) {
      counts.UNSAFE++;
    }
    if (oversized) {
      counts.OVERSIZED++;
    }

    let category: SyncCategory;
    let details: string | undefined;

    if (local && !remote) {
      // Exists locally only
      category = "LOCAL_ONLY";
      details = "File exists in local vault but is not present in remote Git repository.";
    } else if (!local && remote) {
      // Exists on remote only
      category = "REMOTE_ONLY";
      details = "File exists in remote Git repository but is not present in local vault.";
    } else if (local && remote) {
      // Exists in both
      if (local.sha === remote.sha) {
        category = "UNCHANGED";
        details = "Local and remote content hashes match.";
      } else {
        // Hashes differ
        if (!fileState) {
          category = "POTENTIAL_CONFLICT";
          details = "File exists both locally and remotely with differing content and no common sync base.";
        } else {
          const localModified = local.sha !== fileState.localSha;
          const remoteModified = remote.sha !== fileState.remoteSha;

          if (localModified && !remoteModified) {
            category = "LOCAL_CHANGED";
            details = "Modified locally since last sync. Remote is unchanged.";
          } else if (!localModified && remoteModified) {
            category = "REMOTE_CHANGED";
            details = "Modified remotely on GitHub since last sync. Local is unchanged.";
          } else {
            category = "POTENTIAL_CONFLICT";
            details = "Both local and remote versions have diverged since last sync.";
          }
        }
      }
    } else {
      continue;
    }

    counts[category]++;
    items.push({
      path,
      category,
      localSha: local?.sha,
      remoteSha: remote?.sha,
      baseSha: fileState?.remoteSha || fileState?.localSha,
      size: remote?.size || local?.size,
      details,
      isOversized: oversized,
      unsafeReason: pathCheck.reason,
    });
  }

  return { items, counts };
}
