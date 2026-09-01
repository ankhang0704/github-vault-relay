/**
 * Sync Types and Category Definitions for Vault Relay
 */

export type SyncCategory =
  | "LOCAL_ONLY"
  | "REMOTE_ONLY"
  | "LOCAL_CHANGED"
  | "REMOTE_CHANGED"
  | "POTENTIAL_CONFLICT"
  | "UNCHANGED";

export interface SyncPreviewItem {
  path: string;
  category: SyncCategory;
  localSha?: string;
  remoteSha?: string;
  baseSha?: string;
  size?: number;
  details?: string;
}

export interface SyncCategoryCounts {
  LOCAL_ONLY: number;
  REMOTE_ONLY: number;
  LOCAL_CHANGED: number;
  REMOTE_CHANGED: number;
  POTENTIAL_CONFLICT: number;
  UNCHANGED: number;
}

export interface SyncPreviewReport {
  timestamp: number;
  branch: string;
  remoteCommitSha?: string;
  remoteTreeSha?: string;
  items: SyncPreviewItem[];
  counts: SyncCategoryCounts;
  totalScannedLocal: number;
  totalScannedRemote: number;
  truncatedRemoteTree: boolean;
}

export interface LocalFileEntry {
  path: string;
  sha: string;
  size: number;
  mtime?: number;
}

export interface RemoteBlobEntry {
  path: string;
  sha: string;
  size?: number;
  mode?: string;
}

export interface FileSyncStateEntry {
  remoteSha: string;
  localSha: string;
  syncedAt: number;
}

export interface SyncStateData {
  version: number;
  lastSyncedCommitSha?: string;
  lastSyncedAt?: number;
  files: Record<string, FileSyncStateEntry>;
}
