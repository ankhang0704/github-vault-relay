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
import { SyncConfirmModal } from "./syncConfirmModal";
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
  private showFileInspection = false;
  public isModalOpen = false;

  constructor(app: App, plugin: VaultRelayPlugin) {
    super(app);
    this.plugin = plugin;
  }

  public onOpen(): void {
    this.isModalOpen = true;
    this.modalEl.addClass("vault-relay-modal");
    this.modalEl.addClass("vault-relay-dashboard-modal");
    void this.runScanAndRender().catch((err) => {
      new Notice(sanitizeErrorMessage(err));
    });
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
      cls: "vault-relay-notice-box",
    });

    const btn = contentEl.createEl("button", { text: "Close", cls: "mod-cta vault-relay-btn-lg" });
    btn.onclick = () => this.close();
  }

  private render(): void {
    if (!this.isModalOpen) return;
    const { contentEl } = this;
    contentEl.empty();

    // 1. Header with Repository info
    const header = contentEl.createDiv({
      cls: "vault-relay-dashboard-header",
    });
    const titleCol = header.createDiv();
    titleCol.createEl("h2", { text: "GitHub Vault Relay", cls: "vault-relay-dashboard-title" });
    titleCol.createDiv({
      text: `${this.plugin.settings.owner}/${this.plugin.settings.repo} (${this.plugin.settings.branch || "main"})`,
      cls: "vault-relay-repo-info",
    });

    const refreshBtn = header.createEl("button", { text: "↻ Refresh", cls: "vault-relay-btn-lg" });
    refreshBtn.disabled = this.isLoading || this.isSyncing;
    refreshBtn.onclick = () => {
      void this.runScanAndRender().catch((err) => {
        new Notice(sanitizeErrorMessage(err));
      });
    };

    if (this.isLoading) {
      const loadingBox = contentEl.createDiv({
        cls: "vault-relay-loading-box",
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
      });
      zeroStateCard.createDiv({
        text: "✓ Everything is in sync",
        cls: "vault-relay-zero-state-title",
      });
      zeroStateCard.createDiv({
        text: `${unchangedCount} files synchronized`,
        cls: "vault-relay-zero-state-desc",
      });
    } else {
      // 4. Compact Summary Cards (Max 3 cards: Changes, Moves, Conflicts)
      const summaryGrid = contentEl.createDiv({
        cls: "vault-relay-summary-cards",
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
          "changes"
        );
      }

      // Card 2: Moves (Exact semantic moves)
      if (totalMoves > 0) {
        this.renderSummaryCard(
          summaryGrid,
          "Moves",
          totalMoves,
          "",
          "moves"
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
          "conflicts",
          true
        );
      }
    }

    // 5. Destructive Changes Banner (appears only when deletions exist, before Sync Now)
    if (hasDeletions) {
      const delBanner = contentEl.createDiv({
        cls: "vault-relay-destructive-banner",
      });
      delBanner.createDiv({
        text: "⚠ Destructive changes",
        cls: "vault-relay-destructive-title",
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
        cls: "vault-relay-destructive-desc",
      });
    }

    // 6. Conflict Review Banner (if any unresolved conflicts)
    if (sem.totalConflicts > 0) {
      const banner = contentEl.createDiv({
        cls: "vault-relay-conflict-banner",
      });
      const conflictText =
        sem.deleteConflicts > 0 && sem.contentConflicts > 0
          ? `⚠ ${sem.totalConflicts} conflict(s) require review (${sem.deleteConflicts} delete conflict(s))`
          : sem.deleteConflicts > 0
          ? `⚠ ${sem.deleteConflicts} delete conflict(s) require review`
          : `⚠ ${sem.contentConflicts} conflict(s) require review`;

      banner.createDiv({
        text: conflictText,
        cls: "vault-relay-conflict-title",
      });
      const reviewBtn = banner.createEl("button", {
        text: "Review Conflicts",
        cls: "mod-warning vault-relay-btn-lg",
      });
      reviewBtn.onclick = () => {
        new ConflictResolutionModal(
          this.app,
          this.plugin,
          () => {
            void this.runScanAndRender().catch((err) => {
              new Notice(sanitizeErrorMessage(err));
            });
          },
          this.report
        ).open();
      };
    }

    // 7. Primary Sync Action Area
    const syncCard = contentEl.createDiv({
      cls: "vault-relay-sync-action-area",
    });

    if (this.isSyncing && this.progressEvent) {
      const prog = this.progressEvent;
      syncCard.createDiv({
        text: getPhaseLabel(prog.phase),
        cls: "vault-relay-sync-phase",
      });
      if (prog.total > 0 && prog.completed > 0) {
        syncCard.createDiv({
          text: `${prog.completed} / ${prog.total} file(s)`,
          cls: "vault-relay-sync-count",
        });
      }
      if (prog.currentPath) {
        syncCard.createDiv({
          text: prog.currentPath,
          cls: "vault-relay-sync-path",
        });
      }
    } else {
      const syncBtn = syncCard.createEl("button", {
        text: "Sync Now",
        cls: "mod-cta vault-relay-btn-lg vault-relay-sync-btn",
      });

      if (!hasActionableChanges) {
        syncBtn.setText("Repository Up to Date (Sync)");
      } else if (sem.totalConflicts > 0) {
        syncBtn.setText("Sync Blocked by Conflicts");
        syncBtn.disabled = true;
        syncBtn.removeClass("mod-cta");
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
      cls: "vault-relay-action-row vault-relay-actions-row",
    });

    const previewBtn = actionsRow.createEl("button", {
      text: this.showFileInspection ? "Hide File Details ▲" : "🔍 Preview Details ▼",
      cls: "vault-relay-btn-lg",
    });
    previewBtn.onclick = () => {
      this.showFileInspection = !this.showFileInspection;
      this.render();
    };

    const advancedToggle = actionsRow.createEl("button", {
      text: this.showAdvanced ? "Hide Advanced Details ▲" : "View Advanced Details ▼",
      cls: "vault-relay-advanced-toggle vault-relay-btn-lg",
    });
    advancedToggle.onclick = () => {
      this.showAdvanced = !this.showAdvanced;
      this.render();
    };

    // 9. Lightweight Footer (Unchanged presentation)
    const footer = contentEl.createDiv({
      cls: "vault-relay-dashboard-footer",
    });
    footer.setText(`${unchangedCount} files already in sync`);

    // 10. Embedded File Inspection Section (Task 3)
    if (this.showFileInspection) {
      this.renderFileInspectionSection(contentEl);
    }

    // 11. Collapsible Advanced Section
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
      cls: "vault-relay-summary-card",
    });
    if (isWarning) {
      card.addClass("vault-relay-summary-card-warning");
    }

    card.createDiv({
      text: title,
      cls: "vault-relay-card-title",
    });

    const countCls =
      color === "changes"
        ? "vault-relay-card-count-changes"
        : color === "moves"
        ? "vault-relay-card-count-moves"
        : color === "conflicts"
        ? "vault-relay-card-count-conflicts"
        : "";

    card.createDiv({
      text: `${primaryCount} ${primaryCount === 1 ? "file" : "files"}`,
      cls: `vault-relay-card-count ${countCls}`.trim(),
    });

    if (secondaryText) {
      card.createDiv({
        text: secondaryText,
        cls: "vault-relay-card-desc",
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
      cls: "vault-relay-advanced-section",
    });

    adv.createEl("h3", { text: "Engineering Diagnostics & Individual Operations", cls: "vault-relay-advanced-title" });

    // Buttons for manual Safe Pull / Safe Push
    const opBtns = adv.createDiv({ cls: "vault-relay-action-row" });
    const pullBtn = opBtns.createEl("button", { text: "Safe Pull Only", cls: "vault-relay-btn-lg" });
    pullBtn.onclick = () => {
      new SyncConfirmModal(this.app, this.plugin, "pull", () => {
        void this.runScanAndRender().catch((err) => {
          new Notice(sanitizeErrorMessage(err));
        });
      }).open();
    };

    const pushBtn = opBtns.createEl("button", { text: "Safe Push Only", cls: "vault-relay-btn-lg" });
    pushBtn.onclick = () => {
      new SyncConfirmModal(this.app, this.plugin, "push", () => {
        void this.runScanAndRender().catch((err) => {
          new Notice(sanitizeErrorMessage(err));
        });
      }).open();
    };

    // Item List
    if (this.report) {
      const itemsList = adv.createDiv({
        cls: "vault-relay-file-list",
      });
      for (const item of this.report.items) {
        const row = itemsList.createDiv({
          cls: "vault-relay-file-row",
        });
        const label = item.isMove && item.movedTo
          ? `Move → ${item.movedTo}`
          : item.isMove && item.movedFrom
          ? `Move ← ${item.movedFrom}`
          : item.category;
        row.createDiv({ text: item.path, cls: "vault-relay-file-path" });
        row.createDiv({ text: label, cls: "vault-relay-file-label" });
      }
    }
  }

  private renderFileInspectionSection(container: HTMLElement): void {
    if (!this.report) return;

    const section = container.createDiv({
      cls: "vault-relay-advanced-section",
    });

    const headerRow = section.createDiv({
      cls: "vault-relay-action-row",
    });
    headerRow.createEl("h3", { text: "Detailed File Inspection", cls: "vault-relay-advanced-title" });

    const openSeparateBtn = headerRow.createEl("button", {
      text: "Open Standalone Window ↗",
      cls: "vault-relay-btn-lg",
    });
    openSeparateBtn.onclick = () => {
      new SyncPreviewModal(this.app, this.plugin).open();
    };

    // Filter bar
    const filterBar = section.createDiv({ cls: "vault-relay-action-row" });
    const filters: Array<{ label: string; value: SyncCategory | "ALL" }> = [
      { label: "All", value: "ALL" },
      { label: "Local Only", value: "LOCAL_ONLY" },
      { label: "Remote Only", value: "REMOTE_ONLY" },
      { label: "Local Changed", value: "LOCAL_CHANGED" },
      { label: "Remote Changed", value: "REMOTE_CHANGED" },
      { label: "Conflicts", value: "POTENTIAL_CONFLICT" },
      { label: "Deletes", value: "LOCAL_DELETED" },
    ];

    for (const f of filters) {
      const btn = filterBar.createEl("button", {
        text: f.label,
        cls: `vault-relay-btn-lg ${this.activeFilter === f.value ? "mod-cta" : ""}`.trim(),
      });
      btn.onclick = () => {
        this.activeFilter = f.value;
        this.render();
      };
    }

    const items = this.report.items.filter((item) => {
      if (this.activeFilter === "ALL") return item.category !== "UNCHANGED";
      if (this.activeFilter === "LOCAL_DELETED") {
        return item.category === "LOCAL_DELETED" || item.category === "REMOTE_DELETED";
      }
      return item.category === this.activeFilter;
    });

    const itemsList = section.createDiv({
      cls: "vault-relay-file-list",
    });

    if (items.length === 0) {
      const emptyEl = itemsList.createDiv({ cls: "vault-relay-zero-state" });
      emptyEl.createDiv({ text: "No files match the selected filter.", cls: "vault-relay-zero-state-desc" });
    } else {
      for (const item of items) {
        const row = itemsList.createDiv({
          cls: "vault-relay-file-row",
        });
        const label = item.isMove && item.movedTo
          ? `Move → ${item.movedTo}`
          : item.isMove && item.movedFrom
          ? `Move ← ${item.movedFrom}`
          : item.category;
        row.createDiv({ text: item.path, cls: "vault-relay-file-path" });
        row.createDiv({ text: label, cls: "vault-relay-file-label" });
      }
    }
  }
}
