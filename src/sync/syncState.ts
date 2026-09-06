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

function isFileSyncStateEntry(entry: unknown): entry is { remoteSha: string; localSha: string; syncedAt: number | string } {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const rec = entry as Record<string, unknown>;
  return (
    typeof rec.remoteSha === "string" &&
    typeof rec.localSha === "string" &&
    (typeof rec.syncedAt === "number" || typeof rec.syncedAt === "string")
  );
}

/**
 * Deserializes JSON into SyncStateData with schema validation fallback.
 */
export function deserializeState(jsonStr: string): SyncStateData {
  if (!jsonStr || !jsonStr.trim()) {
    return createEmptyState();
  }

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null) {
      return createEmptyState();
    }

    const rec = parsed as Record<string, unknown>;
    const version = typeof rec.version === "number" ? rec.version : CURRENT_STATE_VERSION;
    const lastSyncedCommitSha =
      typeof rec.lastSyncedCommitSha === "string" ? rec.lastSyncedCommitSha : undefined;
    const lastSyncedAt =
      typeof rec.lastSyncedAt === "number"
        ? rec.lastSyncedAt
        : typeof rec.lastSyncedAt === "string"
        ? Date.parse(rec.lastSyncedAt) || undefined
        : undefined;

    const files: Record<string, import("./syncTypes").FileSyncStateEntry> = {};
    if (typeof rec.files === "object" && rec.files !== null) {
      const rawFiles = rec.files as Record<string, unknown>;
      for (const [key, val] of Object.entries(rawFiles)) {
        if (isFileSyncStateEntry(val)) {
          const rawSyncedAt = val.syncedAt;
          const syncedAt =
            typeof rawSyncedAt === "number"
              ? rawSyncedAt
              : typeof rawSyncedAt === "string"
              ? Date.parse(rawSyncedAt) || Date.now()
              : Date.now();
          files[key] = {
            remoteSha: val.remoteSha,
            localSha: val.localSha,
            syncedAt,
          };
        }
      }
    }

    return {
      version,
      lastSyncedCommitSha,
      lastSyncedAt,
      files,
    };
  } catch {
    return createEmptyState();
  }
}

