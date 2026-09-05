/**
 * Safe Pull Confirmation Modal for Vault Relay
 *
 * Runs a pre-flight scan and prompts the user for explicit confirmation
 * before downloading and updating local vault files.
 */

import { App, Modal, Notice, setIcon } from "obsidian";
import type VaultRelayPlugin from "../main";
import { GitHubClient } from "../github/githubClient";
import { PullEngine } from "../sync/pullEngine";
import { SyncEngine } from "../sync/syncEngine";
import { PullExecutionReport, SyncPreviewReport } from "../sync/syncTypes";
import { getStoredPat } from "../security/secretStore";
import { sanitizeErrorMessage } from "../security/redact";
import { computeSemanticPreview } from "../sync/semanticSummary";
import { PullResultModal } from "./pullResultModal";

export type OnPullCompleteCallback = (report: PullExecutionReport) => Promise<void> | void;

export class PullConfirmModal extends Modal {
  private plugin: VaultRelayPlugin;
  private previewReport: SyncPreviewReport | null = null;
  private isLoading = true;
  private onComplete?: OnPullCompleteCallback;

  constructor(app: App, plugin: VaultRelayPlugin, onComplete?: OnPullCompleteCallback) {
    super(app);
    this.plugin = plugin;
    this.onComplete = onComplete;
  }

  public onOpen(): void {
    this.modalEl.addClass("vault-relay-modal");
    this.modalEl.addClass("vault-relay-confirm-modal");
    this.modalEl.style.maxWidth = "600px";
    this.modalEl.style.width = "90vw";
    this.runPreflight();
  }

  public onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private async runPreflight(): Promise<void> {
    this.isLoading = true;
    this.renderLoading();

    try {
      const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
      if (!token) {
        this.renderError("No GitHub PAT found in secure storage. Please configure settings first.");
        return;
      }

      const client = new GitHubClient({
        token,
        owner: this.plugin.settings.owner,
        repo: this.plugin.settings.repo,
        branch: this.plugin.settings.branch,
      });

      const engine = new SyncEngine(this.app, this.plugin.settings, client);
      this.previewReport = await engine.generatePreview();
      this.isLoading = false;
      this.renderConfirmation();
    } catch (err) {
      this.isLoading = false;
      const msg = sanitizeErrorMessage(err);
      this.renderError(msg);
      new Notice(`Safe Pull preflight error: ${msg}`);
    }
  }

  private renderLoading(): void {
    const { contentEl } = this;
    contentEl.empty();

    const container = contentEl.createDiv({
      attr: {
        style: "display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 36px 20px;",
      },
    });

    const iconDiv = container.createDiv({ attr: { style: "margin-bottom: 16px;" } });
    setIcon(iconDiv, "refresh-cw");
    iconDiv.style.animation = "spin 1s linear infinite";

    container.createEl("h3", { text: "Scanning Remote & Local State..." });
    container.createEl("p", {
      text: "Checking branch HEAD and building Safe Pull plan...",
      attr: { style: "color: var(--text-muted); font-size: 0.9em;" },
    });
  }

  private renderError(message: string): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "GitHub Vault Relay - Safe Pull" });

    const errBox = contentEl.createDiv({
      attr: {
        style:
          "padding: 16px; border-radius: 6px; border-left: 4px solid var(--color-red, #e74c3c); background-color: var(--background-secondary); margin: 20px 0;",
      },
    });
    errBox.createEl("h4", {
      text: "Preflight Check Failed",
      attr: { style: "margin: 0 0 8px 0; color: var(--text-error, #e74c3c);" },
    });
    errBox.createEl("p", { text: message, attr: { style: "margin: 0; color: var(--text-muted); font-size: 0.95em;" } });

    const actions = contentEl.createDiv({
      attr: { style: "display: flex; justify-content: flex-end; margin-top: 20px;" },
    });
    const closeBtn = actions.createEl("button", { text: "Close" });
    closeBtn.onclick = () => this.close();
  }

  private renderConfirmation(): void {
    if (!this.previewReport) return;
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Confirm Safe Pull (GitHub → Local)", attr: { style: "margin: 0 0 8px 0;" } });

    // Truncated tree warning
    if (this.previewReport.truncatedRemoteTree) {
      const warnBox = contentEl.createDiv({
        attr: {
          style:
            "padding: 14px 16px; border-radius: 6px; border-left: 4px solid var(--color-red, #e74c3c); background-color: var(--background-secondary); margin-bottom: 16px;",
        },
      });
      warnBox.createEl("strong", {
        text: "🚫 Safe Pull Blocked: Truncated Git Tree",
        attr: { style: "color: var(--text-error, #e74c3c);" },
      });
      warnBox.createEl("p", {
        text: "The remote repository tree was truncated by GitHub API (>100,000 items). Safe pull cannot proceed to avoid partial synchronization.",
        attr: { style: "margin: 4px 0 0 0; font-size: 0.88em; color: var(--text-muted);" },
      });
      return;
    }

    // Semantic Summary
    const semantic = computeSemanticPreview(this.previewReport.items);

    // Safety Description Notice
    const notice = contentEl.createDiv({
      attr: {
        style:
          "padding: 10px 14px; border-radius: 4px; background-color: var(--background-secondary); border-left: 4px solid var(--interactive-accent); font-size: 0.88em; margin-bottom: 16px; line-height: 1.4;",
      },
    });
    let noticeText = "Vault Relay will pull new and updated notes from GitHub to your local Obsidian vault. Local modifications are never silently overwritten; conflicting versions are preserved safely in internal conflict storage.";
    if (semantic.pullRemoveLocal > 0) {
      noticeText += " Files to remove locally will be moved to trash according to your Obsidian trash settings.";
    }
    notice.createEl("div", { text: noticeText });

    // Summary of Actions
    const summaryBox = contentEl.createDiv({
      attr: {
        style:
          "border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 12px 16px; background-color: var(--background-secondary-alt, var(--background-secondary)); margin-bottom: 20px;",
      },
    });

    summaryBox.createEl("h4", { text: "Planned Actions Summary", attr: { style: "margin: 0 0 10px 0;" } });

    const list = summaryBox.createEl("div", { attr: { style: "font-size: 0.9em; line-height: 1.6;" } });
    list.createEl("div", { text: `• New files to create locally: ${semantic.pullCreate}` });
    list.createEl("div", { text: `• Files to update locally: ${semantic.pullUpdate}` });

    // Explicit Destructive Section
    if (semantic.pullRemoveLocal > 0) {
      const delRow = list.createDiv({
        attr: {
          style:
            "color: var(--color-red, #e74c3c); font-weight: 600; padding: 4px 8px; margin: 4px 0; border-radius: 4px; background-color: rgba(231, 76, 60, 0.1); border-left: 3px solid var(--color-red, #e74c3c);",
        },
      });
      delRow.createDiv({ text: `⚠️ Files to remove locally: ${semantic.pullRemoveLocal}` });
      delRow.createDiv({
        text: "Files are moved to trash according to your Obsidian trash settings.",
        attr: { style: "font-size: 0.82em; font-weight: normal; color: var(--text-muted); margin-top: 2px;" },
      });
    }

    if (semantic.pullMoves > 0) {
      list.createEl("div", {
        text: `• Moves to apply locally: ${semantic.pullMoves}`,
        attr: { style: "color: var(--color-purple, #9b59b6); font-weight: 500;" },
      });
    }

    if (semantic.deleteConflicts > 0) {
      list.createEl("div", {
        text: `• Delete conflicts (require review): ${semantic.deleteConflicts}`,
        attr: { style: "color: var(--color-red, #e74c3c); font-weight: 500;" },
      });
    }

    list.createEl("div", { text: `• Potential conflicts (preserved to internal conflict storage): ${semantic.contentConflicts}` });
    list.createEl("div", { text: `• Oversized files (>25 MiB, skipped): ${semantic.oversized}` });
    list.createEl("div", { text: `• Local changes / notes kept untouched: ${semantic.totalPushMutations}` });
    list.createEl("div", { text: `• Unchanged files: ${semantic.unchanged}` });

    // Action Buttons
    const actions = contentEl.createDiv({
      cls: "vault-relay-action-row",
      attr: { style: "display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap;" },
    });

    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      attr: { style: "min-height: 44px; min-width: 44px; padding: 10px 16px;" },
    });
    cancelBtn.onclick = () => this.close();

    const confirmBtn = actions.createEl("button", {
      text: "Confirm Safe Pull",
      cls: "mod-cta",
      attr: { style: "min-height: 44px; min-width: 44px; padding: 10px 16px;" },
    });
    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Pulling...";
      cancelBtn.disabled = true;

      try {
        const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
        const client = new GitHubClient({
          token: token || "",
          owner: this.plugin.settings.owner,
          repo: this.plugin.settings.repo,
          branch: this.plugin.settings.branch,
        });

        const pullEngine = new PullEngine(this.app, this.plugin.settings, client);
        const report = await pullEngine.executeSafePull();

        this.close();
        new PullResultModal(this.app, report).open();
        if (this.onComplete) {
          try {
            await this.onComplete(report);
          } catch (callbackErr) {
            console.warn("[GitHub Vault Relay] onComplete refresh error:", callbackErr);
          }
        }
      } catch (err) {
        new Notice(`Safe Pull failed: ${sanitizeErrorMessage(err)}`);
        this.close();
      }
    };
  }
}
