/**
 * Sync State Persistence & Metadata Model
 *
 * Designed for local state tracking in internal hidden storage.
 * Tracks per-file:
 * - last known remote blob SHA
 * - last known local content Git SHA
 * - last successful sync timestamp
 */

import { SyncStateData } from "./syncTypes";

export const CURRENT_STATE_VERSION = 1;

/**
 * Creates a fresh empty state container.
 */
export function createEmptyState(): SyncStateData {
  return {
    version: CURRENT_STATE_VERSION,
    lastSyncedCommitSha: undefined,
    lastSyncedAt: undefined,
    files: {},
  };
}

/**
 * Serializes state to pretty JSON string.
 */
export function serializeState(state: SyncStateData): string {
  return JSON.stringify(state, null, 2);
}

/**
 * Deserializes JSON into SyncStateData with schema validation fallback.
 */
export function deserializeState(jsonStr: string): SyncStateData {
  if (!jsonStr || !jsonStr.trim()) {
    return createEmptyState();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== "object") {
      return createEmptyState();
    }

    return {
      version: typeof parsed.version === "number" ? parsed.version : CURRENT_STATE_VERSION,
      lastSyncedCommitSha: typeof parsed.lastSyncedCommitSha === "string" ? parsed.lastSyncedCommitSha : undefined,
      lastSyncedAt: typeof parsed.lastSyncedAt === "number" ? parsed.lastSyncedAt : undefined,
      files: typeof parsed.files === "object" && parsed.files !== null ? parsed.files : {},
    };
  } catch {
    return createEmptyState();
  }
}
