/**
 * Conflict Resolution Modal for Vault Relay (C4)
 *
 * Provides a clean, card-based interface for resolving sync conflicts:
 * - Keep Local: pushes local version to GitHub after revalidating remote.
 * - Use Remote: pulls and overwrites local file after verifying local version.
 * - Keep Both: preserves local note untouched and saves remote copy with timestamp suffix.
 *
 * Reentrancy & Lifecycle Hardening:
 * - Immediate UI lock: buttons disabled instantly on click, card enters RESOLVING state.
 * - Double-click / spam protection across all actions.
 * - In-flight resolution tracking.
 * - Stale previewReport cleared after initial seed to prevent ghost conflicts.
 * - Automatic modal closure when all conflicts are resolved.
 * - Remaining cards updated dynamically when partially resolved.
 * - Stale remote/local failures keep actions blocked until refreshed.
 * - Parent Dashboard notified immediately on any successful resolution.
 */

import { App, Modal, Notice } from "obsidian";
import type VaultRelayPlugin from "../main";
import { GitHubClient } from "../github/githubClient";
import { ConflictManager, ConflictRecord } from "../sync/conflictManager";
import { getStoredPat } from "../security/secretStore";
import { SyncPreviewReport } from "../sync/syncTypes";
import { sanitizeErrorMessage } from "../security/redact";

export class ConflictResolutionModal extends Modal {
  private plugin: VaultRelayPlugin;
  private conflictManager: ConflictManager | null = null;
  private conflicts: ConflictRecord[] = [];
  private onResolvedCallback?: () => void;
  private previewReport?: SyncPreviewReport | null;
  private resolvingPaths: Set<string> = new Set();

  constructor(app: App, plugin: VaultRelayPlugin, onResolved?: () => void, previewReport?: SyncPreviewReport | null) {
    super(app);
    this.plugin = plugin;
    this.onResolvedCallback = onResolved;
    this.previewReport = previewReport;
  }

  private _isOpen = false;

  public get isOpen(): boolean {
    return this._isOpen;
  }

  public async onOpen(): Promise<void> {
    this._isOpen = true;
    this.modalEl.addClass("vault-relay-modal");
    this.modalEl.addClass("vault-relay-conflict-modal");

    if (!this.conflictManager) {
      const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
      const client = new GitHubClient({
        token: token || "",
        owner: this.plugin.settings.owner,
        repo: this.plugin.settings.repo,
        branch: this.plugin.settings.branch,
      });
      this.conflictManager = new ConflictManager(this.app, this.plugin.settings, client);
    }

    // Initial seed: sync with preview report if provided, then null it out so
    // subsequent re-renders reflect authoritative active records from storage
    if (this.previewReport) {
      this.conflicts = await this.conflictManager.syncWithPreviewReport(this.previewReport);
      this.previewReport = null;
    } else {
      this.conflicts = await this.conflictManager.loadConflictRecords();
    }

    this.render();
  }

  public onClose(): void {
    this._isOpen = false;
    const { contentEl } = this;
    contentEl.empty();
    this.resolvingPaths.clear();
  }

  public isResolving(path: string): boolean {
    return this.resolvingPaths.has(path);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Conflict Resolution" });

    if (this.conflicts.length === 0) {
      contentEl.createDiv({
        text: "No active conflicts detected. All files are synchronized or safe.",
        cls: "vault-relay-empty-state-text",
      });
      const closeBtn = contentEl.createEl("button", { text: "Close", cls: "mod-cta vault-relay-btn-lg" });
      closeBtn.onclick = () => this.close();
      return;
    }

    const desc = contentEl.createDiv({
      cls: "vault-relay-conflict-intro",
    });
    desc.setText(
      "The following notes have been modified both locally and on GitHub. Choose how you would like to resolve each conflict:"
    );

    const listContainer = contentEl.createDiv({
      cls: "vault-relay-conflict-list",
    });

    for (const conflict of this.conflicts) {
      this.renderConflictCard(listContainer, conflict);
    }
  }

  private renderConflictCard(container: HTMLElement, conflict: ConflictRecord): void {
    const card = container.createDiv({
      cls: "vault-relay-conflict-card",
    });

    const header = card.createDiv({
      cls: "vault-relay-conflict-path",
    });
    header.setText(conflict.path);

    const isDeleteConflict =
      conflict.conflictType === "DELETE_LOCAL_REMOTE_MODIFIED" ||
      conflict.conflictType === "DELETE_REMOTE_LOCAL_MODIFIED";

    if (isDeleteConflict) {
      const isLocalDel = conflict.conflictType === "DELETE_LOCAL_REMOTE_MODIFIED";
      const statusDesc = card.createDiv({
        cls: "vault-relay-conflict-delete-desc",
      });
      statusDesc.createDiv({
        text: isLocalDel
          ? "Deleted on this device, modified on GitHub."
          : "Modified on this device, deleted on GitHub.",
        cls: "vault-relay-conflict-delete-badge",
      });
      const explanation = isLocalDel
        ? "• Keep File: Restore the GitHub version locally.\n• Delete File: Delete the GitHub version in a new commit."
        : "• Keep File: Push local modifications to GitHub in a new commit.\n• Delete File: Move the local file to Obsidian trash.";
      statusDesc.createDiv({
        text: explanation,
        cls: "vault-relay-conflict-explanation",
      });
    } else {
      card.createDiv({
        text: "Both versions are preserved until you choose an action.",
        cls: "vault-relay-conflict-note",
      });
    }

    // Status / Progress indicator area
    const statusDiv = card.createDiv({
      cls: "vault-relay-conflict-status",
    });

    const btnRow = card.createDiv({
      cls: "vault-relay-conflict-actions",
    });

    if (isDeleteConflict) {
      const keepFileBtn = btnRow.createEl("button", {
        text: "Keep File",
        cls: "mod-cta vault-relay-btn-lg",
      });
      const deleteFileBtn = btnRow.createEl("button", {
        text: "Delete File",
        cls: "mod-warning vault-relay-btn-lg",
      });
      const cancelBtn = btnRow.createEl("button", {
        text: "Cancel",
        cls: "vault-relay-btn-lg",
      });
      cancelBtn.onclick = () => this.close();

      const handleDeleteConflictAction = async (action: "keepFile" | "deleteFile") => {
        if (!this.conflictManager) return;
        if (this.resolvingPaths.has(conflict.path)) return;

        this.resolvingPaths.add(conflict.path);
        keepFileBtn.disabled = true;
        deleteFileBtn.disabled = true;
        cancelBtn.disabled = true;

        statusDiv.setText(`⏳ Resolving: ${action === "keepFile" ? "Keeping file..." : "Deleting file..."}`);
        statusDiv.removeClass("vault-relay-status-error");
        statusDiv.addClass("vault-relay-status-visible");

        try {
          const res =
            action === "keepFile"
              ? await this.conflictManager.resolveKeepFile(conflict)
              : await this.conflictManager.resolveDeleteFile(conflict);

          if (res.success) {
            new Notice(res.message);
            this.conflicts = this.conflicts.filter((c) => c.path !== conflict.path);
            const remaining = await this.conflictManager.loadConflictRecords();
            this.conflicts = remaining;
            this.onResolvedCallback?.();
            if (this.conflicts.length === 0) {
              this.close();
              return;
            } else {
              this.render();
            }
          } else {
            new Notice(`Conflict resolution failed: ${res.message}`, 8000);
            statusDiv.setText(`❌ ${res.message}`);
            statusDiv.removeClass("vault-relay-status-visible");
            statusDiv.addClass("vault-relay-status-error");
            keepFileBtn.disabled = false;
            deleteFileBtn.disabled = false;
            cancelBtn.disabled = false;
          }
        } catch (err) {
          const safeMessage = sanitizeErrorMessage(err);
          new Notice(`Unexpected resolution error: ${safeMessage}`, 8000);
          statusDiv.setText(`❌ ${safeMessage}`);
          statusDiv.removeClass("vault-relay-status-visible");
          statusDiv.addClass("vault-relay-status-error");
          keepFileBtn.disabled = false;
          deleteFileBtn.disabled = false;
          cancelBtn.disabled = false;
        } finally {
          this.resolvingPaths.delete(conflict.path);
        }
      };

      keepFileBtn.onclick = () => handleDeleteConflictAction("keepFile");
      deleteFileBtn.onclick = () => handleDeleteConflictAction("deleteFile");
    } else {
      const keepBothBtn = btnRow.createEl("button", {
        text: "Keep Both",
        cls: "mod-cta vault-relay-btn-lg",
      });
      const keepLocalBtn = btnRow.createEl("button", {
        text: "Keep Local",
        cls: "vault-relay-btn-lg",
      });
      const useRemoteBtn = btnRow.createEl("button", {
        text: "Use Remote",
        cls: "vault-relay-btn-lg",
      });
      const cancelBtn = btnRow.createEl("button", {
        text: "Cancel",
        cls: "vault-relay-btn-lg",
      });
      cancelBtn.onclick = () => this.close();

      const handleAction = async (action: "keepLocal" | "useRemote" | "keepBoth") => {
        if (!this.conflictManager) return;
        if (this.resolvingPaths.has(conflict.path)) return;

        // IMMEDIATE UI LOCK: lock path, disable all 3 buttons, enter RESOLVING state
        this.resolvingPaths.add(conflict.path);
        keepLocalBtn.disabled = true;
        useRemoteBtn.disabled = true;
        keepBothBtn.disabled = true;

        const actionLabels = {
          keepLocal: "Pushing local version...",
          useRemote: "Pulling remote version...",
          keepBoth: "Saving remote copy...",
        };
        statusDiv.setText(`⏳ Resolving: ${actionLabels[action]}`);
        statusDiv.removeClass("vault-relay-status-error");
        statusDiv.addClass("vault-relay-status-visible");

        if (action === "keepLocal") keepLocalBtn.setText("Pushing...");
        if (action === "useRemote") useRemoteBtn.setText("Pulling...");
        if (action === "keepBoth") keepBothBtn.setText("Saving...");

        try {
          let res: { success: boolean; message: string };
          if (action === "keepLocal") {
            res = await this.conflictManager.resolveKeepLocal(conflict);
          } else if (action === "useRemote") {
            res = await this.conflictManager.resolveUseRemote(conflict);
          } else {
            res = await this.conflictManager.resolveKeepBoth(conflict);
          }

          if (res.success) {
            new Notice(res.message);

            // Update in-memory conflicts list immediately
            this.conflicts = this.conflicts.filter((c) => c.path !== conflict.path);

            // Authoritatively fetch remaining conflict records from storage
            const remaining = await this.conflictManager.loadConflictRecords();
            this.conflicts = remaining;

            // Notify parent (e.g. Dashboard) immediately
            this.onResolvedCallback?.();

            if (this.conflicts.length === 0) {
              // SUCCESS LIFECYCLE: Auto-close modal when all conflicts resolved
              this.close();
              return;
            } else {
              // SUCCESS LIFECYCLE: Remove resolved card, show remaining conflicts
              this.render();
            }
          } else {
            new Notice(`Conflict resolution failed: ${res.message}`, 8000);

            // Stale-state check
            const isStale =
              res.message.includes("concurrently") ||
              res.message.includes("modified") ||
              res.message.includes("already been resolved");

            if (isStale) {
              // FAILURE LIFECYCLE: Do not re-enable stale action buttons
              statusDiv.setText(`⚠ ${res.message}`);
              statusDiv.removeClass("vault-relay-status-visible");
              statusDiv.addClass("vault-relay-status-error");

              const refreshBtn = btnRow.createEl("button", { text: "Refresh Conflicts" });
              refreshBtn.onclick = async () => {
                if (this.conflictManager) {
                  this.conflicts = await this.conflictManager.loadConflictRecords();
                  this.render();
                }
              };
            } else {
              // Transient failure: re-enable buttons for retry
              statusDiv.setText(`❌ ${res.message}`);
              statusDiv.removeClass("vault-relay-status-visible");
              statusDiv.addClass("vault-relay-status-error");
              keepLocalBtn.disabled = false;
              keepLocalBtn.setText("Keep Local");
              useRemoteBtn.disabled = false;
              useRemoteBtn.setText("Use Remote");
              keepBothBtn.disabled = false;
              keepBothBtn.setText("Keep Both");
            }
          }
        } catch (err) {
          const safeMessage = sanitizeErrorMessage(err);
          new Notice(`Unexpected resolution error: ${safeMessage}`, 8000);
          statusDiv.setText(`❌ ${safeMessage}`);
          statusDiv.removeClass("vault-relay-status-visible");
          statusDiv.addClass("vault-relay-status-error");
          keepLocalBtn.disabled = false;
          keepLocalBtn.setText("Keep Local");
          useRemoteBtn.disabled = false;
          useRemoteBtn.setText("Use Remote");
          keepBothBtn.disabled = false;
          keepBothBtn.setText("Keep Both");
        } finally {
          this.resolvingPaths.delete(conflict.path);
        }
      };

      keepLocalBtn.onclick = () => handleAction("keepLocal");
      useRemoteBtn.onclick = () => handleAction("useRemote");
      keepBothBtn.onclick = () => handleAction("keepBoth");
    }
  }
}
