/**
 * Semantic Summary and Counting Layer for Vault Relay (C6)
 *
 * Provides unified, truthful semantic counts for Sync Preview, Confirm Modals,
 * Dashboard, and Result Modals.
 *
 * Core invariant:
 * - Exact-SHA paired moves (delete + add) are represented primarily as ONE Move.
 * - Suppresses misleading double-counting (1 move is NOT counted simultaneously
 *   as 1 Created + 1 Deleted + 1 Moved in user-facing summaries).
 * - Independent (unpaired) creates and deletes remain separate operations.
 */

import {
  SyncPreviewItem,
  PullExecutionReport,
  PushExecutionReport,
  SyncCategory,
} from "./syncTypes";

export interface SemanticPreviewCounts {
  // Local modifications to push to GitHub
  pushCreate: number;       // LOCAL_ONLY without isMove
  pushUpdate: number;       // LOCAL_CHANGED
  pushDeleteRemote: number; // LOCAL_DELETED without isMove
  pushMoves: number;        // Local move pairs

  // Remote modifications to pull locally
  pullCreate: number;       // REMOTE_ONLY without isMove
  pullUpdate: number;       // REMOTE_CHANGED
  pullRemoveLocal: number;  // REMOTE_DELETED without isMove
  pullMoves: number;        // Remote move pairs

  // Conflicts
  contentConflicts: number; // POTENTIAL_CONFLICT
  deleteConflicts: number;  // DELETE_CONFLICT
  totalConflicts: number;

  // Safety / Inactive
  oversized: number;
  unsafe: number;
  unchanged: number;

  // Aggregated semantic totals
  totalPushMutations: number;
  totalPullMutations: number;
  totalSemanticMoves: number;
}

/**
 * Computes user-oriented semantic counts from classified preview items.
 */
export function computeSemanticPreview(items: SyncPreviewItem[]): SemanticPreviewCounts {
  let pushCreate = 0;
  let pushUpdate = 0;
  let pushDeleteRemote = 0;
  let pushMoves = 0;

  let pullCreate = 0;
  let pullUpdate = 0;
  let pullRemoveLocal = 0;
  let pullMoves = 0;

  let contentConflicts = 0;
  let deleteConflicts = 0;
  let oversized = 0;
  let unsafe = 0;
  let unchanged = 0;

  for (const item of items) {
    if (item.isOversized) oversized++;
    if (item.unsafeReason) unsafe++;

    switch (item.category) {
      case "LOCAL_ONLY":
        if (item.isMove && item.movedFrom) {
          // Destination of a local move: counted once via LOCAL_DELETED
        } else {
          pushCreate++;
        }
        break;

      case "LOCAL_CHANGED":
        pushUpdate++;
        break;

      case "LOCAL_DELETED":
        if (item.isMove && item.movedTo) {
          pushMoves++;
        } else {
          pushDeleteRemote++;
        }
        break;

      case "REMOTE_ONLY":
        if (item.isMove && item.movedFrom) {
          // Destination of a remote move: counted once via REMOTE_DELETED
        } else {
          pullCreate++;
        }
        break;

      case "REMOTE_CHANGED":
        pullUpdate++;
        break;

      case "REMOTE_DELETED":
        if (item.isMove && item.movedTo) {
          pullMoves++;
        } else {
          pullRemoveLocal++;
        }
        break;

      case "DELETE_CONFLICT":
        deleteConflicts++;
        break;

      case "POTENTIAL_CONFLICT":
        contentConflicts++;
        break;

      case "UNCHANGED":
        unchanged++;
        break;

      case "DELETED":
        // Converged deletion: no active user mutation needed
        break;
    }
  }

  const totalPushMutations = pushCreate + pushUpdate + pushDeleteRemote + pushMoves;
  const totalPullMutations = pullCreate + pullUpdate + pullRemoveLocal + pullMoves;
  const totalConflicts = contentConflicts + deleteConflicts;
  const totalSemanticMoves = pushMoves + pullMoves;

  return {
    pushCreate,
    pushUpdate,
    pushDeleteRemote,
    pushMoves,
    pullCreate,
    pullUpdate,
    pullRemoveLocal,
    pullMoves,
    contentConflicts,
    deleteConflicts,
    totalConflicts,
    oversized,
    unsafe,
    unchanged,
    totalPushMutations,
    totalPullMutations,
    totalSemanticMoves,
  };
}

export interface SemanticPullResultCounts {
  created: number;
  updated: number;
  removed: number;
  moved: number;
  conflicts: number;
  oversized: number;
  unsafe: number;
  failed: number;
}

/**
 * Computes semantic result counts for Safe Pull, suppressing double-counting of moves.
 */
export function computeSemanticPullResults(report: PullExecutionReport): SemanticPullResultCounts {
  const moved = report.counts.pulledMoved || 0;
  const rawCreated = report.counts.pulledCreated || 0;
  const rawDeleted = report.counts.pulledDeleted || 0;

  return {
    created: Math.max(0, rawCreated - moved),
    updated: report.counts.pulledUpdated || 0,
    removed: Math.max(0, rawDeleted - moved),
    moved,
    conflicts: report.counts.conflictsPreserved || 0,
    oversized: report.counts.skippedOversized || 0,
    unsafe: report.counts.skippedUnsafe || 0,
    failed: report.counts.failed || 0,
  };
}

export interface SemanticPushResultCounts {
  created: number;
  updated: number;
  deleted: number;
  moved: number;
  conflicts: number;
  oversized: number;
  unsafe: number;
  failed: number;
}

/**
 * Computes semantic result counts for Safe Push, suppressing double-counting of moves.
 */
export function computeSemanticPushResults(report: PushExecutionReport): SemanticPushResultCounts {
  const moved = report.counts.pushedMoved || 0;
  const rawCreated = report.counts.pushedCreated || 0;
  const rawDeleted = report.counts.pushedDeleted || 0;

  return {
    created: Math.max(0, rawCreated - moved),
    updated: report.counts.pushedUpdated || 0,
    deleted: Math.max(0, rawDeleted - moved),
    moved,
    conflicts: report.counts.skippedConflicts || 0,
    oversized: report.counts.skippedOversized || 0,
    unsafe: report.counts.skippedUnsafe || 0,
    failed: report.counts.failed || 0,
  };
}

/**
 * Returns human-readable label for preview categories.
 */
export function getSemanticCategoryLabel(category: SyncCategory, isMove?: boolean): string {
  if (isMove) return "Move";
  switch (category) {
    case "LOCAL_ONLY":
      return "Local Only";
    case "REMOTE_ONLY":
      return "Remote Only";
    case "LOCAL_CHANGED":
      return "Local Changed";
    case "REMOTE_CHANGED":
      return "Remote Changed";
    case "LOCAL_DELETED":
      return "Delete from GitHub";
    case "REMOTE_DELETED":
      return "Remove locally";
    case "POTENTIAL_CONFLICT":
      return "Conflict";
    case "DELETE_CONFLICT":
      return "Delete Conflict";
    case "DELETED":
      return "Both Deleted";
    case "UNCHANGED":
      return "Unchanged";
  }
}
