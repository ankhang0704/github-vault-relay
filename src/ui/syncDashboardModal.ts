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
import { computeSemanticPreview } from "../sync/semanticSummary";
import { ConflictResolutionModal } from "./conflictResolutionModal";
import { PullConfirmModal } from "./pullConfirmModal";
import { PushConfirmModal } from "./pushConfirmModal";
import { SyncPreviewModal } from "./syncPreviewModal";

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
    if (!this.isModalOpen) return;
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
    refreshBtn.style.minHeight = "44px";
    refreshBtn.style.minWidth = "44px";
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

    // 2. Semantic Analysis
    const sem = computeSemanticPreview(this.report.items);
    const totalCreates = sem.pushCreate + sem.pullCreate;
    const totalUpdates = sem.pushUpdate + sem.pullUpdate;
    const totalChanges = totalCreates + totalUpdates;
    const totalMoves = sem.totalSemanticMoves;
    const totalConflicts = sem.totalConflicts;
    const hasDeletions = sem.pushDeleteRemote > 0 || sem.pullRemoveLocal > 0;
    const hasActionableChanges = totalChanges > 0 || totalMoves > 0 || totalConflicts > 0 || hasDeletions;
    const unchangedCount = (this.report.counts && typeof this.report.counts.UNCHANGED === "number" && this.report.counts.UNCHANGED > 0)
      ? this.report.counts.UNCHANGED
      : sem.unchanged;

    // 3. Zero-State Handling (when everything is in sync)
    if (!hasActionableChanges) {
      const zeroStateCard = contentEl.createDiv({
        cls: "vault-relay-zero-state",
        attr: {
          style:
            "padding: 28px 16px; text-align: center; background-color: var(--background-secondary); border-radius: 8px; border: 1px solid var(--background-modifier-border); margin-bottom: 14px;",
        },
      });
      zeroStateCard.createDiv({
        text: "✓ Everything is in sync",
        attr: { style: "font-size: 1.15em; font-weight: 600; color: var(--color-green, #2ecc71); margin-bottom: 6px;" },
      });
      zeroStateCard.createDiv({
        text: `${unchangedCount} files synchronized`,
        attr: { style: "font-size: 0.9em; color: var(--text-muted);" },
      });
    } else {
      // 4. Compact Summary Cards (Max 3 cards: Changes, Moves, Conflicts)
      const summaryGrid = contentEl.createDiv({
        cls: "vault-relay-summary-cards",
        attr: {
          style:
            "display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 14px;",
        },
      });

      // Card 1: Changes (combines Create + Update)
      if (totalChanges > 0) {
        let secondaryText = "";
        if (totalCreates > 0 && totalUpdates > 0) {
          secondaryText = `+ ${totalCreates} new · ~ ${totalUpdates} updated`;
        } else if (totalCreates > 0) {
          secondaryText = `+ ${totalCreates} new`;
        } else if (totalUpdates > 0) {
          secondaryText = `~ ${totalUpdates} updated`;
        }

        this.renderSummaryCard(
          summaryGrid,
          "Changes",
          totalChanges,
          secondaryText,
          "var(--interactive-accent)"
        );
      }

      // Card 2: Moves (Exact semantic moves)
      if (totalMoves > 0) {
        this.renderSummaryCard(
          summaryGrid,
          "Moves",
          totalMoves,
          "",
          "var(--color-purple, #9b59b6)"
        );
      }

      // Card 3: Conflicts (Combines Content + Delete Conflicts, visually prominent)
      if (totalConflicts > 0) {
        let secondaryText = "";
        if (sem.contentConflicts > 0 && sem.deleteConflicts > 0) {
          secondaryText = `${sem.contentConflicts} content · ${sem.deleteConflicts} delete`;
        } else if (sem.contentConflicts > 0) {
          secondaryText = `${sem.contentConflicts} content`;
        } else if (sem.deleteConflicts > 0) {
          secondaryText = `${sem.deleteConflicts} delete`;
        }

        this.renderSummaryCard(
          summaryGrid,
          "Conflicts",
          totalConflicts,
          secondaryText,
          "var(--color-red, #e74c3c)",
          true
        );
      }
    }

    // 5. Destructive Changes Banner (appears only when deletions exist, before Sync Now)
    if (hasDeletions) {
      const delBanner = contentEl.createDiv({
        cls: "vault-relay-destructive-banner",
        attr: {
          style:
            "margin-bottom: 14px; padding: 10px 14px; border-radius: 6px; background-color: rgba(231, 76, 60, 0.08); border: 1px solid var(--color-red, #e74c3c); font-size: 0.88em; line-height: 1.4;",
        },
      });
      delBanner.createDiv({
        text: "⚠ Destructive changes",
        attr: { style: "font-weight: 600; color: var(--color-red, #e74c3c); margin-bottom: 3px;" },
      });

      const delParts: string[] = [];
      if (sem.pushDeleteRemote > 0) {
        delParts.push(`${sem.pushDeleteRemote} ${sem.pushDeleteRemote === 1 ? "file" : "files"} will be deleted from GitHub`);
      }
      if (sem.pullRemoveLocal > 0) {
        delParts.push(`${sem.pullRemoveLocal} ${sem.pullRemoveLocal === 1 ? "file" : "files"} will be removed locally`);
      }

      delBanner.createDiv({
        text: delParts.join(" · "),
        attr: { style: "color: var(--text-normal);" },
      });
    }

    // 6. Conflict Review Banner (if any unresolved conflicts)
    if (sem.totalConflicts > 0) {
      const banner = contentEl.createDiv({
        cls: "vault-relay-conflict-banner",
        attr: {
          style:
            "display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; background-color: rgba(231, 76, 60, 0.12); border: 1px solid var(--color-red, #e74c3c); border-radius: 6px; padding: 10px 14px; margin-bottom: 14px;",
        },
      });
      const conflictText =
        sem.deleteConflicts > 0 && sem.contentConflicts > 0
          ? `⚠ ${sem.totalConflicts} conflict(s) require review (${sem.deleteConflicts} delete conflict(s))`
          : sem.deleteConflicts > 0
          ? `⚠ ${sem.deleteConflicts} delete conflict(s) require review`
          : `⚠ ${sem.contentConflicts} conflict(s) require review`;

      banner.createDiv({
        text: conflictText,
        attr: { style: "font-weight: 600; font-size: 0.9em; color: var(--color-red, #e74c3c);" },
      });
      const reviewBtn = banner.createEl("button", {
        text: "Review Conflicts",
        cls: "mod-warning",
        attr: { style: "min-height: 44px; min-width: 44px;" },
      });
      reviewBtn.onclick = () => {
        new ConflictResolutionModal(this.app, this.plugin, () => this.runScanAndRender(), this.report).open();
      };
    }

    // 7. Primary Sync Action Area
    const syncCard = contentEl.createDiv({
      cls: "vault-relay-sync-action-area",
      attr: {
        style:
          "padding: 14px; border-radius: 8px; background-color: var(--background-secondary); border: 1px solid var(--background-modifier-border); margin-bottom: 14px; text-align: center;",
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
        attr: { style: "width: 100%; min-height: 44px; font-size: 1.05em; font-weight: 600; cursor: pointer;" },
      });

      if (!hasActionableChanges) {
        syncBtn.setText("Repository Up to Date (Sync)");
      } else if (sem.totalConflicts > 0) {
        syncBtn.setText("Sync Blocked by Conflicts");
        syncBtn.disabled = true;
        syncBtn.removeClass("mod-cta");
        syncBtn.style.opacity = "0.6";
        syncBtn.style.cursor = "not-allowed";
      }

      syncBtn.onclick = async () => {
        if (sem.totalConflicts > 0) {
          new Notice("Please review and resolve conflicts before syncing.");
          return;
        }
        await this.handleUnifiedSync();
      };
    }

    // 8. Utility Actions: Preview Details + Advanced Toggle
    const actionsRow = contentEl.createDiv({
      cls: "vault-relay-actions-row",
      attr: { style: "display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;" },
    });

    const previewBtn = actionsRow.createEl("button", {
      text: "🔍 Preview Details",
      attr: { style: "min-height: 44px; min-width: 44px;" },
    });
    previewBtn.onclick = () => {
      new SyncPreviewModal(this.app, this.plugin).open();
    };

    const advancedToggle = actionsRow.createEl("button", {
      text: this.showAdvanced ? "Hide Advanced Details ▲" : "View Advanced Details ▼",
      attr: { style: "min-height: 44px; min-width: 44px; background: transparent; border: none; font-size: 0.82em; color: var(--text-muted); cursor: pointer;" },
    });
    advancedToggle.onclick = () => {
      this.showAdvanced = !this.showAdvanced;
      this.render();
    };

    // 9. Lightweight Footer (Unchanged presentation)
    const footer = contentEl.createDiv({
      cls: "vault-relay-dashboard-footer",
      attr: { style: "text-align: center; padding: 4px 0 2px 0; font-size: 0.82em; color: var(--text-muted);" },
    });
    footer.setText(`${unchangedCount} files already in sync`);

    // 10. Collapsible Advanced Section
    if (this.showAdvanced) {
      this.renderAdvancedSection(contentEl);
    }
  }

  private renderSummaryCard(
    container: HTMLElement,
    title: string,
    primaryCount: number,
    secondaryText: string,
    color: string,
    isWarning?: boolean
  ): void {
    const card = container.createDiv({
      attr: {
        style: `padding: 12px 14px; border-radius: 8px; background-color: ${
          isWarning ? "rgba(231, 76, 60, 0.08)" : "var(--background-secondary)"
        }; border: 1px solid ${
          isWarning ? "var(--color-red, #e74c3c)" : "var(--background-modifier-border)"
        }; display: flex; flex-direction: column; justify-content: center; min-height: 64px; text-align: left;`,
      },
    });
    card.addClass("vault-relay-summary-card");
    if (isWarning) {
      card.addClass("vault-relay-summary-card-warning");
    }

    card.createDiv({
      text: title,
      attr: { style: "font-size: 0.78em; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;" },
    });

    card.createDiv({
      text: `${primaryCount} ${primaryCount === 1 ? "file" : "files"}`,
      attr: { style: `font-size: 1.22em; font-weight: 700; color: ${color}; line-height: 1.2; margin-bottom: 2px;` },
    });

    if (secondaryText) {
      card.createDiv({
        text: secondaryText,
        attr: { style: "font-size: 0.75em; color: var(--text-muted); line-height: 1.2; word-break: break-word;" },
      });
    }
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
    const opBtns = adv.createDiv({ attr: { style: "display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;" } });
    const pullBtn = opBtns.createEl("button", { text: "Safe Pull Only", attr: { style: "min-height: 44px; min-width: 44px;" } });
    pullBtn.onclick = () => {
      new PullConfirmModal(this.app, this.plugin, () => this.runScanAndRender()).open();
    };

    const pushBtn = opBtns.createEl("button", { text: "Safe Push Only", attr: { style: "min-height: 44px; min-width: 44px;" } });
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
        const label = item.isMove && item.movedTo
          ? `Move → ${item.movedTo}`
          : item.isMove && item.movedFrom
          ? `Move ← ${item.movedFrom}`
          : item.category;
        row.createDiv({ text: item.path, attr: { style: "word-break: break-all; font-family: var(--font-monospace);" } });
        row.createDiv({ text: label, attr: { style: "font-weight: 600; color: var(--text-muted);" } });
      }
    }
  }
}
