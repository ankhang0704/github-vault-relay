/**
 * Progress Event Types for Vault Relay Operations
 *
 * Provides a truthful progress model for Safe Pull, Safe Push, and Unified Sync.
 * Uses exact file counts (x / y) instead of misleading or fake percentages.
 */

export type SyncPhase =
  | "IDLE"
  | "SCANNING"
  | "PLANNING"
  | "DOWNLOADING"
  | "WRITING_LOCAL"
  | "VERIFYING_LOCAL"
  | "UPLOADING"
  | "CREATING_TREE"
  | "CREATING_COMMIT"
  | "UPDATING_REF"
  | "VERIFYING_REMOTE"
  | "UPDATING_STATE"
  | "COMPLETE"
  | "FAILED"
  | "ABORTED";

export interface SyncProgressEvent {
  phase: SyncPhase;
  completed: number;
  total: number;
  currentPath?: string;
  message?: string;
}

export type SyncProgressCallback = (event: SyncProgressEvent) => void;

/**
 * Returns human-readable label for a sync phase.
 */
export function getPhaseLabel(phase: SyncPhase): string {
  switch (phase) {
    case "IDLE":
      return "Ready";
    case "SCANNING":
      return "Scanning vault and remote repository...";
    case "PLANNING":
      return "Analyzing changes...";
    case "DOWNLOADING":
      return "Downloading remote files...";
    case "WRITING_LOCAL":
      return "Writing local files...";
    case "VERIFYING_LOCAL":
      return "Verifying local files...";
    case "UPLOADING":
      return "Uploading local changes...";
    case "CREATING_TREE":
      return "Creating Git tree...";
    case "CREATING_COMMIT":
      return "Creating Git commit...";
    case "UPDATING_REF":
      return "Updating remote branch...";
    case "VERIFYING_REMOTE":
      return "Verifying remote branch...";
    case "UPDATING_STATE":
      return "Updating sync state...";
    case "COMPLETE":
      return "Sync complete.";
    case "FAILED":
      return "Operation failed.";
    case "ABORTED":
      return "Operation aborted.";
  }
}
