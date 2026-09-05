/**
 * Safe Push Confirmation Modal for Vault Relay
 *
 * Runs a pre-flight scan and prompts the user for explicit confirmation
 * before uploading and committing local vault files to GitHub.
 */

import { App, Modal, Notice, setIcon } from "obsidian";
import type VaultRelayPlugin from "../main";
import { GitHubClient } from "../github/githubClient";
import { PushEngine } from "../sync/pushEngine";
import { SyncEngine } from "../sync/syncEngine";
import { PushExecutionReport, SyncPreviewReport } from "../sync/syncTypes";
import { getStoredPat } from "../security/secretStore";
import { sanitizeErrorMessage } from "../security/redact";
import { computeSemanticPreview } from "../sync/semanticSummary";
import { PushResultModal } from "./pushResultModal";

export type OnPushCompleteCallback = (report: PushExecutionReport) => Promise<void> | void;

export class PushConfirmModal extends Modal {
  private plugin: VaultRelayPlugin;
  private previewReport: SyncPreviewReport | null = null;
  private isLoading = true;
  private onComplete?: OnPushCompleteCallback;

  constructor(app: App, plugin: VaultRelayPlugin, onComplete?: OnPushCompleteCallback) {
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
      new Notice(`Safe Push preflight error: ${msg}`);
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
      text: "Checking branch HEAD and building Safe Push plan...",
      attr: { style: "color: var(--text-muted); font-size: 0.9em;" },
    });
  }

  private renderError(message: string): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "GitHub Vault Relay - Safe Push" });

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

    contentEl.createEl("h2", { text: "Confirm Safe Push (Local → GitHub)", attr: { style: "margin: 0 0 8px 0;" } });

    // Truncated tree warning
    if (this.previewReport.truncatedRemoteTree) {
      const warnBox = contentEl.createDiv({
        attr: {
          style:
            "padding: 14px 16px; border-radius: 6px; border-left: 4px solid var(--color-red, #e74c3c); background-color: var(--background-secondary); margin-bottom: 16px;",
        },
      });
      warnBox.createEl("strong", {
        text: "🚫 Safe Push Blocked: Truncated Git Tree",
        attr: { style: "color: var(--text-error, #e74c3c);" },
      });
      warnBox.createEl("p", {
        text: "The remote repository tree was truncated by GitHub API (>100,000 items). Safe push cannot proceed to avoid partial synchronization.",
        attr: { style: "margin: 4px 0 0 0; font-size: 0.88em; color: var(--text-muted);" },
      });
      return;
    }

    // Target repo info
    contentEl.createDiv({
      text: `Target: ${this.plugin.settings.owner}/${this.plugin.settings.repo} (branch: ${this.plugin.settings.branch})`,
      attr: { style: "color: var(--text-muted); font-size: 0.88em; margin-bottom: 14px;" },
    });

    // Semantic Summary
    const semantic = computeSemanticPreview(this.previewReport.items);

    // Safety Description Notice
    const notice = contentEl.createDiv({
      attr: {
        style:
          "padding: 10px 14px; border-radius: 4px; background-color: var(--background-secondary); border-left: 4px solid var(--interactive-accent); font-size: 0.88em; margin-bottom: 16px; line-height: 1.4;",
      },
    });
    let noticeText = "Vault Relay will upload your safe local changes (new, updated, and deleted notes) to GitHub in a single atomic commit.";
    if (semantic.pushDeleteRemote > 0) {
      noticeText += " The current GitHub version of deleted files will be removed in the new commit. Previous versions remain available in Git history while repository history remains available.";
    } else {
      noticeText += " Remote modifications and conflicts are never overwritten; optimistic concurrency guards ensure zero force-push.";
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
    list.createEl("div", { text: `• New files to create on GitHub: ${semantic.pushCreate}` });
    list.createEl("div", { text: `• Files to update on GitHub: ${semantic.pushUpdate}` });

    // Explicit Destructive Section
    if (semantic.pushDeleteRemote > 0) {
      const delRow = list.createDiv({
        attr: {
          style:
            "color: var(--color-red, #e74c3c); font-weight: 600; padding: 4px 8px; margin: 4px 0; border-radius: 4px; background-color: rgba(231, 76, 60, 0.1); border-left: 3px solid var(--color-red, #e74c3c);",
        },
      });
      delRow.createDiv({ text: `⚠️ Files to delete from GitHub: ${semantic.pushDeleteRemote}` });
      delRow.createDiv({
        text: "The current GitHub version will be removed in the new commit. Previous versions remain available in Git history while repository history remains available.",
        attr: { style: "font-size: 0.82em; font-weight: normal; color: var(--text-muted); margin-top: 2px;" },
      });
    }

    if (semantic.pushMoves > 0) {
      list.createEl("div", {
        text: `• Moves to commit to GitHub: ${semantic.pushMoves}`,
        attr: { style: "color: var(--color-purple, #9b59b6); font-weight: 500;" },
      });
    }

    if (semantic.deleteConflicts > 0) {
      list.createEl("div", {
        text: `• Delete conflicts (not pushed, require review): ${semantic.deleteConflicts}`,
        attr: { style: "color: var(--color-red, #e74c3c); font-weight: 500;" },
      });
    }

    list.createEl("div", { text: `• Conflicting files (kept untouched / not pushed): ${semantic.contentConflicts}` });
    list.createEl("div", { text: `• Oversized files (>25 MiB, skipped): ${semantic.oversized}` });
    list.createEl("div", { text: `• Remote notes (kept untouched): ${semantic.totalPullMutations}` });
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
      text: "Confirm Safe Push",
      cls: "mod-cta",
      attr: { style: "min-height: 44px; min-width: 44px; padding: 10px 16px;" },
    });
    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Pushing...";
      cancelBtn.disabled = true;

      try {
        const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
        const client = new GitHubClient({
          token: token || "",
          owner: this.plugin.settings.owner,
          repo: this.plugin.settings.repo,
          branch: this.plugin.settings.branch,
        });

        const pushEngine = new PushEngine(this.app, this.plugin.settings, client);
        const report = await pushEngine.executeSafePush();

        this.close();
        new PushResultModal(this.app, report).open();

        if (this.onComplete) {
          try {
            await this.onComplete(report);
          } catch (callbackErr) {
            console.warn("[GitHub Vault Relay] onComplete refresh error after push:", callbackErr);
          }
        }
      } catch (err) {
        new Notice(`Safe Push failed: ${sanitizeErrorMessage(err)}`);
        this.close();
      }
    };
  }
}
