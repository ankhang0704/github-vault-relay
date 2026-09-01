/**
 * GitHub Vault Relay - Conservative GitHub-backed Obsidian Vault Sync Plugin
 * Main Plugin Entry Point
 */

import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, VaultRelaySettings, VaultRelaySettingTab } from "./settings";
import { SyncPreviewModal } from "./ui/syncPreviewModal";
import { PullConfirmModal } from "./ui/pullConfirmModal";
import { GitHubClient } from "./github/githubClient";
import { sanitizeErrorMessage } from "./security/redact";
import { getStoredPat } from "./security/secretStore";

export default class VaultRelayPlugin extends Plugin {
  public settings: VaultRelaySettings = DEFAULT_SETTINGS;

  public async onload(): Promise<void> {
    await this.loadSettings();

    // Register Plugin Settings Tab
    this.addSettingTab(new VaultRelaySettingTab(this.app, this));

    // Register Ribbon Icon to open Sync Preview Modal
    this.addRibbonIcon("git-compare", "GitHub Vault Relay: Preview Sync Status", () => {
      new SyncPreviewModal(this.app, this).open();
    });

    // Register Command: Preview Sync Status (Read-Only)
    this.addCommand({
      id: "github-vault-relay-preview-sync",
      name: "Preview sync status (Read-Only)",
      callback: () => {
        new SyncPreviewModal(this.app, this).open();
      },
    });

    // Register Command: Pull Safe Remote Changes
    this.addCommand({
      id: "github-vault-relay-pull-safe-changes",
      name: "Pull safe remote changes (GitHub -> Local)",
      callback: () => {
        new PullConfirmModal(this.app, this).open();
      },
    });

    // Register Command: Test GitHub Connection
    this.addCommand({
      id: "github-vault-relay-test-connection",
      name: "Test GitHub connection",
      callback: async () => {
        if (!this.settings.owner || !this.settings.repo) {
          new Notice("GitHub Vault Relay: Please configure your repository owner and name in settings.");
          return;
        }

        const notice = new Notice("GitHub Vault Relay: Testing GitHub connection...", 0);
        try {
          const token = await getStoredPat(this.app, this.settings.owner, this.settings.repo);
          if (!token) {
            notice.hide();
            new Notice("GitHub Vault Relay: No PAT found in secure storage. Please save a token in settings.", 6000);
            return;
          }

          const client = new GitHubClient({
            token,
            owner: this.settings.owner,
            repo: this.settings.repo,
            branch: this.settings.branch,
          });
          const result = await client.testConnection();
          notice.hide();

          if (result.success) {
            new Notice(
              `GitHub Vault Relay: Connected to ${result.repoFullName} on branch '${result.targetBranch}' (Read: ${
                result.canPull ? "OK" : "No"
              }, Write: ${result.canPush ? "OK" : "No"})`,
              6000
            );
          } else {
            new Notice(
              `GitHub Vault Relay: Connection failed: ${result.errorMessage || "Unknown error"}`,
              8000
            );
          }
        } catch (err) {
          notice.hide();
          const safe = sanitizeErrorMessage(err);
          new Notice(`GitHub Vault Relay: Connection error: ${safe}`, 8000);
        }
      },
    });
  }

  public onunload(): void {
    // Cleanup
  }

  public async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  public async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
