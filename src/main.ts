/**
 * Vault Relay - Conservative GitHub-backed Obsidian Vault Sync Plugin
 * Main Plugin Entry Point
 */

import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, VaultRelaySettings, VaultRelaySettingTab } from "./settings";
import { SyncPreviewModal } from "./ui/syncPreviewModal";
import { GitHubClient } from "./github/githubClient";
import { sanitizeErrorMessage } from "./security/redact";

export default class VaultRelayPlugin extends Plugin {
  public settings: VaultRelaySettings = DEFAULT_SETTINGS;

  public async onload(): Promise<void> {
    await this.loadSettings();

    // Register Plugin Settings Tab
    this.addSettingTab(new VaultRelaySettingTab(this.app, this));

    // Register Ribbon Icon to open Sync Preview Modal
    this.addRibbonIcon("git-compare", "Vault Relay: Preview Sync Status", () => {
      new SyncPreviewModal(this.app, this).open();
    });

    // Register Command: Open Sync Preview Modal
    this.addCommand({
      id: "vault-relay-preview-sync",
      name: "Preview sync status (Read-Only)",
      callback: () => {
        new SyncPreviewModal(this.app, this).open();
      },
    });

    // Register Command: Test GitHub Connection
    this.addCommand({
      id: "vault-relay-test-connection",
      name: "Test GitHub connection",
      callback: async () => {
        if (!this.settings.token || !this.settings.owner || !this.settings.repo) {
          new Notice("Vault Relay: Please configure your GitHub PAT, owner, and repository in settings.");
          return;
        }

        const notice = new Notice("Vault Relay: Testing GitHub connection...", 0);
        try {
          const client = new GitHubClient({
            token: this.settings.token,
            owner: this.settings.owner,
            repo: this.settings.repo,
            branch: this.settings.branch,
          });
          const result = await client.testConnection();
          notice.hide();

          if (result.success) {
            new Notice(
              `Vault Relay: Connected to ${result.repoFullName} on branch '${result.targetBranch}' (Read: ${
                result.canPull ? "OK" : "No"
              }, Write: ${result.canPush ? "OK" : "No"})`,
              6000
            );
          } else {
            new Notice(
              `Vault Relay: Connection failed: ${result.errorMessage || "Unknown error"}`,
              8000
            );
          }
        } catch (err) {
          notice.hide();
          const safe = sanitizeErrorMessage(err, this.settings.token);
          new Notice(`Vault Relay: Connection error: ${safe}`, 8000);
        }
      },
    });
  }

  public onunload(): void {
    // Cleanup resources if needed
  }

  public async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  public async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
