/**
 * Sync Types and Category Definitions for Vault Relay
 */

export type SyncCategory =
  | "LOCAL_ONLY"
  | "REMOTE_ONLY"
  | "LOCAL_CHANGED"
  | "REMOTE_CHANGED"
  | "POTENTIAL_CONFLICT"
  | "UNCHANGED"
  | "LOCAL_DELETED"
  | "REMOTE_DELETED"
  | "DELETE_CONFLICT"
  | "DELETED";

export interface SyncPreviewItem {
  path: string;
  category: SyncCategory;
  localSha?: string;
  remoteSha?: string;
  baseSha?: string;
  size?: number;
  details?: string;
  isOversized?: boolean;
  unsafeReason?: string;
  isMove?: boolean;
  movedFrom?: string;
  movedTo?: string;
  deleteConflictType?: "LOCAL_DELETED_REMOTE_MODIFIED" | "REMOTE_DELETED_LOCAL_MODIFIED";
}

export interface SyncCategoryCounts {
  LOCAL_ONLY: number;
  REMOTE_ONLY: number;
  LOCAL_CHANGED: number;
  REMOTE_CHANGED: number;
  POTENTIAL_CONFLICT: number;
  UNCHANGED: number;
  LOCAL_DELETED: number;
  REMOTE_DELETED: number;
  DELETE_CONFLICT: number;
  DELETED: number;
  OVERSIZED: number;
  UNSAFE: number;
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
  caseCollisions: Array<{ key: string; paths: string[] }>;
  timings?: SyncPreviewTimings;
}

export interface SyncPreviewTimings {
  remoteHeadMs: number;
  remoteTreeMs: number;
  localScanMs: number;
  classificationMs: number;
  totalMs: number;
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

export type PullActionType =
  | "PULL_CREATE"
  | "PULL_UPDATE"
  | "PULL_DELETE"
  | "PRESERVE_CONFLICT"
  | "ESTABLISH_BASELINE"
  | "SKIP_UNCHANGED"
  | "SKIP_LOCAL_ONLY"
  | "SKIP_LOCAL_CHANGED"
  | "SKIP_OVERSIZED"
  | "SKIP_UNSAFE"
  | "UPDATE_STATE";

export type PullItemStatus =
  | "SUCCESS"
  | "CONFLICT_PRESERVED"
  | "SKIPPED"
  | "FAILED";

export interface PullFileResult {
  path: string;
  action: PullActionType;
  status: PullItemStatus;
  localSha?: string;
  remoteSha?: string;
  conflictPath?: string;
  message?: string;
}

export interface PullExecutionReport {
  timestamp: number;
  branch: string;
  remoteCommitSha?: string;
  status: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "ABORTED";
  results: PullFileResult[];
  counts: {
    pulledCreated: number;
    pulledUpdated: number;
    pulledDeleted: number;
    pulledMoved?: number;
    conflictsPreserved: number;
    unchanged: number;
    skippedLocalOnly: number;
    skippedLocalChanged: number;
    skippedOversized: number;
    skippedUnsafe: number;
    failed: number;
  };
  summaryMessage: string;
}

export type PushActionType =
  | "PUSH_CREATE"
  | "PUSH_UPDATE"
  | "PUSH_DELETE"
  | "SKIP_UNCHANGED"
  | "SKIP_REMOTE_ONLY"
  | "SKIP_REMOTE_CHANGED"
  | "SKIP_CONFLICT"
  | "SKIP_OVERSIZED"
  | "SKIP_UNSAFE";

export type PushItemStatus =
  | "SUCCESS"
  | "SKIPPED"
  | "BLOCKED_CONFLICT"
  | "FAILED";

export interface PushFileResult {
  path: string;
  action: PushActionType;
  status: PushItemStatus;
  localSha?: string;
  remoteBlobSha?: string;
  message?: string;
}

export type PushExecutionStatus = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "ABORTED";

export interface PushExecutionReport {
  timestamp: number;
  branch: string;
  baseCommitSha?: string;
  newCommitSha?: string;
  status: PushExecutionStatus;
  results: PushFileResult[];
  counts: {
    pushedCreated: number;
    pushedUpdated: number;
    pushedDeleted: number;
    pushedMoved?: number;
    unchanged: number;
    skippedRemoteOnly: number;
    skippedRemoteChanged: number;
    skippedConflicts: number;
    skippedOversized: number;
    skippedUnsafe: number;
    failed: number;
  };
  summaryMessage: string;
}
