/**
 * Unified Safe Sync Engine for Vault Relay (C4)
 *
 * Orchestrates conservative synchronization by combining Safe Pull and Safe Push
 * into a single unified action.
 *
 * Core Workflow:
 * 1. Fresh Scan (authoritative Git ref, fresh remote tree, local vault scan).
 * 2. If no eligible changes: completes immediately with UNCHANGED summary.
 * 3. Pull Phase: pulls REMOTE_ONLY and REMOTE_CHANGED files safely.
 *    - If Pull fails or aborts unexpectedly, Push phase is aborted.
 * 4. Re-scan Phase: revalidates fresh local and remote states after pull.
 * 5. Push Phase: pushes LOCAL_ONLY and LOCAL_CHANGED files safely (1 commit, force: false).
 * 6. Final Fresh Scan: produces fresh preview confirming convergence.
 *
 * Concurrency Safety:
 * - Maintains an activeSyncPromise lock to strictly prevent duplicate or overlapping syncs.
 */

import { App } from "obsidian";
import { GitHubClient } from "../github/githubClient";
import { VaultRelaySettings } from "../settings";
import { SyncEngine } from "./syncEngine";
import { PullEngine } from "./pullEngine";
import { PushEngine } from "./pushEngine";
import { StorageManager } from "./storageManager";
import { SyncPreviewReport, PullExecutionReport, PushExecutionReport } from "./syncTypes";
import { SyncProgressCallback } from "./progressTypes";
import {
  acquireMutationLease,
  getActiveMutationLabel,
  releaseMutationLease,
} from "./mutationCoordinator";

export interface UnifiedSyncResult {
  status: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "ABORTED";
  pulledCount: number;
  pushedCount: number;
  conflictCount: number;
  skippedCount: number;
  summaryMessage: string;
  finalReport: SyncPreviewReport;
  pullReport?: PullExecutionReport;
  pushReport?: PushExecutionReport;
  durationMs: number;
}

export class UnifiedSyncEngine {
  private app: App;
  private settings: VaultRelaySettings;
  private githubClient: GitHubClient;
  private isSyncing = false;

  constructor(app: App, settings: VaultRelaySettings, githubClient: GitHubClient) {
    this.app = app;
    this.settings = settings;
    this.githubClient = githubClient;
  }

  /**
   * Indicates whether a sync operation is currently active.
   */
  public get isRunning(): boolean {
    return this.isSyncing;
  }

  /**
   * Executes unified safe synchronization.
   */
  public async executeSync(onProgress?: SyncProgressCallback): Promise<UnifiedSyncResult> {
    if (this.isSyncing) {
      throw new Error("A sync operation is already in progress. Please wait for it to complete.");
    }

    const mutationLease = acquireMutationLease(this.app, "Unified Sync");
    if (!mutationLease) {
      throw new Error(
        `Another vault mutation is already in progress (${getActiveMutationLabel(this.app) || "unknown operation"}). Please wait for it to complete.`
      );
    }

    this.isSyncing = true;
    const tStart = Date.now();

    try {
      const syncEngine = new SyncEngine(this.app, this.settings, this.githubClient);
      const pullEngine = new PullEngine(this.app, this.settings, this.githubClient);
      const pushEngine = new PushEngine(this.app, this.settings, this.githubClient);

      // 1. Initial Fresh Scan
      onProgress?.({ phase: "SCANNING", completed: 0, total: 1, message: "Scanning vault and remote repository..." });
      const initialPreview = await syncEngine.generatePreview(true);

      const pullItems = initialPreview.items.filter(
        (it) =>
          it.category === "REMOTE_ONLY" ||
          it.category === "REMOTE_CHANGED" ||
          it.category === "REMOTE_DELETED"
      );
      const pushItems = initialPreview.items.filter(
        (it) =>
          it.category === "LOCAL_ONLY" ||
          it.category === "LOCAL_CHANGED" ||
          it.category === "LOCAL_DELETED"
      );
      const conflictItems = initialPreview.items.filter(
        (it) => it.category === "POTENTIAL_CONFLICT" || it.category === "DELETE_CONFLICT"
      );

      // Check if any converged deletions need baseline pruning even if no active mutations
      const convergedDeleted = initialPreview.items.filter((it) => it.category === "DELETED");
      if (convergedDeleted.length > 0) {
        const state = await StorageManager.loadState(this.app);
        let cleaned = false;
        for (const item of convergedDeleted) {
          if (state.files[item.path]) {
            delete state.files[item.path];
            cleaned = true;
          }
        }
        if (cleaned) {
          await StorageManager.saveState(this.app, state);
        }
      }

      // Check if anything is eligible to sync
      if (pullItems.length === 0 && pushItems.length === 0) {
        onProgress?.({ phase: "COMPLETE", completed: 1, total: 1, message: "Repository is up to date." });
        const oversizedCount = initialPreview.items.filter((it) => it.isOversized).length;
        const unsafeCount = initialPreview.items.filter((it) => !!it.unsafeReason).length;
        const hasWarnings = conflictItems.length > 0 || oversizedCount > 0 || unsafeCount > 0;
        return {
          status: hasWarnings ? "PASS_WITH_WARNINGS" : "PASS",
          pulledCount: 0,
          pushedCount: 0,
          conflictCount: conflictItems.length,
          skippedCount: oversizedCount + unsafeCount,
          summaryMessage: hasWarnings
            ? "No safe changes to sync. Conflicts or warnings require review."
            : "No changes to sync. Repository and local vault are up to date.",
          finalReport: initialPreview,
          durationMs: Date.now() - tStart,
        };
      }

      let pullReport: PullExecutionReport | undefined;
      let pulledCount = 0;

      // 2. Safe Pull Phase (if remote changes exist)
      if (pullItems.length > 0) {
        onProgress?.({ phase: "PLANNING", completed: 0, total: pullItems.length, message: `Preparing to pull ${pullItems.length} file(s)...` });
        pullReport = await pullEngine.executeSafePull(onProgress, mutationLease);
        pulledCount = pullReport.counts.pulledCreated + pullReport.counts.pulledUpdated + pullReport.counts.pulledDeleted;

        if (pullReport.status === "FAIL" || pullReport.status === "ABORTED") {
          onProgress?.({ phase: "FAILED", completed: 0, total: 1, message: `Pull phase failed: ${pullReport.summaryMessage}` });
          return {
            status: pullReport.status,
            pulledCount,
            pushedCount: 0,
            conflictCount: pullReport.counts.conflictsPreserved,
            skippedCount: pullReport.counts.skippedOversized + pullReport.counts.skippedUnsafe,
            summaryMessage: `Sync aborted during Pull phase: ${pullReport.summaryMessage}`,
            finalReport: initialPreview,
            pullReport,
            durationMs: Date.now() - tStart,
          };
        }
      }

      // 3. Fresh Re-Scan before Push
      onProgress?.({ phase: "SCANNING", completed: 0, total: 1, message: "Revalidating state before Push phase..." });
      const midPreview = await syncEngine.generatePreview(true);

      const freshPushItems = midPreview.items.filter(
        (it) =>
          it.category === "LOCAL_ONLY" ||
          it.category === "LOCAL_CHANGED" ||
          it.category === "LOCAL_DELETED"
      );

      let pushReport: PushExecutionReport | undefined;
      let pushedCount = 0;

      // 4. Safe Push Phase (if local changes exist after pull)
      if (freshPushItems.length > 0) {
        onProgress?.({ phase: "PLANNING", completed: 0, total: freshPushItems.length, message: `Preparing to push ${freshPushItems.length} file(s)...` });
        pushReport = await pushEngine.executeSafePush(onProgress, mutationLease);
        pushedCount = pushReport.counts.pushedCreated + pushReport.counts.pushedUpdated + pushReport.counts.pushedDeleted;

        if (pushReport.status === "FAIL" || pushReport.status === "ABORTED") {
          onProgress?.({ phase: "FAILED", completed: 0, total: 1, message: `Push phase failed: ${pushReport.summaryMessage}` });
          return {
            status: pushReport.status,
            pulledCount,
            pushedCount,
            conflictCount: midPreview.counts.POTENTIAL_CONFLICT + midPreview.counts.DELETE_CONFLICT,
            skippedCount: pushReport.counts.skippedOversized + pushReport.counts.skippedUnsafe,
            summaryMessage: `Sync completed Pull (${pulledCount} files), but Push failed: ${pushReport.summaryMessage}`,
            finalReport: midPreview,
            pullReport,
            pushReport,
            durationMs: Date.now() - tStart,
          };
        }
      }

      // 5. Final Fresh Scan to confirm convergence
      onProgress?.({ phase: "SCANNING", completed: 0, total: 1, message: "Finalizing sync report..." });
      const finalReport = await syncEngine.generatePreview(true);

      onProgress?.({ phase: "COMPLETE", completed: 1, total: 1, message: "Sync complete." });

      const totalConflicts = finalReport.counts.POTENTIAL_CONFLICT + finalReport.counts.DELETE_CONFLICT;
      const totalSkipped = finalReport.items.filter((it) => it.isOversized).length + finalReport.items.filter((it) => !!it.unsafeReason).length;

      let status: "PASS" | "PASS_WITH_WARNINGS" = "PASS";
      if (totalConflicts > 0 || totalSkipped > 0 || pullReport?.status === "PASS_WITH_WARNINGS" || pushReport?.status === "PASS_WITH_WARNINGS") {
        status = "PASS_WITH_WARNINGS";
      }

      const summaryParts: string[] = [];
      if (pulledCount > 0) summaryParts.push(`Pulled ${pulledCount} file(s)`);
      if (pushedCount > 0) summaryParts.push(`Pushed ${pushedCount} file(s)`);
      if (totalConflicts > 0) summaryParts.push(`${totalConflicts} conflict(s) preserved`);
      if (totalSkipped > 0) summaryParts.push(`${totalSkipped} file(s) skipped`);
      if (summaryParts.length === 0) summaryParts.push("Repository is up to date");

      return {
        status,
        pulledCount,
        pushedCount,
        conflictCount: totalConflicts,
        skippedCount: totalSkipped,
        summaryMessage: summaryParts.join(", ") + ".",
        finalReport,
        pullReport,
        pushReport,
        durationMs: Date.now() - tStart,
      };
    } finally {
      this.isSyncing = false;
      releaseMutationLease(mutationLease);
    }
  }
}
