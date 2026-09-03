/**
 * Conflict Resolution Modal for Vault Relay (C4)
 *
 * Provides a clean, card-based interface for resolving sync conflicts:
 * - Keep Local: pushes local version to GitHub after revalidating remote.
 * - Use Remote: pulls and overwrites local file after verifying local version.
 * - Keep Both: preserves local note untouched and saves remote copy with timestamp suffix.
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

  constructor(app: App, plugin: VaultRelayPlugin, onResolved?: () => void, previewReport?: SyncPreviewReport | null) {
    super(app);
    this.plugin = plugin;
    this.onResolvedCallback = onResolved;
    this.previewReport = previewReport;
  }

  public async onOpen(): Promise<void> {
    this.modalEl.addClass("vault-relay-conflict-modal");
    this.modalEl.style.maxWidth = "700px";
    this.modalEl.style.width = "92vw";

    const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
    const client = new GitHubClient({
      token: token || "",
      owner: this.plugin.settings.owner,
      repo: this.plugin.settings.repo,
      branch: this.plugin.settings.branch,
    });
    this.conflictManager = new ConflictManager(this.app, this.plugin.settings, client);

    await this.loadAndRender();
  }

  public onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private async loadAndRender(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    if (!this.conflictManager) return;
    if (this.previewReport) {
      this.conflicts = await this.conflictManager.syncWithPreviewReport(this.previewReport);
    } else {
      this.conflicts = await this.conflictManager.loadConflictRecords();
    }

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

    const meta = card.createDiv({
      attr: { style: "font-size: 0.8em; color: var(--text-muted); margin-bottom: 12px; font-family: var(--font-monospace);" },
    });
    meta.setText(`Local SHA: ${conflict.localSha.substring(0, 7)} | Remote SHA: ${conflict.remoteSha.substring(0, 7)}`);

    const btnRow = card.createDiv({
      attr: { style: "display: flex; flex-wrap: wrap; gap: 8px;" },
    });

    // Keep Local
    const keepLocalBtn = btnRow.createEl("button", { text: "Keep Local" });
    keepLocalBtn.onclick = async () => {
      if (!this.conflictManager) return;
      keepLocalBtn.disabled = true;
      keepLocalBtn.setText("Pushing...");
      try {
        const res = await this.conflictManager.resolveKeepLocal(conflict);
        if (res.success) {
          new Notice(res.message);
          await this.loadAndRender();
          this.onResolvedCallback?.();
        } else {
          new Notice(`Error: ${res.message}`);
          keepLocalBtn.disabled = false;
          keepLocalBtn.setText("Keep Local");
        }
      } catch (err) {
        new Notice(`Failed: ${String(err)}`);
        keepLocalBtn.disabled = false;
        keepLocalBtn.setText("Keep Local");
      }
    };

    // Use Remote
    const useRemoteBtn = btnRow.createEl("button", { text: "Use Remote" });
    useRemoteBtn.onclick = async () => {
      if (!this.conflictManager) return;
      useRemoteBtn.disabled = true;
      useRemoteBtn.setText("Pulling...");
      try {
        const res = await this.conflictManager.resolveUseRemote(conflict);
        if (res.success) {
          new Notice(res.message);
          await this.loadAndRender();
          this.onResolvedCallback?.();
        } else {
          new Notice(`Error: ${res.message}`);
          useRemoteBtn.disabled = false;
          useRemoteBtn.setText("Use Remote");
        }
      } catch (err) {
        new Notice(`Failed: ${String(err)}`);
        useRemoteBtn.disabled = false;
        useRemoteBtn.setText("Use Remote");
      }
    };

    // Keep Both
    const keepBothBtn = btnRow.createEl("button", { text: "Keep Both", cls: "mod-cta" });
    keepBothBtn.onclick = async () => {
      if (!this.conflictManager) return;
      keepBothBtn.disabled = true;
      keepBothBtn.setText("Saving...");
      try {
        const res = await this.conflictManager.resolveKeepBoth(conflict);
        if (res.success) {
          new Notice(res.message);
          await this.loadAndRender();
          this.onResolvedCallback?.();
        } else {
          new Notice(`Error: ${res.message}`);
          keepBothBtn.disabled = false;
          keepBothBtn.setText("Keep Both");
        }
      } catch (err) {
        new Notice(`Failed: ${String(err)}`);
        keepBothBtn.disabled = false;
        keepBothBtn.setText("Keep Both");
      }
    };
  }
}
