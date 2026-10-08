/**
 * Unified Safe Sync Confirmation Modal for Vault Relay
 *
 * Consolidates Safe Pull and Safe Push preflight scan and confirmation prompts.
 */

import { App, Modal, Notice, setIcon } from "obsidian";
import type VaultRelayPlugin from "../main";
import { GitHubClient } from "../github/githubClient";
import { PullEngine } from "../sync/pullEngine";
import { PushEngine } from "../sync/pushEngine";
import { SyncEngine } from "../sync/syncEngine";
import {
  PullExecutionReport,
  PushExecutionReport,
  SyncPreviewReport,
} from "../sync/syncTypes";
import { getStoredPat } from "../security/secretStore";
import { sanitizeErrorMessage } from "../security/redact";
import { computeSemanticPreview } from "../sync/semanticSummary";
import { SyncResultModal } from "./syncResultModal";

export type SyncDirection = "pull" | "push";

export type OnSyncCompleteCallback = (
  report: PullExecutionReport | PushExecutionReport
) => Promise<void> | void;

export class SyncConfirmModal extends Modal {
  private plugin: VaultRelayPlugin;
  private direction: SyncDirection;
  private previewReport: SyncPreviewReport | null = null;
  private isLoading = true;
  private onComplete?: OnSyncCompleteCallback;

  constructor(
    app: App,
    plugin: VaultRelayPlugin,
    direction: SyncDirection,
    onComplete?: OnSyncCompleteCallback
  ) {
    super(app);
    this.plugin = plugin;
    this.direction = direction;
    this.onComplete = onComplete;
  }

  public onOpen(): void {
    this.modalEl.addClass("vault-relay-modal");
    this.modalEl.addClass("vault-relay-confirm-modal");
    void this.runPreflight().catch((err) => {
      this.renderError(sanitizeErrorMessage(err));
    });
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
      const label = this.direction === "pull" ? "Safe Pull" : "Safe Push";
      new Notice(`${label} preflight error: ${msg}`);
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

    const isPull = this.direction === "pull";
    container.createEl("h3", { text: isPull ? "Scanning remote & local state..." : "Scanning Remote & Local State..." });
    container.createEl("p", {
      text: isPull
        ? "Checking branch head and building safe pull plan..."
        : "Checking branch HEAD and building Safe Push plan...",
      cls: "vault-relay-loading-subtitle",
    });
  }

  private renderError(message: string): void {
    const { contentEl } = this;
    contentEl.empty();

    const title = this.direction === "pull" ? "GitHub vault relay - safe pull" : "GitHub Vault Relay - Safe Push";
    contentEl.createEl("h2", { text: title });

    const errBox = contentEl.createDiv({
      cls: "vault-relay-error-box",
    });
    errBox.createEl("h4", {
      text: this.direction === "pull" ? "Preflight check failed" : "Preflight Check Failed",
      cls: "vault-relay-error-title",
    });
    errBox.createEl("p", { text: message, cls: "vault-relay-error-desc" });

    const actions = contentEl.createDiv({
      cls: "vault-relay-action-row",
    });
    const closeBtn = actions.createEl("button", {
      text: "Close",
      cls: "vault-relay-btn-lg",
    });
    closeBtn.onclick = () => this.close();
  }

  private renderConfirmation(): void {
    if (!this.previewReport) return;
    const { contentEl } = this;
    contentEl.empty();

    const isPull = this.direction === "pull";
    const headerTitle = isPull ? "Confirm safe pull (GitHub → local)" : "Confirm Safe Push (Local → GitHub)";
    contentEl.createEl("h2", { text: headerTitle, cls: "vault-relay-dashboard-title" });

    // Truncated tree warning
    if (this.previewReport.truncatedRemoteTree) {
      const warnBox = contentEl.createDiv({
        cls: "vault-relay-warning-box",
      });
      warnBox.createEl("strong", {
        text: isPull ? "🚫 Safe pull blocked: Truncated Git tree" : "🚫 Safe Push Blocked: Truncated Git Tree",
        cls: "vault-relay-warning-title",
      });
      warnBox.createEl("p", {
        text: `The remote repository tree was truncated by GitHub API (>100,000 items). Safe ${isPull ? "pull" : "push"} cannot proceed to avoid partial synchronization.`,
        cls: "vault-relay-warning-desc",
      });
      return;
    }

    if (!isPull) {
      // Target repo info for Push
      contentEl.createDiv({
        text: `Target: ${this.plugin.settings.owner}/${this.plugin.settings.repo} (branch: ${this.plugin.settings.branch})`,
        cls: "vault-relay-repo-info",
      });
    }

    // Semantic Summary
    const semantic = computeSemanticPreview(this.previewReport.items);

    // Safety Description Notice
    const notice = contentEl.createDiv({
      cls: "vault-relay-notice-box",
    });

    let noticeText = "";
    if (isPull) {
      noticeText = "Vault Relay will pull new and updated notes from GitHub to your local Obsidian vault. Local modifications are never silently overwritten; conflicting versions are preserved safely in internal conflict storage.";
      if (semantic.pullRemoveLocal > 0) {
        noticeText += " Files to remove locally will be moved to trash according to your Obsidian trash settings.";
      }
    } else {
      noticeText = "Vault Relay will upload your safe local changes (new, updated, and deleted notes) to GitHub in a single atomic commit.";
      if (semantic.pushDeleteRemote > 0) {
        noticeText += " The current GitHub version of deleted files will be removed in the new commit. Previous versions remain available in Git history while repository history remains available.";
      } else {
        noticeText += " Remote modifications and conflicts are never overwritten; optimistic concurrency guards ensure zero force-push.";
      }
    }
    notice.createDiv({ text: noticeText });

    // Summary of Actions
    const summaryBox = contentEl.createDiv({
      cls: "vault-relay-actions-box",
    });

    summaryBox.createEl("h4", {
      text: isPull ? "Planned actions summary" : "Planned Actions Summary",
      cls: "vault-relay-box-title",
    });

    const list = summaryBox.createDiv({ cls: "vault-relay-actions-list" });

    if (isPull) {
      list.createDiv({ text: `• New files to create locally: ${semantic.pullCreate}` });
      list.createDiv({ text: `• Files to update locally: ${semantic.pullUpdate}` });

      if (semantic.pullRemoveLocal > 0) {
        const delRow = list.createDiv({
          cls: "vault-relay-destructive-alert-row",
        });
        delRow.createDiv({ text: `⚠️ Files to remove locally: ${semantic.pullRemoveLocal}` });
        delRow.createDiv({
          text: "Files are moved to trash according to your Obsidian trash settings.",
          cls: "vault-relay-destructive-alert-subtext",
        });
      }

      if (semantic.pullMoves > 0) {
        list.createDiv({
          text: `• Moves to apply locally: ${semantic.pullMoves}`,
          cls: "vault-relay-move-highlight",
        });
      }

      if (semantic.deleteConflicts > 0) {
        list.createDiv({
          text: `• Delete conflicts (require review): ${semantic.deleteConflicts}`,
          cls: "vault-relay-conflict-alert",
        });
      }

      list.createDiv({ text: `• Potential conflicts (preserved to internal conflict storage): ${semantic.contentConflicts}` });
      list.createDiv({ text: `• Oversized files (>25 MiB, skipped): ${semantic.oversized}` });
      list.createDiv({ text: `• Local changes / notes kept untouched: ${semantic.totalPushMutations}` });
      list.createDiv({ text: `• Unchanged files: ${semantic.unchanged}` });
    } else {
      list.createDiv({ text: `• New files to create on GitHub: ${semantic.pushCreate}` });
      list.createDiv({ text: `• Files to update on GitHub: ${semantic.pushUpdate}` });

      if (semantic.pushDeleteRemote > 0) {
        const delRow = list.createDiv({
          cls: "vault-relay-destructive-alert-row",
        });
        delRow.createDiv({ text: `⚠️ Files to delete from GitHub: ${semantic.pushDeleteRemote}` });
        delRow.createDiv({
          text: "The current GitHub version will be removed in the new commit. Previous versions remain available in Git history while repository history remains available.",
          cls: "vault-relay-destructive-alert-subtext",
        });
      }

      if (semantic.pushMoves > 0) {
        list.createDiv({
          text: `• Moves to commit to GitHub: ${semantic.pushMoves}`,
          cls: "vault-relay-move-highlight",
        });
      }

      if (semantic.deleteConflicts > 0) {
        list.createDiv({
          text: `• Delete conflicts (not pushed, require review): ${semantic.deleteConflicts}`,
          cls: "vault-relay-conflict-alert",
        });
      }

      list.createDiv({ text: `• Conflicting files (kept untouched / not pushed): ${semantic.contentConflicts}` });
      list.createDiv({ text: `• Oversized files (>25 MiB, skipped): ${semantic.oversized}` });
      list.createDiv({ text: `• Remote notes (kept untouched): ${semantic.totalPullMutations}` });
      list.createDiv({ text: `• Unchanged files: ${semantic.unchanged}` });
    }

    // Action Buttons
    const actions = contentEl.createDiv({
      cls: "vault-relay-action-row",
    });

    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      cls: "vault-relay-btn-lg",
    });
    cancelBtn.onclick = () => this.close();

    const confirmBtn = actions.createEl("button", {
      text: isPull ? "Confirm Safe Pull" : "Confirm Safe Push",
      cls: "mod-cta vault-relay-btn-lg",
    });

    confirmBtn.onclick = () => {
      void (async () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = isPull ? "Pulling..." : "Pushing...";
        cancelBtn.disabled = true;

        try {
          const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
          const client = new GitHubClient({
            token: token || "",
            owner: this.plugin.settings.owner,
            repo: this.plugin.settings.repo,
            branch: this.plugin.settings.branch,
          });

          if (isPull) {
            const pullEngine = new PullEngine(this.app, this.plugin.settings, client);
            const report = await pullEngine.executeSafePull();

            this.close();
            new SyncResultModal(this.app, report, "pull").open();
            if (this.onComplete) {
              try {
                await this.onComplete(report);
              } catch (callbackErr) {
                console.warn("[GitHub Vault Relay] onComplete refresh error:", sanitizeErrorMessage(callbackErr));
              }
            }
          } else {
            const pushEngine = new PushEngine(this.app, this.plugin.settings, client);
            const report = await pushEngine.executeSafePush();

            this.close();
            new SyncResultModal(this.app, report, "push").open();
            if (this.onComplete) {
              try {
                await this.onComplete(report);
              } catch (callbackErr) {
                console.warn("[GitHub Vault Relay] onComplete refresh error after push:", sanitizeErrorMessage(callbackErr));
              }
            }
          }
        } catch (err) {
          new Notice(`Safe ${isPull ? "Pull" : "Push"} failed: ${sanitizeErrorMessage(err)}`);
          this.close();
        }
      })();
    };
  }
}
