/**
 * Read-Only Sync Preview Modal for Vault Relay
 *
 * Inspects differences between local Obsidian vault and remote GitHub repository.
 * Shows classified changes, case collisions, and provides a trigger for Safe Pull.
 */

import { App, Modal, Notice, setIcon } from "obsidian";
import type VaultRelayPlugin from "../main";
import { GitHubClient } from "../github/githubClient";
import { SyncEngine } from "../sync/syncEngine";
import { SyncCategory, SyncPreviewItem, SyncPreviewReport } from "../sync/syncTypes";
import { computeSemanticPreview } from "../sync/semanticSummary";
import { getStoredPat } from "../security/secretStore";
import { sanitizeErrorMessage } from "../security/redact";
import { PullConfirmModal } from "./pullConfirmModal";
import { PushConfirmModal } from "./pushConfirmModal";

export class SyncPreviewModal extends Modal {
  private plugin: VaultRelayPlugin;
  private report: SyncPreviewReport | null = null;
  private activeCategoryFilter: SyncCategory | "ALL" | "MOVES" = "ALL";
  private isLoading = false;
  public isModalOpen = false;

  constructor(app: App, plugin: VaultRelayPlugin) {
    super(app);
    this.plugin = plugin;
  }

  public onOpen(): void {
    this.modalEl.addClass("vault-relay-modal");
    this.isModalOpen = true;
    this.modalEl.addClass("vault-relay-preview-modal");
    this.modalEl.style.maxWidth = "850px";
    this.modalEl.style.width = "90vw";
    this.runScanAndRender();
  }

  public onClose(): void {
    this.isModalOpen = false;
    const { contentEl } = this;
    contentEl.empty();
  }

  public async runScanAndRender(): Promise<void> {
    this.isLoading = true;
    this.renderLoading();

    try {
      const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
      if (!token || !this.plugin.settings.owner || !this.plugin.settings.repo) {
        this.renderError(
          "GitHub Vault Relay is not fully configured. Please configure your repository and save your PAT in Settings."
        );
        this.isLoading = false;
        return;
      }

      const client = new GitHubClient({
        token,
        owner: this.plugin.settings.owner,
        repo: this.plugin.settings.repo,
        branch: this.plugin.settings.branch,
      });

      const engine = new SyncEngine(this.app, this.plugin.settings, client);
      this.report = await engine.generatePreview();
      this.isLoading = false;
      if (!this.isModalOpen) return;
      this.renderReport();
    } catch (err) {
      this.isLoading = false;
      if (!this.isModalOpen) return;
      const safeMsg = sanitizeErrorMessage(err);
      this.renderError(safeMsg);
      new Notice(`GitHub Vault Relay scan error: ${safeMsg}`);
    }
  }

  private renderLoading(): void {
    const { contentEl } = this;
    contentEl.empty();

    const container = contentEl.createDiv({
      attr: {
        style:
          "display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px;",
      },
    });

    const iconDiv = container.createDiv({ attr: { style: "margin-bottom: 16px;" } });
    setIcon(iconDiv, "refresh-cw");
    iconDiv.style.animation = "spin 1s linear infinite";

    container.createEl("h3", { text: "Scanning Vault & GitHub Repository..." });
    container.createEl("p", {
      text: "Calculating canonical Git blob hashes and fetching remote tree from api.github.com...",
      attr: { style: "color: var(--text-muted); font-size: 0.9em;" },
    });
  }

  private renderError(message: string): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "GitHub Vault Relay - Sync Preview" });

    const errBox = contentEl.createDiv({
      attr: {
        style:
          "padding: 16px; border-radius: 6px; border-left: 4px solid var(--color-red, #e74c3c); background-color: var(--background-secondary); margin: 20px 0;",
      },
    });

    errBox.createEl("h4", {
      text: "Failed to load sync preview",
      attr: { style: "margin: 0 0 8px 0; color: var(--text-error, #e74c3c);" },
    });
    errBox.createEl("p", {
      text: message,
      attr: { style: "margin: 0; color: var(--text-muted); font-size: 0.95em;" },
    });

    const actions = contentEl.createDiv({
      attr: { style: "display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;" },
    });

    const retryBtn = actions.createEl("button", { text: "Retry Scan" });
    retryBtn.onclick = () => this.runScanAndRender();

    const closeBtn = actions.createEl("button", { text: "Close" });
    closeBtn.onclick = () => this.close();
  }

  private renderReport(): void {
    if (!this.report) return;
    const { contentEl } = this;
    contentEl.empty();

    // Header
    const headerEl = contentEl.createDiv({
      attr: {
        style:
          "display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; flex-wrap: wrap; gap: 10px;",
      },
    });

    const titleArea = headerEl.createDiv();
    titleArea.createEl("h2", { text: "GitHub Vault Relay - Sync Preview", attr: { style: "margin: 0 0 4px 0;" } });
    titleArea.createEl("div", {
      text: `Repository: ${this.plugin.settings.owner}/${this.plugin.settings.repo} | Branch: ${this.report.branch} (${
        this.report.remoteCommitSha ? this.report.remoteCommitSha.substring(0, 7) : "HEAD"
      })`,
      attr: { style: "color: var(--text-muted); font-size: 0.85em;" },
    });

    const actionArea = headerEl.createDiv({
      cls: "vault-relay-action-row",
      attr: { style: "display: flex; gap: 8px; flex-wrap: wrap;" },
    });

    const pullBtn = actionArea.createEl("button", {
      text: "Pull Safe Changes",
      cls: "mod-cta",
      attr: { style: "min-height: 44px; min-width: 44px; padding: 10px 16px;" },
    });
    pullBtn.onclick = () => {
      new PullConfirmModal(this.app, this.plugin, async () => {
        if (this.isModalOpen) {
          await this.runScanAndRender();
        }
      }).open();
    };

    const pushBtn = actionArea.createEl("button", {
      text: "Push Safe Changes",
      attr: { style: "min-height: 44px; min-width: 44px; padding: 10px 16px;" },
    });
    pushBtn.onclick = () => {
      new PushConfirmModal(this.app, this.plugin, async () => {
        if (this.isModalOpen) {
          await this.runScanAndRender();
        }
      }).open();
    };

    const refreshBtn = actionArea.createEl("button", {
      text: "Refresh",
      attr: { style: "min-height: 44px; min-width: 44px; padding: 10px 16px;" },
    });
    refreshBtn.onclick = () => this.runScanAndRender();

    // Truncated tree warning banner (TRUNCATED_TREE_POLICY)
    if (this.report.truncatedRemoteTree) {
      const truncBox = contentEl.createDiv({
        attr: {
          style:
            "padding: 10px 14px; border-radius: 4px; border-left: 4px solid var(--color-red, #e74c3c); background-color: var(--background-secondary); margin-bottom: 12px; font-size: 0.88em;",
        },
      });
      truncBox.createEl("strong", {
        text: "⚠️ Remote Tree Truncated (>100,000 objects): ",
        attr: { style: "color: var(--text-error, #e74c3c);" },
      });
      truncBox.createSpan({
        text: "GitHub API truncated the remote tree. Safe Pull is blocked to prevent partial synchronization.",
      });
    }

    // Case collisions alert banner
    if (this.report.caseCollisions && this.report.caseCollisions.length > 0) {
      const caseBox = contentEl.createDiv({
        attr: {
          style:
            "padding: 10px 14px; border-radius: 4px; border-left: 4px solid var(--color-orange, #e67e22); background-color: var(--background-secondary); margin-bottom: 12px; font-size: 0.88em;",
        },
      });
      caseBox.createEl("strong", { text: "⚠️ Case Collisions Detected: " });
      caseBox.createSpan({
        text: `Found ${this.report.caseCollisions.length} case-insensitive collisions. Affected files will be blocked during pull for safety.`,
      });
    }

    // Semantic Summary Badges Grid
    const semantic = computeSemanticPreview(this.report.items);
    const statsGrid = contentEl.createDiv({
      attr: {
        style:
          "display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin-bottom: 16px;",
      },
    });

    this.createStatBadge(statsGrid, "Local Only", semantic.pushCreate, "var(--color-cyan, #00b4d8)", "LOCAL_ONLY");
    this.createStatBadge(statsGrid, "Remote Only", semantic.pullCreate, "var(--color-blue, #0077b6)", "REMOTE_ONLY");
    this.createStatBadge(statsGrid, "Local Changed", semantic.pushUpdate, "var(--color-orange, #f39c12)", "LOCAL_CHANGED");
    this.createStatBadge(statsGrid, "Remote Changed", semantic.pullUpdate, "var(--color-purple, #9b59b6)", "REMOTE_CHANGED");
    this.createStatBadge(statsGrid, "Delete from GitHub", semantic.pushDeleteRemote, "var(--color-red, #e74c3c)", "LOCAL_DELETED");
    this.createStatBadge(statsGrid, "Remove locally", semantic.pullRemoveLocal, "var(--color-pink, #e84393)", "REMOTE_DELETED");
    if (semantic.totalSemanticMoves > 0) {
      this.createStatBadge(statsGrid, "Moves", semantic.totalSemanticMoves, "var(--color-purple, #8e44ad)", "MOVES");
    }
    this.createStatBadge(statsGrid, "Conflicts", semantic.totalConflicts, "var(--color-red, #d63031)", "POTENTIAL_CONFLICT");
    this.createStatBadge(statsGrid, "Unchanged", semantic.unchanged, "var(--color-green, #2ecc71)", "UNCHANGED");

    // Filter Bar
    const filterBar = contentEl.createDiv({
      cls: "vault-relay-filter-bar",
      attr: {
        style:
          "display: flex; gap: 6px; padding-bottom: 8px; margin-bottom: 12px; border-bottom: 1px solid var(--background-modifier-border); overflow-x: auto;",
      },
    });

    const displayTotalCount = this.report.items.filter((it) => !(it.isMove && it.movedFrom)).length;
    this.createFilterTab(filterBar, `All (${displayTotalCount})`, "ALL");
    this.createFilterTab(filterBar, `Local Only (${semantic.pushCreate})`, "LOCAL_ONLY");
    this.createFilterTab(filterBar, `Remote Only (${semantic.pullCreate})`, "REMOTE_ONLY");
    this.createFilterTab(filterBar, `Local Changed (${semantic.pushUpdate})`, "LOCAL_CHANGED");
    this.createFilterTab(filterBar, `Remote Changed (${semantic.pullUpdate})`, "REMOTE_CHANGED");
    if (semantic.pushDeleteRemote > 0) this.createFilterTab(filterBar, `Delete from GitHub (${semantic.pushDeleteRemote})`, "LOCAL_DELETED");
    if (semantic.pullRemoveLocal > 0) this.createFilterTab(filterBar, `Remove locally (${semantic.pullRemoveLocal})`, "REMOTE_DELETED");
    if (semantic.totalSemanticMoves > 0) this.createFilterTab(filterBar, `Moves (${semantic.totalSemanticMoves})`, "MOVES");
    if (semantic.deleteConflicts > 0) this.createFilterTab(filterBar, `Delete Conflict (${semantic.deleteConflicts})`, "DELETE_CONFLICT");
    this.createFilterTab(filterBar, `Conflicts (${semantic.contentConflicts})`, "POTENTIAL_CONFLICT");
    this.createFilterTab(filterBar, `Unchanged (${semantic.unchanged})`, "UNCHANGED");

    // File List
    let filteredItems: SyncPreviewItem[];
    if (this.activeCategoryFilter === "ALL") {
      filteredItems = this.report.items.filter((item) => !(item.isMove && item.movedFrom));
    } else if (this.activeCategoryFilter === "MOVES") {
      filteredItems = this.report.items.filter((item) => item.isMove && (item.movedTo || !item.movedFrom));
    } else if (this.activeCategoryFilter === "LOCAL_ONLY") {
      filteredItems = this.report.items.filter((item) => item.category === "LOCAL_ONLY" && !item.isMove);
    } else if (this.activeCategoryFilter === "REMOTE_ONLY") {
      filteredItems = this.report.items.filter((item) => item.category === "REMOTE_ONLY" && !item.isMove);
    } else if (this.activeCategoryFilter === "LOCAL_DELETED") {
      filteredItems = this.report.items.filter((item) => item.category === "LOCAL_DELETED" && !item.isMove);
    } else if (this.activeCategoryFilter === "REMOTE_DELETED") {
      filteredItems = this.report.items.filter((item) => item.category === "REMOTE_DELETED" && !item.isMove);
    } else {
      filteredItems = this.report.items.filter((item) => item.category === this.activeCategoryFilter);
    }

    const listContainer = contentEl.createDiv({
      attr: {
        style:
          "max-height: 380px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; background-color: var(--background-primary);",
      },
    });

    if (filteredItems.length === 0) {
      const emptyBox = listContainer.createDiv({
        attr: { style: "padding: 30px; text-align: center; color: var(--text-muted); font-size: 0.9em;" },
      });
      emptyBox.setText("No items match the selected category.");
    } else {
      for (const item of filteredItems) {
        this.renderItemRow(listContainer, item);
      }
    }
  }

  private createStatBadge(
    parent: HTMLElement,
    label: string,
    count: number,
    color: string,
    category: SyncCategory | "MOVES"
  ): void {
    const isSelected = this.activeCategoryFilter === category;
    const card = parent.createDiv({
      attr: {
        style: `padding: 8px 10px; border-radius: 6px; background-color: var(--background-secondary); border: 1px solid ${
          isSelected ? color : "var(--background-modifier-border)"
        }; cursor: pointer; text-align: center; transition: all 0.15s ease;`,
      },
    });

    card.onclick = () => {
      this.activeCategoryFilter = isSelected ? "ALL" : category;
      this.renderReport();
    };

    card.createDiv({
      text: String(count),
      attr: { style: `font-size: 1.3em; font-weight: bold; color: ${count > 0 ? color : "var(--text-muted)"};` },
    });
    card.createDiv({
      text: label,
      attr: { style: "font-size: 0.75em; color: var(--text-muted); white-space: nowrap; margin-top: 2px;" },
    });
  }

  private createFilterTab(parent: HTMLElement, label: string, filter: SyncCategory | "ALL" | "MOVES"): void {
    const isSelected = this.activeCategoryFilter === filter;
    const tab = parent.createEl("button", {
      text: label,
      cls: isSelected ? "mod-cta" : "",
      attr: {
        style: `font-size: 0.78em; padding: 4px 8px; border-radius: 4px; white-space: nowrap; ${
          isSelected ? "" : "background: transparent; border: none; color: var(--text-muted);"
        }`,
      },
    });

    tab.onclick = () => {
      this.activeCategoryFilter = filter;
      this.renderReport();
    };
  }

  private renderItemRow(parent: HTMLElement, item: SyncPreviewItem): void {
    const row = parent.createDiv({
      attr: {
        style:
          "display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--background-modifier-border); font-size: 0.85em; gap: 8px;",
      },
    });

    const left = row.createDiv({ attr: { style: "overflow: hidden; text-overflow: ellipsis; flex: 1;" } });
    if (item.isMove && item.movedTo) {
      const moveTitle = left.createDiv({
        attr: {
          style:
            "font-weight: 500; word-break: break-all; overflow-wrap: anywhere; color: var(--text-normal); display: flex; flex-wrap: wrap; align-items: center; gap: 4px;",
        },
      });
      moveTitle.createSpan({ text: item.path, attr: { style: "text-decoration: line-through; opacity: 0.75;" } });
      moveTitle.createSpan({ text: " → ", attr: { style: "font-weight: bold; color: var(--color-purple, #9b59b6);" } });
      moveTitle.createSpan({ text: item.movedTo, attr: { style: "font-weight: 600;" } });
    } else {
      left.createDiv({
        text: item.path,
        attr: { style: "font-weight: 500; word-break: break-all; overflow-wrap: anywhere; color: var(--text-normal);" },
      });
    }

    if (item.isMove && !item.movedTo && item.movedFrom) {
      left.createDiv({
        text: `📦 Move destination from: ${item.movedFrom}`,
        attr: { style: "font-size: 0.8em; color: var(--color-purple, #9b59b6); margin-top: 2px; font-weight: 500;" },
      });
    }

    if (item.deleteConflictType) {
      left.createDiv({
        text: `⚠️ Delete conflict: ${
          item.deleteConflictType === "LOCAL_DELETED_REMOTE_MODIFIED"
            ? "deleted locally, modified remotely"
            : "deleted remotely, modified locally"
        }`,
        attr: { style: "font-size: 0.8em; color: var(--color-red, #e74c3c); margin-top: 2px; font-weight: 500;" },
      });
    }

    if (item.details) {
      left.createDiv({
        text: item.details,
        attr: { style: "font-size: 0.8em; color: var(--text-muted); margin-top: 2px;" },
      });
    }

    if (item.isOversized) {
      left.createDiv({
        text: "⚠️ Oversized (>25 MiB mobile safety ceiling). Will be skipped during pull.",
        attr: { style: "font-size: 0.78em; color: var(--color-orange, #e67e22); margin-top: 2px;" },
      });
    }

    if (item.unsafeReason) {
      left.createDiv({
        text: `🚫 Path unsafe: ${item.unsafeReason}`,
        attr: { style: "font-size: 0.78em; color: var(--color-red, #e74c3c); margin-top: 2px;" },
      });
    }

    const right = row.createDiv({ attr: { style: "display: flex; align-items: center; gap: 8px; flex-shrink: 0;" } });

    // Category badge
    right.createSpan({
      text: this.getCategoryLabel(item.category, item.isMove),
      attr: {
        style: `padding: 2px 6px; border-radius: 3px; font-size: 0.75em; font-weight: 600; background-color: ${this.getCategoryBg(
          item.category,
          item.isMove
        )}; color: ${this.getCategoryFg(item.category, item.isMove)};`,
      },
    });

    // Hash indicator
    if (item.localSha || item.remoteSha) {
      right.createSpan({
        text: `L:${item.localSha ? item.localSha.substring(0, 6) : "-"} R:${
          item.remoteSha ? item.remoteSha.substring(0, 6) : "-"
        }`,
        attr: {
          style: "font-family: var(--font-monospace); font-size: 0.75em; color: var(--text-muted);",
        },
      });
    }
  }

  private getCategoryLabel(category: SyncCategory, isMove?: boolean): string {
    if (isMove) return "Move";
    switch (category) {
      case "LOCAL_ONLY":
        return "Local Only";
      case "REMOTE_ONLY":
        return "Remote Only";
      case "LOCAL_CHANGED":
        return "Local Changed";
      case "REMOTE_CHANGED":
        return "Remote Changed";
      case "LOCAL_DELETED":
        return "Delete from GitHub";
      case "REMOTE_DELETED":
        return "Remove locally";
      case "POTENTIAL_CONFLICT":
        return "Conflict";
      case "DELETE_CONFLICT":
        return "Delete Conflict";
      case "DELETED":
        return "Both Deleted";
      case "UNCHANGED":
        return "Unchanged";
    }
  }

  private getCategoryFg(category: SyncCategory, isMove?: boolean): string {
    if (isMove) return "#8e44ad";
    switch (category) {
      case "LOCAL_ONLY":
        return "#0077b6";
      case "REMOTE_ONLY":
        return "#023e8a";
      case "LOCAL_CHANGED":
        return "#d35400";
      case "REMOTE_CHANGED":
        return "#8e44ad";
      case "LOCAL_DELETED":
        return "#e74c3c";
      case "REMOTE_DELETED":
        return "#e84393";
      case "POTENTIAL_CONFLICT":
      case "DELETE_CONFLICT":
        return "#c0392b";
      case "DELETED":
        return "#7f8c8d";
      case "UNCHANGED":
        return "#27ae60";
    }
  }

  private getCategoryBg(category: SyncCategory, isMove?: boolean): string {
    if (isMove) return "rgba(155, 89, 182, 0.15)";
    switch (category) {
      case "LOCAL_ONLY":
        return "rgba(0, 180, 216, 0.15)";
      case "REMOTE_ONLY":
        return "rgba(0, 119, 182, 0.15)";
      case "LOCAL_CHANGED":
        return "rgba(243, 156, 18, 0.15)";
      case "REMOTE_CHANGED":
        return "rgba(155, 89, 182, 0.15)";
      case "LOCAL_DELETED":
        return "rgba(231, 76, 60, 0.15)";
      case "REMOTE_DELETED":
        return "rgba(232, 67, 147, 0.15)";
      case "POTENTIAL_CONFLICT":
      case "DELETE_CONFLICT":
        return "rgba(231, 76, 60, 0.15)";
      case "DELETED":
        return "rgba(127, 140, 141, 0.15)";
      case "UNCHANGED":
        return "rgba(46, 204, 113, 0.15)";
    }
  }
}
