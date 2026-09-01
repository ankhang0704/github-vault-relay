/**
 * Safe Pull Result Modal for Vault Relay
 *
 * Displays honest, detailed execution reports following a Safe Pull operation.
 */

import { App, Modal } from "obsidian";
import { PullExecutionReport, PullFileResult } from "../sync/syncTypes";

export class PullResultModal extends Modal {
  private report: PullExecutionReport;

  constructor(app: App, report: PullExecutionReport) {
    super(app);
    this.report = report;
  }

  public onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("vault-relay-result-modal");
    this.modalEl.style.maxWidth = "750px";
    this.modalEl.style.width = "90vw";

    contentEl.empty();

    // Header
    const headerEl = contentEl.createDiv({ attr: { style: "margin-bottom: 16px;" } });
    headerEl.createEl("h2", { text: "Vault Relay - Safe Pull Report", attr: { style: "margin: 0 0 6px 0;" } });

    // Status Banner
    const counts = this.report.counts;
    let statusBg = "rgba(46, 204, 113, 0.15)";
    let statusFg = "var(--color-green, #2ecc71)";
    let statusIcon = "✅";
    let statusTitle = "PASS";

    if (this.report.status === "FAIL") {
      statusBg = "rgba(231, 76, 60, 0.15)";
      statusFg = "var(--color-red, #e74c3c)";
      statusIcon = "❌";
      statusTitle = "FAIL";
    } else if (this.report.status === "ABORTED") {
      statusBg = "rgba(230, 126, 34, 0.15)";
      statusFg = "var(--color-orange, #e67e22)";
      statusIcon = "⚠️";
      statusTitle = "ABORTED";
    } else if (this.report.status === "PASS_WITH_WARNINGS") {
      statusBg = "rgba(241, 196, 15, 0.15)";
      statusFg = "var(--color-yellow, #f39c12)";
      statusIcon = "⚠️";
      statusTitle = "PASS WITH WARNINGS";
    }

    const statusBanner = contentEl.createDiv({
      attr: {
        style: `padding: 12px 16px; border-radius: 6px; background-color: ${statusBg}; border-left: 4px solid ${statusFg}; margin-bottom: 16px;`,
      },
    });

    statusBanner.createEl("div", {
      text: `${statusIcon} ${statusTitle} — ${this.report.summaryMessage}`,
      attr: { style: `font-weight: 600; color: ${statusFg}; margin-bottom: 4px;` },
    });

    // Summary Stat Badges
    const statsGrid = contentEl.createDiv({
      attr: {
        style:
          "display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; margin-bottom: 16px;",
      },
    });

    this.createBadge(statsGrid, "Created", counts.pulledCreated, "var(--color-green, #2ecc71)");
    this.createBadge(statsGrid, "Updated", counts.pulledUpdated, "var(--color-cyan, #00b4d8)");
    this.createBadge(statsGrid, "Conflicts", counts.conflictsPreserved, "var(--color-red, #e74c3c)");
    this.createBadge(statsGrid, "Oversized", counts.skippedOversized, "var(--color-purple, #9b59b6)");
    this.createBadge(statsGrid, "Unsafe", counts.skippedUnsafe, "var(--color-orange, #e67e22)");
    this.createBadge(statsGrid, "Failed", counts.failed, "var(--color-red, #c0392b)");

    // Actions Detail List
    contentEl.createEl("h4", { text: "Execution Details", attr: { style: "margin: 12px 0 8px 0;" } });

    const listContainer = contentEl.createDiv({
      attr: {
        style:
          "max-height: 280px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; background-color: var(--background-primary);",
      },
    });

    const activeResults = this.report.results.filter(
      (r) => r.action !== "SKIP_UNCHANGED" && r.action !== "SKIP_LOCAL_ONLY" && r.action !== "SKIP_LOCAL_CHANGED"
    );

    if (activeResults.length === 0) {
      const emptyEl = listContainer.createDiv({
        attr: { style: "padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.9em;" },
      });
      emptyEl.setText("No file changes required execution. Vault is fully up to date.");
    } else {
      for (const res of activeResults) {
        this.renderRow(listContainer, res);
      }
    }

    // Close Action
    const actions = contentEl.createDiv({
      attr: { style: "display: flex; justify-content: flex-end; margin-top: 16px;" },
    });

    const closeBtn = actions.createEl("button", { text: "Done" });
    closeBtn.onclick = () => this.close();
  }

  private createBadge(parent: HTMLElement, label: string, count: number, color: string): void {
    const card = parent.createDiv({
      attr: {
        style:
          "padding: 8px 10px; border-radius: 6px; background-color: var(--background-secondary); border: 1px solid var(--background-modifier-border); text-align: center;",
      },
    });

    card.createDiv({
      text: String(count),
      attr: { style: `font-size: 1.2em; font-weight: bold; color: ${count > 0 ? color : "var(--text-muted)"};` },
    });
    card.createDiv({
      text: label,
      attr: { style: "font-size: 0.75em; color: var(--text-muted); margin-top: 2px;" },
    });
  }

  private renderRow(parent: HTMLElement, res: PullFileResult): void {
    const row = parent.createDiv({
      attr: {
        style:
          "padding: 8px 12px; border-bottom: 1px solid var(--background-modifier-border); font-size: 0.85em;",
      },
    });

    const header = row.createDiv({
      attr: { style: "display: flex; justify-content: space-between; align-items: center; gap: 8px;" },
    });

    header.createDiv({
      text: res.path,
      attr: { style: "font-weight: 500; word-break: break-all; color: var(--text-normal);" },
    });

    let badgeColor = "#27ae60";
    if (res.status === "FAILED") badgeColor = "#e74c3c";
    if (res.status === "CONFLICT_PRESERVED") badgeColor = "#e67e22";
    if (res.status === "SKIPPED") badgeColor = "#95a5a6";

    header.createSpan({
      text: res.status,
      attr: {
        style: `padding: 2px 6px; border-radius: 3px; font-size: 0.72em; font-weight: 600; background-color: rgba(0,0,0,0.1); color: ${badgeColor};`,
      },
    });

    if (res.message) {
      row.createDiv({
        text: res.message,
        attr: { style: "font-size: 0.8em; color: var(--text-muted); margin-top: 3px;" },
      });
    }

    if (res.conflictPath) {
      row.createDiv({
        text: `Preserved conflict file: ${res.conflictPath}`,
        attr: { style: "font-size: 0.78em; color: var(--color-orange, #e67e22); font-family: var(--font-monospace); margin-top: 2px;" },
      });
    }
  }
}
