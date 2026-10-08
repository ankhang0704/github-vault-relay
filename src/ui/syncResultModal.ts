/**
 * Unified Safe Sync Result Modal for Vault Relay
 *
 * Displays honest, detailed execution reports following Safe Pull and Safe Push operations.
 */

import { App, Modal } from "obsidian";
import {
  PullExecutionReport,
  PullFileResult,
  PushExecutionReport,
  PushFileResult,
} from "../sync/syncTypes";
import {
  computeSemanticPullResults,
  computeSemanticPushResults,
} from "../sync/semanticSummary";
import { SyncDirection } from "./syncConfirmModal";

export class SyncResultModal extends Modal {
  private report: PullExecutionReport | PushExecutionReport;
  private direction: SyncDirection;

  constructor(
    app: App,
    report: PullExecutionReport | PushExecutionReport,
    direction?: SyncDirection
  ) {
    super(app);
    this.report = report;
    if (direction) {
      this.direction = direction;
    } else {
      const isPush = "newCommitSha" in report || "pushedCreated" in (report.counts ?? {});
      this.direction = isPush ? "push" : "pull";
    }
  }

  public onOpen(): void {
    this.modalEl.addClass("vault-relay-modal");
    this.modalEl.addClass("vault-relay-result-modal");
    this.render();
  }

  public onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const isPull = this.direction === "pull";
    contentEl.createEl("h2", { text: isPull ? "Safe Pull Results" : "Safe Push Results" });

    // Status Banner
    const counts = isPull
      ? computeSemanticPullResults(this.report as PullExecutionReport)
      : computeSemanticPushResults(this.report as PushExecutionReport);

    let bannerModifier = "vault-relay-result-banner-pass";
    let statusIcon = "✅";
    let statusTitle = "PASS";

    if (this.report.status === "FAIL") {
      bannerModifier = "vault-relay-result-banner-fail";
      statusIcon = "❌";
      statusTitle = "FAIL";
    } else if (this.report.status === "ABORTED") {
      bannerModifier = "vault-relay-result-banner-aborted";
      statusIcon = "⚠️";
      statusTitle = "ABORTED";
    } else if (this.report.status === "PASS_WITH_WARNINGS") {
      bannerModifier = "vault-relay-result-banner-warning";
      statusIcon = "⚠️";
      statusTitle = "PASS WITH WARNINGS";
    }

    const statusBanner = contentEl.createDiv({
      cls: `vault-relay-result-banner ${bannerModifier}`,
    });

    statusBanner.createDiv({
      text: `${statusIcon} ${statusTitle} — ${this.report.summaryMessage}`,
      cls: "vault-relay-result-title",
    });

    if (!isPull) {
      const pushReport = this.report as PushExecutionReport;
      if (pushReport.newCommitSha) {
        statusBanner.createDiv({
          text: `New Remote Commit: ${pushReport.newCommitSha.substring(0, 7)} (branch: ${pushReport.branch})`,
          cls: "vault-relay-result-commit",
        });
      }
    }

    // Summary Stat Badges
    const statsGrid = contentEl.createDiv({
      cls: "vault-relay-stat-grid",
    });

    this.createBadge(statsGrid, "Created", counts.created, "var(--color-green, #2ecc71)");
    this.createBadge(statsGrid, "Updated", counts.updated, "var(--color-cyan, #00b4d8)");

    if (isPull) {
      const pullCounts = counts as ReturnType<typeof computeSemanticPullResults>;
      if (pullCounts.removed > 0) {
        this.createBadge(statsGrid, "Removed locally", pullCounts.removed, "var(--color-red, #e74c3c)");
      }
    } else {
      const pushCounts = counts as ReturnType<typeof computeSemanticPushResults>;
      if (pushCounts.deleted > 0) {
        this.createBadge(statsGrid, "Deleted from GitHub", pushCounts.deleted, "var(--color-red, #e74c3c)");
      }
    }

    if (counts.moved > 0) {
      this.createBadge(statsGrid, "Moved", counts.moved, "var(--color-purple, #9b59b6)");
    }
    this.createBadge(statsGrid, "Conflicts", counts.conflicts, "var(--color-red, #e74c3c)");
    this.createBadge(statsGrid, "Oversized", counts.oversized, "var(--color-purple, #9b59b6)");
    this.createBadge(statsGrid, "Unsafe", counts.unsafe, "var(--color-orange, #e67e22)");
    this.createBadge(statsGrid, "Failed", counts.failed, "var(--color-red, #c0392b)");

    // Actions Detail List
    contentEl.createEl("h4", { text: "Execution Details", cls: "vault-relay-box-title" });

    const listContainer = contentEl.createDiv({
      cls: "vault-relay-file-list",
    });

    const activeResults = isPull
      ? (this.report as PullExecutionReport).results.filter(
          (r) => r.action !== "SKIP_UNCHANGED" && r.action !== "SKIP_LOCAL_ONLY" && r.action !== "SKIP_LOCAL_CHANGED"
        )
      : (this.report as PushExecutionReport).results.filter(
          (r) => r.action !== "SKIP_UNCHANGED" && r.action !== "SKIP_REMOTE_ONLY" && r.action !== "SKIP_REMOTE_CHANGED"
        );

    if (activeResults.length === 0) {
      const emptyEl = listContainer.createDiv({
        cls: "vault-relay-empty-state-text",
      });
      const emptyMsg = isPull
        ? "No file changes required execution. Vault is fully up to date."
        : "No local changes required push. Remote repository is up to date.";
      emptyEl.setText(emptyMsg);
    } else {
      for (const res of activeResults) {
        this.renderRow(listContainer, res, isPull);
      }
    }

    // Close Action
    const actions = contentEl.createDiv({
      cls: "vault-relay-action-row",
    });

    const closeBtn = actions.createEl("button", {
      text: "Done",
      cls: "mod-cta vault-relay-btn-lg",
    });
    closeBtn.onclick = () => this.close();
  }

  private createBadge(parent: HTMLElement, label: string, count: number, _color: string): void {
    const card = parent.createDiv({
      cls: "vault-relay-stat-badge",
    });

    card.createDiv({
      text: String(count),
      cls: "vault-relay-stat-count",
    });
    card.createDiv({
      text: label,
      cls: "vault-relay-stat-label",
    });
  }

  private renderRow(
    parent: HTMLElement,
    res: PullFileResult | PushFileResult,
    isPull: boolean
  ): void {
    const row = parent.createDiv({
      cls: "vault-relay-file-row",
    });

    const header = row.createDiv({
      cls: "vault-relay-file-info",
    });

    header.createDiv({
      text: res.path,
      cls: "vault-relay-file-path",
    });

    const badgeGroup = row.createDiv({ cls: "vault-relay-badge-group" });

    if (res.action === "PULL_DELETE") {
      badgeGroup.createSpan({
        text: "Removed locally",
        cls: "vault-relay-badge vault-relay-badge-delete",
      });
    } else if (res.action === "PUSH_DELETE") {
      badgeGroup.createSpan({
        text: "Deleted from GitHub",
        cls: "vault-relay-badge vault-relay-badge-delete",
      });
    }

    let statusCls = "vault-relay-badge-status-success";
    if (res.status === "FAILED") statusCls = "vault-relay-badge-status-failed";
    if (res.status === "CONFLICT_PRESERVED" || res.status === "BLOCKED_CONFLICT") statusCls = "vault-relay-badge-status-conflict";
    if (res.status === "SKIPPED") statusCls = "vault-relay-badge-status-skipped";

    badgeGroup.createSpan({
      text: res.status,
      cls: `vault-relay-badge ${statusCls}`,
    });

    if (res.message) {
      row.createDiv({
        text: res.message,
        cls: "vault-relay-row-message",
      });
    }

    if (isPull && "conflictPath" in res && res.conflictPath) {
      row.createDiv({
        text: `Preserved conflict file: ${res.conflictPath}`,
        cls: "vault-relay-conflict-preserved-path",
      });
    }
  }
}
