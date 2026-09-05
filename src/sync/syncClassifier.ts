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
  if (state?.files) {
    for (const path of Object.keys(state.files)) {
      allPaths.add(path);
    }
  }

  const items: SyncPreviewItem[] = [];
  const counts: SyncCategoryCounts = {
    LOCAL_ONLY: 0,
    REMOTE_ONLY: 0,
    LOCAL_CHANGED: 0,
    REMOTE_CHANGED: 0,
    POTENTIAL_CONFLICT: 0,
    UNCHANGED: 0,
    LOCAL_DELETED: 0,
    REMOTE_DELETED: 0,
    DELETE_CONFLICT: 0,
    DELETED: 0,
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
    let deleteConflictType: "LOCAL_DELETED_REMOTE_MODIFIED" | "REMOTE_DELETED_LOCAL_MODIFIED" | undefined;

    if (local && !remote) {
      // Local exists, Remote absent
      if (!fileState) {
        category = "LOCAL_ONLY";
        details = "File exists in local vault but is not present in remote Git repository.";
      } else {
        // Baseline exists: remote deletion vs local modification check
        const matchesBase = local.sha === fileState.localSha || local.sha === fileState.remoteSha;
        if (matchesBase) {
          category = "REMOTE_DELETED";
          details = "Deleted remotely on GitHub while local file remains unchanged.";
        } else {
          category = "DELETE_CONFLICT";
          deleteConflictType = "REMOTE_DELETED_LOCAL_MODIFIED";
          details = "File was deleted remotely on GitHub, but has local modifications.";
        }
      }
    } else if (!local && remote) {
      // Local absent, Remote exists
      if (!fileState) {
        category = "REMOTE_ONLY";
        details = "File exists in remote Git repository but is not present in local vault.";
      } else {
        // Baseline exists: local deletion vs remote modification check
        const matchesBase = remote.sha === fileState.remoteSha || remote.sha === fileState.localSha;
        if (matchesBase) {
          category = "LOCAL_DELETED";
          details = "Deleted locally while remote Git repository remains unchanged.";
        } else {
          category = "DELETE_CONFLICT";
          deleteConflictType = "LOCAL_DELETED_REMOTE_MODIFIED";
          details = "File was deleted locally, but has been modified remotely on GitHub.";
        }
      }
    } else if (!local && !remote) {
      // Both absent but entry in baseline -> converged deleted
      if (fileState) {
        category = "DELETED";
        details = "Deleted both locally and remotely. Synchronized baseline entry will be removed.";
      } else {
        continue;
      }
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
          const localModified = local.sha !== fileState.localSha && local.sha !== fileState.remoteSha;
          const remoteModified = remote.sha !== fileState.remoteSha && remote.sha !== fileState.localSha;

          if (localModified && !remoteModified) {
            category = "LOCAL_CHANGED";
            details = "Modified locally since last sync. Remote is unchanged.";
          } else if (!localModified && remoteModified) {
            category = "REMOTE_CHANGED";
            details = "Modified remotely on GitHub since last sync. Local is unchanged.";
          } else if (!localModified && !remoteModified) {
            category = "UNCHANGED";
            details = "Local and remote versions match their reviewed sync baseline.";
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
      deleteConflictType,
    });
  }

  // Exact-SHA move detection (safe pairing of DELETE + ADD)
  const pairedDestinationPaths = new Set<string>();

  // 1. Local Moves: LOCAL_DELETED + LOCAL_ONLY with matching content SHA
  const localDeletions = items.filter((it) => it.category === "LOCAL_DELETED");
  for (const delItem of localDeletions) {
    if (!delItem.baseSha) continue;
    const match = items.find(
      (it) =>
        it.category === "LOCAL_ONLY" &&
        it.localSha === delItem.baseSha &&
        !pairedDestinationPaths.has(it.path)
    );
    if (match) {
      delItem.isMove = true;
      delItem.movedTo = match.path;
      delItem.details = `Moved locally to ${match.path}.`;
      match.isMove = true;
      match.movedFrom = delItem.path;
      match.details = `Moved locally from ${delItem.path}.`;
      pairedDestinationPaths.add(match.path);
    }
  }

  // 2. Remote Moves: REMOTE_DELETED + REMOTE_ONLY with matching content SHA
  const remoteDeletions = items.filter((it) => it.category === "REMOTE_DELETED");
  for (const delItem of remoteDeletions) {
    if (!delItem.baseSha) continue;
    const match = items.find(
      (it) =>
        it.category === "REMOTE_ONLY" &&
        it.remoteSha === delItem.baseSha &&
        !pairedDestinationPaths.has(it.path)
    );
    if (match) {
      delItem.isMove = true;
      delItem.movedTo = match.path;
      delItem.details = `Moved remotely to ${match.path}.`;
      match.isMove = true;
      match.movedFrom = delItem.path;
      match.details = `Moved remotely from ${delItem.path}.`;
      pairedDestinationPaths.add(match.path);
    }
  }

  return { items, counts };
}
