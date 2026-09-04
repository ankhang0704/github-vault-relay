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
    this.modalEl.style.maxWidth = "700px";
    this.modalEl.style.width = "92vw";

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
        attr: { style: "padding: 20px 0; color: var(--text-muted); font-size: 0.95em;" },
      });
      const closeBtn = contentEl.createEl("button", { text: "Close", cls: "mod-cta" });
      closeBtn.onclick = () => this.close();
      return;
    }

    const desc = contentEl.createDiv({
      attr: { style: "margin-bottom: 16px; font-size: 0.88em; color: var(--text-muted); line-height: 1.4;" },
    });
    desc.setText(
      "The following notes have been modified both locally and on GitHub. Choose how you would like to resolve each conflict:"
    );

    const listContainer = contentEl.createDiv({
      attr: { style: "max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;" },
    });

    for (const conflict of this.conflicts) {
      this.renderConflictCard(listContainer, conflict);
    }
  }

  private renderConflictCard(container: HTMLElement, conflict: ConflictRecord): void {
    const card = container.createDiv({
      attr: {
        style:
          "border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 14px; background-color: var(--background-secondary);",
      },
    });

    const header = card.createDiv({
      attr: { style: "font-weight: 600; word-break: break-all; margin-bottom: 6px; font-size: 0.95em; color: var(--text-normal);" },
    });
    header.setText(conflict.path);

    card.createDiv({
      text: "Both versions are preserved until you choose an action.",
      attr: { style: "font-size: 0.8em; color: var(--text-muted); margin-bottom: 10px;" },
    });

    // Status / Progress indicator area
    const statusDiv = card.createDiv({
      attr: {
        style: "display: none; font-size: 0.85em; margin-bottom: 10px; padding: 6px 10px; border-radius: 4px; background-color: var(--background-primary);",
      },
    });

    const btnRow = card.createDiv({
      attr: { style: "display: flex; flex-wrap: wrap; gap: 8px;" },
    });

    const keepLocalBtn = btnRow.createEl("button", { text: "Keep Local" });
    const useRemoteBtn = btnRow.createEl("button", { text: "Use Remote" });
    const keepBothBtn = btnRow.createEl("button", { text: "Keep Both", cls: "mod-cta" });

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
      statusDiv.style.color = "var(--text-normal)";
      statusDiv.style.display = "block";

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
            statusDiv.style.color = "var(--color-red, #e74c3c)";

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
            statusDiv.style.color = "var(--color-red, #e74c3c)";
            keepLocalBtn.disabled = false;
            keepLocalBtn.setText("Keep Local");
            useRemoteBtn.disabled = false;
            useRemoteBtn.setText("Use Remote");
            keepBothBtn.disabled = false;
            keepBothBtn.setText("Keep Both");
          }
        }
      } catch (err) {
        new Notice(`Unexpected resolution error: ${String(err)}`, 8000);
        statusDiv.setText(`❌ ${String(err)}`);
        statusDiv.style.color = "var(--color-red, #e74c3c)";
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
