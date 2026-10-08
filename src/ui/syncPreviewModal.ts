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
import { SyncConfirmModal } from "./syncConfirmModal";

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
    void this.runScanAndRender().catch((err) => {
      this.renderError(sanitizeErrorMessage(err));
    });
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
      cls: "vault-relay-loading-box",
    });

    const iconDiv = container.createDiv({ cls: "vault-relay-loading-icon" });
    setIcon(iconDiv, "refresh-cw");
    iconDiv.addClass("vault-relay-spin");

    container.createEl("h3", { text: "Scanning Vault & GitHub Repository..." });
    container.createEl("p", {
      text: "Calculating canonical Git blob hashes and fetching remote tree from api.github.com...",
      cls: "vault-relay-loading-subtitle",
    });
  }

  private renderError(message: string): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "GitHub Vault Relay - Sync Preview" });

    const errBox = contentEl.createDiv({
      cls: "vault-relay-error-box",
    });

    errBox.createEl("h4", {
      text: "Failed to load sync preview",
      cls: "vault-relay-error-title",
    });
    errBox.createEl("p", {
      text: message,
      cls: "vault-relay-error-desc",
    });

    const actions = contentEl.createDiv({
      cls: "vault-relay-action-row",
    });

    const retryBtn = actions.createEl("button", { text: "Retry Scan", cls: "vault-relay-btn-lg" });
    retryBtn.onclick = () => {
      void this.runScanAndRender().catch((err) => {
        this.renderError(sanitizeErrorMessage(err));
      });
    };

    const closeBtn = actions.createEl("button", { text: "Close", cls: "vault-relay-btn-lg" });
    closeBtn.onclick = () => this.close();
  }

  private renderReport(): void {
    if (!this.report) return;
    const { contentEl } = this;
    contentEl.empty();

    // Header
    const headerEl = contentEl.createDiv({
      cls: "vault-relay-preview-header",
    });

    const titleArea = headerEl.createDiv();
    titleArea.createEl("h2", { text: "GitHub Vault Relay - Sync Preview", cls: "vault-relay-preview-title" });
    titleArea.createDiv({
      text: `Repository: ${this.plugin.settings.owner}/${this.plugin.settings.repo} | Branch: ${this.report.branch} (${
        this.report.remoteCommitSha ? this.report.remoteCommitSha.substring(0, 7) : "HEAD"
      })`,
      cls: "vault-relay-repo-info",
    });

    const actionArea = headerEl.createDiv({
      cls: "vault-relay-action-row",
    });

    const pullBtn = actionArea.createEl("button", {
      text: "Pull Safe Changes",
      cls: "mod-cta vault-relay-btn-lg",
    });
    pullBtn.onclick = () => {
      new SyncConfirmModal(this.app, this.plugin, "pull", async () => {
        if (this.isModalOpen) {
          await this.runScanAndRender();
        }
      }).open();
    };

    const pushBtn = actionArea.createEl("button", {
      text: "Push Safe Changes",
      cls: "vault-relay-btn-lg",
    });
    pushBtn.onclick = () => {
      new SyncConfirmModal(this.app, this.plugin, "push", async () => {
        if (this.isModalOpen) {
          await this.runScanAndRender();
        }
      }).open();
    };

    const refreshBtn = actionArea.createEl("button", {
      text: "Refresh",
      cls: "vault-relay-btn-lg",
    });
    refreshBtn.onclick = () => {
      void this.runScanAndRender().catch((err) => {
        this.renderError(sanitizeErrorMessage(err));
      });
    };

    // Truncated tree warning banner (TRUNCATED_TREE_POLICY)
    if (this.report.truncatedRemoteTree) {
      const truncBox = contentEl.createDiv({
        cls: "vault-relay-warning-box",
      });
      truncBox.createEl("strong", {
        text: "⚠️ Remote Tree Truncated (>100,000 objects): ",
        cls: "vault-relay-warning-title",
      });
      truncBox.createSpan({
        text: "GitHub API truncated the remote tree. Safe Pull is blocked to prevent partial synchronization.",
      });
    }

    // Case collisions alert banner
    if (this.report.caseCollisions && this.report.caseCollisions.length > 0) {
      const caseBox = contentEl.createDiv({
        cls: "vault-relay-warning-box vault-relay-warning-box-orange",
      });
      caseBox.createEl("strong", { text: "⚠️ Case Collisions Detected: " });
      caseBox.createSpan({
        text: `Found ${this.report.caseCollisions.length} case-insensitive collisions. Affected files will be blocked during pull for safety.`,
      });
    }

    // Semantic Summary Badges Grid
    const semantic = computeSemanticPreview(this.report.items);
    const statsGrid = contentEl.createDiv({
      cls: "vault-relay-stat-grid",
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
      cls: "vault-relay-file-list",
    });

    if (filteredItems.length === 0) {
      const emptyBox = listContainer.createDiv({
        cls: "vault-relay-empty-state-text",
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
    _color: string,
    category: SyncCategory | "MOVES"
  ): void {
    const isSelected = this.activeCategoryFilter === category;
    const card = parent.createDiv({
      cls: `vault-relay-stat-badge ${isSelected ? "vault-relay-stat-badge-selected" : ""}`.trim(),
    });

    card.onclick = () => {
      this.activeCategoryFilter = isSelected ? "ALL" : category;
      this.renderReport();
    };

    card.createDiv({
      text: String(count),
      cls: "vault-relay-stat-count",
    });
    card.createDiv({
      text: label,
      cls: "vault-relay-stat-label",
    });
  }

  private createFilterTab(parent: HTMLElement, label: string, filter: SyncCategory | "ALL" | "MOVES"): void {
    const isSelected = this.activeCategoryFilter === filter;
    const tab = parent.createEl("button", {
      text: label,
      cls: isSelected ? "mod-cta vault-relay-filter-tab" : "vault-relay-filter-tab",
    });

    tab.onclick = () => {
      this.activeCategoryFilter = filter;
      this.renderReport();
    };
  }

  private renderItemRow(parent: HTMLElement, item: SyncPreviewItem): void {
    const row = parent.createDiv({
      cls: "vault-relay-file-row",
    });

    const left = row.createDiv({ cls: "vault-relay-file-info" });
    if (item.isMove && item.movedTo) {
      const moveTitle = left.createDiv({
        cls: "vault-relay-move-title",
      });
      moveTitle.createSpan({ text: item.path, cls: "vault-relay-strikethrough" });
      moveTitle.createSpan({ text: " → ", cls: "vault-relay-move-highlight" });
      moveTitle.createSpan({ text: item.movedTo, cls: "vault-relay-file-path" });
    } else {
      left.createDiv({
        text: item.path,
        cls: "vault-relay-file-path",
      });
    }

    if (item.isMove && !item.movedTo && item.movedFrom) {
      left.createDiv({
        text: `📦 Move destination from: ${item.movedFrom}`,
        cls: "vault-relay-move-dest",
      });
    }

    if (item.deleteConflictType) {
      left.createDiv({
        text: `⚠️ Delete conflict: ${
          item.deleteConflictType === "LOCAL_DELETED_REMOTE_MODIFIED"
            ? "deleted locally, modified remotely"
            : "deleted remotely, modified locally"
        }`,
        cls: "vault-relay-delete-conflict-text",
      });
    }

    if (item.details) {
      left.createDiv({
        text: item.details,
        cls: "vault-relay-file-details",
      });
    }

    if (item.isOversized) {
      left.createDiv({
        text: "⚠️ Oversized (>25 MiB mobile safety ceiling). Will be skipped during pull.",
        cls: "vault-relay-oversized-text",
      });
    }

    if (item.unsafeReason) {
      left.createDiv({
        text: `🚫 Path unsafe: ${item.unsafeReason}`,
        cls: "vault-relay-unsafe-text",
      });
    }

    const right = row.createDiv({ cls: "vault-relay-file-actions" });

    // Category badge
    const badgeCategoryCls = item.isMove ? "vault-relay-badge-MOVES" : `vault-relay-badge-${item.category}`;
    right.createSpan({
      text: this.getCategoryLabel(item.category, item.isMove),
      cls: `vault-relay-badge ${badgeCategoryCls}`,
    });

    // Hash indicator
    if (item.localSha || item.remoteSha) {
      right.createSpan({
        text: `L:${item.localSha ? item.localSha.substring(0, 6) : "-"} R:${
          item.remoteSha ? item.remoteSha.substring(0, 6) : "-"
        }`,
        cls: "vault-relay-hash-indicator",
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
