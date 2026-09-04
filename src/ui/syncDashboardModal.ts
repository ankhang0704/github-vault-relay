/**
 * Primary Unified Sync Dashboard Modal for Vault Relay (C4)
 *
 * Mobile-first, responsive dashboard providing:
 * - Clean status overview (repo, branch, last sync timestamp)
 * - Prominent, truthful change metrics (local changes, remote changes, conflicts)
 * - Single-click Unified Safe Sync [Sync] with live progress
 * - Conflict review banner and launcher
 * - Collapsible Advanced engineering view for raw classifications and individual Pull/Push
 */

import { App, Modal, Notice } from "obsidian";
import type VaultRelayPlugin from "../main";
import { GitHubClient } from "../github/githubClient";
import { SyncEngine } from "../sync/syncEngine";
import { UnifiedSyncEngine, UnifiedSyncResult } from "../sync/unifiedSyncEngine";
import { SyncCategory, SyncPreviewReport } from "../sync/syncTypes";
import { getStoredPat } from "../security/secretStore";
import { sanitizeErrorMessage } from "../security/redact";
import { getPhaseLabel, SyncProgressEvent } from "../sync/progressTypes";
import { ConflictResolutionModal } from "./conflictResolutionModal";
import { PullConfirmModal } from "./pullConfirmModal";
import { PushConfirmModal } from "./pushConfirmModal";

export class SyncDashboardModal extends Modal {
  private plugin: VaultRelayPlugin;
  private report: SyncPreviewReport | null = null;
  private unifiedEngine: UnifiedSyncEngine | null = null;
  private isLoading = false;
  private isSyncing = false;
  private progressEvent: SyncProgressEvent | null = null;
  private showAdvanced = false;
  private activeFilter: SyncCategory | "ALL" = "ALL";
  public isModalOpen = false;

  constructor(app: App, plugin: VaultRelayPlugin) {
    super(app);
    this.plugin = plugin;
  }

  public onOpen(): void {
    this.isModalOpen = true;
    this.modalEl.addClass("vault-relay-modal");
    this.modalEl.addClass("vault-relay-dashboard-modal");
    this.modalEl.style.maxWidth = "680px";
    this.modalEl.style.width = "92vw";
    this.modalEl.style.padding = "16px";
    this.runScanAndRender();
  }

  public onClose(): void {
    this.isModalOpen = false;
    const { contentEl } = this;
    contentEl.empty();
  }

  public async runScanAndRender(): Promise<void> {
    this.isLoading = true;
    this.render();

    try {
      const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
      if (!token || !this.plugin.settings.owner || !this.plugin.settings.repo) {
        this.isLoading = false;
        this.renderSetupRequired();
        return;
      }

      const client = new GitHubClient({
        token,
        owner: this.plugin.settings.owner,
        repo: this.plugin.settings.repo,
        branch: this.plugin.settings.branch,
      });

      this.unifiedEngine = new UnifiedSyncEngine(this.app, this.plugin.settings, client);
      const syncEngine = new SyncEngine(this.app, this.plugin.settings, client);
      this.report = await syncEngine.generatePreview();
    } catch (err) {
      new Notice(`Sync scan failed: ${sanitizeErrorMessage(err)}`);
    } finally {
      this.isLoading = false;
      this.render();
    }
  }

  private renderSetupRequired(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "GitHub Vault Relay" });
    contentEl.createDiv({
      text: "Connection setup required. Please configure your GitHub Personal Access Token, Repository, and Branch in settings.",
      attr: { style: "padding: 16px; background-color: var(--background-secondary); border-radius: 6px; margin: 16px 0;" },
    });

    const btn = contentEl.createEl("button", { text: "Close", cls: "mod-cta" });
    btn.onclick = () => this.close();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    // 1. Header with Repository info
    const header = contentEl.createDiv({
      attr: { style: "display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px;" },
    });
    const titleCol = header.createDiv();
    titleCol.createEl("h2", { text: "GitHub Vault Relay", attr: { style: "margin: 0 0 4px 0;" } });
    titleCol.createDiv({
      text: `${this.plugin.settings.owner}/${this.plugin.settings.repo} (${this.plugin.settings.branch || "main"})`,
      attr: { style: "font-size: 0.85em; color: var(--text-muted); font-family: var(--font-monospace);" },
    });

    const refreshBtn = header.createEl("button", { text: "↻ Refresh" });
    refreshBtn.disabled = this.isLoading || this.isSyncing;
    refreshBtn.onclick = () => this.runScanAndRender();

    if (this.isLoading) {
      const loadingBox = contentEl.createDiv({
        attr: { style: "padding: 40px; text-align: center; color: var(--text-muted);" },
      });
      loadingBox.setText("Scanning repository and local notes...");
      return;
    }

    if (!this.report) {
      contentEl.createDiv({ text: "Unable to load sync status." });
      return;
    }

    // 2. Metrics Grid
    const counts = this.report.counts;
    const localChanges = counts.LOCAL_ONLY + counts.LOCAL_CHANGED;
    const remoteChanges = counts.REMOTE_ONLY + counts.REMOTE_CHANGED;
    const conflicts = counts.POTENTIAL_CONFLICT;

    const metricsGrid = contentEl.createDiv({
      attr: {
        style:
          "display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-bottom: 16px;",
      },
    });

    this.renderMetricBadge(metricsGrid, "Local", localChanges, localChanges > 0 ? "var(--interactive-accent)" : "var(--text-muted)");
    this.renderMetricBadge(metricsGrid, "Remote", remoteChanges, remoteChanges > 0 ? "var(--interactive-accent)" : "var(--text-muted)");
    this.renderMetricBadge(metricsGrid, "Conflicts", conflicts, conflicts > 0 ? "var(--color-red, #e74c3c)" : "var(--text-muted)");
    this.renderMetricBadge(metricsGrid, "Unchanged", counts.UNCHANGED, "var(--color-green, #2ecc71)");

    // 3. Conflict Banner (if any)
    if (conflicts > 0) {
      const banner = contentEl.createDiv({
        attr: {
          style:
            "display: flex; justify-content: space-between; align-items: center; background-color: rgba(231, 76, 60, 0.12); border: 1px solid var(--color-red, #e74c3c); border-radius: 6px; padding: 10px 14px; margin-bottom: 16px;",
        },
      });
      banner.createDiv({
        text: `⚠ ${conflicts} conflict(s) require review`,
        attr: { style: "font-weight: 500; font-size: 0.9em; color: var(--color-red, #e74c3c);" },
      });
      const reviewBtn = banner.createEl("button", { text: "Review Conflicts", cls: "mod-warning" });
      reviewBtn.onclick = () => {
        new ConflictResolutionModal(this.app, this.plugin, () => this.runScanAndRender(), this.report).open();
      };
    }

    // 4. Primary Sync Action Area
    const syncCard = contentEl.createDiv({
      attr: {
        style:
          "padding: 16px; border-radius: 8px; background-color: var(--background-secondary); border: 1px solid var(--background-modifier-border); margin-bottom: 16px; text-align: center;",
      },
    });

    if (this.isSyncing && this.progressEvent) {
      const prog = this.progressEvent;
      syncCard.createDiv({
        text: getPhaseLabel(prog.phase),
        attr: { style: "font-weight: 600; font-size: 0.95em; margin-bottom: 6px; color: var(--text-normal);" },
      });
      if (prog.total > 0 && prog.completed > 0) {
        syncCard.createDiv({
          text: `${prog.completed} / ${prog.total} file(s)`,
          attr: { style: "font-size: 0.85em; color: var(--text-muted); margin-bottom: 4px;" },
        });
      }
      if (prog.currentPath) {
        syncCard.createDiv({
          text: prog.currentPath,
          attr: { style: "font-size: 0.8em; font-family: var(--font-monospace); color: var(--text-muted); word-break: break-all;" },
        });
      }
    } else {
      const syncBtn = syncCard.createEl("button", {
        text: "Sync Now",
        cls: "mod-cta",
        attr: { style: "width: 100%; height: 44px; font-size: 1.05em; font-weight: 600; cursor: pointer;" },
      });

      const hasChanges = localChanges > 0 || remoteChanges > 0;
      if (!hasChanges) {
        syncBtn.setText("Repository Up to Date (Sync)");
      }

      syncBtn.onclick = async () => {
        await this.handleUnifiedSync();
      };
    }

    // 5. Utility Actions: Advanced Toggle
    const actionsRow = contentEl.createDiv({
      attr: { style: "display: flex; justify-content: flex-end; align-items: center; margin-bottom: 12px;" },
    });

    const advancedToggle = actionsRow.createEl("button", {
      text: this.showAdvanced ? "Hide Advanced Details ▲" : "View Advanced Details ▼",
      attr: { style: "background: transparent; border: none; font-size: 0.82em; color: var(--text-muted); cursor: pointer;" },
    });
    advancedToggle.onclick = () => {
      this.showAdvanced = !this.showAdvanced;
      this.render();
    };

    // 6. Collapsible Advanced Section
    if (this.showAdvanced) {
      this.renderAdvancedSection(contentEl);
    }
  }

  private renderMetricBadge(container: HTMLElement, label: string, count: number, color: string): void {
    const badge = container.createDiv({
      attr: {
        style:
          "padding: 10px 8px; border-radius: 6px; background-color: var(--background-secondary); border: 1px solid var(--background-modifier-border); text-align: center;",
      },
    });
    badge.createDiv({
      text: String(count),
      attr: { style: `font-size: 1.3em; font-weight: 700; color: ${color};` },
    });
    badge.createDiv({
      text: label,
      attr: { style: "font-size: 0.75em; color: var(--text-muted); margin-top: 2px;" },
    });
  }

  private async handleUnifiedSync(): Promise<void> {
    if (!this.unifiedEngine || this.isSyncing) return;

    this.isSyncing = true;
    this.render();

    try {
      const result: UnifiedSyncResult = await this.unifiedEngine.executeSync((evt) => {
        this.progressEvent = evt;
        this.render();
      });

      if (result.status === "PASS") {
        new Notice(`Sync completed successfully: ${result.summaryMessage}`);
      } else if (result.status === "PASS_WITH_WARNINGS") {
        new Notice(`Sync completed with warnings: ${result.summaryMessage}`);
      } else {
        new Notice(`Sync failed: ${result.summaryMessage}`);
      }

      this.report = result.finalReport;
    } catch (err) {
      new Notice(`Sync error: ${sanitizeErrorMessage(err)}`);
    } finally {
      this.isSyncing = false;
      this.progressEvent = null;
      this.render();
    }
  }

  private renderAdvancedSection(container: HTMLElement): void {
    const adv = container.createDiv({
      attr: {
        style:
          "border-top: 1px solid var(--background-modifier-border); padding-top: 14px; margin-top: 10px;",
      },
    });

    adv.createEl("h3", { text: "Engineering Diagnostics & Individual Operations", attr: { style: "font-size: 0.95em; margin-bottom: 8px;" } });

    // Buttons for manual Safe Pull / Safe Push
    const opBtns = adv.createDiv({ attr: { style: "display: flex; gap: 8px; margin-bottom: 12px;" } });
    const pullBtn = opBtns.createEl("button", { text: "Safe Pull Only" });
    pullBtn.onclick = () => {
      new PullConfirmModal(this.app, this.plugin, () => this.runScanAndRender()).open();
    };

    const pushBtn = opBtns.createEl("button", { text: "Safe Push Only" });
    pushBtn.onclick = () => {
      new PushConfirmModal(this.app, this.plugin, () => this.runScanAndRender()).open();
    };

    // Item List
    if (this.report) {
      const itemsList = adv.createDiv({
        attr: { style: "max-height: 240px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 6px;" },
      });
      for (const item of this.report.items) {
        const row = itemsList.createDiv({
          attr: { style: "display: flex; justify-content: space-between; font-size: 0.8em; padding: 4px 6px; border-bottom: 1px solid var(--background-modifier-border);" },
        });
        row.createDiv({ text: item.path, attr: { style: "word-break: break-all; font-family: var(--font-monospace);" } });
        row.createDiv({ text: item.category, attr: { style: "font-weight: 600; color: var(--text-muted);" } });
      }
    }
  }
}
