/**
 * Settings Schema & Settings Tab UI for Vault Relay
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultRelayPlugin from "./main";
import { GitHubClient } from "./github/githubClient";
import { DEFAULT_EXCLUSIONS, parseExclusionRules } from "./sync/pathFilter";
import { redactTokens, sanitizeErrorMessage } from "./security/redact";
import { SyncPreviewModal } from "./ui/syncPreviewModal";

export interface VaultRelaySettings {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  excludedPaths: string[];
}

export const DEFAULT_SETTINGS: VaultRelaySettings = {
  token: "",
  owner: "",
  repo: "",
  branch: "main",
  excludedPaths: [...DEFAULT_EXCLUSIONS],
};

export class VaultRelaySettingTab extends PluginSettingTab {
  private plugin: VaultRelayPlugin;

  constructor(app: App, plugin: VaultRelayPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Relay Settings" });

    // Security & Scope Notice Box
    const noticeBox = containerEl.createDiv({
      cls: "vault-relay-notice-box",
      attr: {
        style:
          "background-color: var(--background-secondary); border-left: 4px solid var(--interactive-accent); padding: 12px 16px; margin-bottom: 20px; border-radius: 4px;",
      },
    });

    noticeBox.createEl("strong", { text: "🔒 Token Security & Scopes Notice:" });
    const noticeList = noticeBox.createEl("ul", {
      attr: { style: "margin: 6px 0 0 18px; font-size: 0.9em; line-height: 1.5;" },
    });
    noticeList.createEl("li", {
      text: "Use a GitHub Fine-Grained Personal Access Token scoped strictly to your vault repository.",
    });
    noticeList.createEl("li", {
      text: "Required Permissions: 'Contents' with Read and Write access.",
    });
    noticeList.createEl("li", {
      text: "Tokens are saved locally in Obsidian's plugin storage (saveData). Settings are never committed or synced to GitHub.",
    });
    noticeList.createEl("li", {
      text: "Tokens are only ever transmitted directly to https://api.github.com and are automatically redacted from error messages.",
    });

    // GitHub PAT Setting
    new Setting(containerEl)
      .setName("GitHub Fine-Grained PAT")
      .setDesc("Personal Access Token with Read/Write access to Contents on your vault repository.")
      .addText((text) => {
        text
          .setPlaceholder("github_pat_...")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
        text.inputEl.style.width = "280px";
      });

    // Repository Owner Setting
    new Setting(containerEl)
      .setName("Repository Owner")
      .setDesc("GitHub username or organization that owns the repository (e.g. 'octocat').")
      .addText((text) =>
        text
          .setPlaceholder("octocat")
          .setValue(this.plugin.settings.owner)
          .onChange(async (value) => {
            this.plugin.settings.owner = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Repository Name Setting
    new Setting(containerEl)
      .setName("Repository Name")
      .setDesc("Name of the GitHub repository (e.g. 'my-notes').")
      .addText((text) =>
        text
          .setPlaceholder("my-notes")
          .setValue(this.plugin.settings.repo)
          .onChange(async (value) => {
            this.plugin.settings.repo = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Branch Setting
    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Target Git branch (default: 'main').")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.branch || "main")
          .onChange(async (value) => {
            this.plugin.settings.branch = value.trim() || "main";
            await this.plugin.saveSettings();
          })
      );

    // Excluded Paths Setting
    new Setting(containerEl)
      .setName("Excluded Paths")
      .setDesc("Directories or file paths excluded from scanning and syncing (one per line). Trailing slash indicates directory prefix.")
      .addTextArea((textArea) => {
        textArea
          .setPlaceholder(".obsidian/\n.git/\n_fit/\n_vault-relay/")
          .setValue(this.plugin.settings.excludedPaths.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludedPaths = parseExclusionRules(value);
            await this.plugin.saveSettings();
          });
        textArea.inputEl.rows = 5;
        textArea.inputEl.style.width = "280px";
        textArea.inputEl.style.fontFamily = "var(--font-monospace)";
      });

    // Test Connection Section
    containerEl.createEl("h3", { text: "Connection & Verification" });

    const statusContainer = containerEl.createDiv({
      cls: "vault-relay-test-status",
      attr: { style: "margin: 10px 0;" },
    });

    new Setting(containerEl)
      .setName("Test GitHub Connection")
      .setDesc("Verify credentials, repository access, and branch HEAD commit via GitHub REST API.")
      .addButton((button) => {
        button
          .setButtonText("Test Connection")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Testing...");
            statusContainer.empty();

            const statusBanner = statusContainer.createDiv({
              attr: {
                style:
                  "padding: 10px 14px; border-radius: 4px; background-color: var(--background-secondary); font-size: 0.9em;",
              },
            });
            statusBanner.setText("Connecting to api.github.com...");

            try {
              const client = new GitHubClient({
                token: this.plugin.settings.token,
                owner: this.plugin.settings.owner,
                repo: this.plugin.settings.repo,
                branch: this.plugin.settings.branch,
              });

              const result = await client.testConnection();

              statusContainer.empty();
              const resultBox = statusContainer.createDiv({
                attr: {
                  style: `padding: 12px 16px; border-radius: 4px; border-left: 4px solid ${
                    result.success ? "var(--color-green, #2ecc71)" : "var(--color-red, #e74c3c)"
                  }; background-color: var(--background-secondary); font-size: 0.9em;`,
                },
              });

              if (result.success) {
                resultBox.createEl("div", {
                  text: `✅ Connected successfully to ${result.repoFullName} (${result.isPrivate ? "Private" : "Public"})`,
                  attr: { style: "font-weight: bold; margin-bottom: 4px; color: var(--text-normal);" },
                });
                const details = resultBox.createEl("div", {
                  attr: { style: "color: var(--text-muted); line-height: 1.4;" },
                });
                details.createEl("div", { text: `• Branch: ${result.targetBranch}` });
                if (result.targetBranchSha) {
                  details.createEl("div", { text: `• Branch HEAD SHA: ${result.targetBranchSha.substring(0, 7)}` });
                }
                details.createEl("div", {
                  text: `• Permissions: Read: ${result.canPull ? "Yes" : "No"}, Write: ${result.canPush ? "Yes" : "No"}`,
                });
              } else {
                resultBox.createEl("div", {
                  text: "❌ Connection Test Failed",
                  attr: { style: "font-weight: bold; margin-bottom: 4px; color: var(--text-error, #e74c3c);" },
                });
                resultBox.createEl("div", {
                  text: redactTokens(result.errorMessage || "Unknown error connecting to GitHub.", this.plugin.settings.token),
                  attr: { style: "color: var(--text-muted);" },
                });
              }
            } catch (err) {
              statusContainer.empty();
              const errBox = statusContainer.createDiv({
                attr: {
                  style:
                    "padding: 12px 16px; border-radius: 4px; border-left: 4px solid var(--color-red, #e74c3c); background-color: var(--background-secondary); font-size: 0.9em;",
                },
              });
              errBox.createEl("div", {
                text: "❌ Unexpected Error",
                attr: { style: "font-weight: bold; margin-bottom: 4px; color: var(--text-error, #e74c3c);" },
              });
              errBox.createEl("div", {
                text: sanitizeErrorMessage(err, this.plugin.settings.token),
                attr: { style: "color: var(--text-muted);" },
              });
            } finally {
              button.setDisabled(false);
              button.setButtonText("Test Connection");
            }
          });
      });

    // Sync Preview Section
    new Setting(containerEl)
      .setName("Sync Preview (Read-Only)")
      .setDesc("Inspect local vault files vs remote GitHub Git tree without modifying or uploading any files.")
      .addButton((button) => {
        button.setButtonText("Open Sync Preview").onClick(() => {
          new SyncPreviewModal(this.app, this.plugin).open();
        });
      });
  }
}
