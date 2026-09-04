/**
 * Settings Schema & Settings Tab UI for GitHub Vault Relay
 *
 * Includes C4 Connection Wizard:
 * - Direct token authentication & automatic repository discovery (owner/repo dropdown)
 * - Automatic default branch selection and branch discovery dropdown
 * - Collapsible Advanced/Manual setup fallback
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultRelayPlugin from "./main";
import { GitHubClient, normalizeRepoConfig } from "./github/githubClient";
import { GitHubRepoSummary, GitHubBranchSummary } from "./github/githubTypes";
import { DEFAULT_EXCLUSIONS, parseExclusionRules } from "./sync/pathFilter";
import { sanitizeErrorMessage } from "./security/redact";
import {
  clearStoredPat,
  getActiveStorageBackend,
  getSecretKeyForRepo,
  getStoredPat,
  hasStoredPat,
  setStoredPat,
} from "./security/secretStore";
import { SyncDashboardModal } from "./ui/syncDashboardModal";

export const CURRENT_SETTINGS_VERSION = 2;

export interface VaultRelaySettings {
  owner: string;
  repo: string;
  branch: string;
  excludedPaths: string[];
  secretKey?: string;
  settingsVersion?: number;
}

export const DEFAULT_SETTINGS: VaultRelaySettings = {
  owner: "",
  repo: "",
  branch: "main",
  excludedPaths: [...DEFAULT_EXCLUSIONS],
  settingsVersion: CURRENT_SETTINGS_VERSION,
};

export class VaultRelaySettingTab extends PluginSettingTab {
  private plugin: VaultRelayPlugin;
  private tokenInputVal = "";
  private discoveredRepos: GitHubRepoSummary[] = [];
  private discoveredBranches: GitHubBranchSummary[] = [];
  private isDiscovering = false;
  private showManualSetup = false;

  constructor(app: App, plugin: VaultRelayPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "GitHub Vault Relay Settings" });

    const backend = getActiveStorageBackend(this.app);
    const backendLabel =
      backend === "SECRET_STORAGE"
        ? "Obsidian SecretStorage (Core API)"
        : "Unavailable (SecretStorage Required)";

    // Security & Scope Notice Box
    const noticeBox = containerEl.createDiv({
      cls: "vault-relay-notice-box",
      attr: {
        style:
          "background-color: var(--background-secondary); border-left: 4px solid var(--interactive-accent); padding: 12px 16px; margin-bottom: 20px; border-radius: 4px;",
      },
    });

    noticeBox.createEl("strong", { text: "🔒 Token Security & Storage Guarantee:" });
    const noticeList = noticeBox.createEl("ul", {
      attr: { style: "margin: 6px 0 0 18px; font-size: 0.9em; line-height: 1.5;" },
    });
    noticeList.createEl("li", {
      text: `Tokens are stored exclusively in Obsidian SecretStorage (${backendLabel}) and NEVER written to plugin data.json or localStorage.`,
    });
    noticeList.createEl("li", {
      text: "Requires a GitHub Fine-Grained Personal Access Token scoped strictly to your vault repository (Contents: Read and write).",
    });
    noticeList.createEl("li", {
      text: "Tokens are only ever transmitted directly to https://api.github.com and are automatically redacted from error messages.",
    });

    // Determine current token status
    const tokenExists = await hasStoredPat(
      this.app,
      this.plugin.settings.owner,
      this.plugin.settings.repo
    );
    const keyName = getSecretKeyForRepo(
      this.plugin.settings.owner,
      this.plugin.settings.repo
    );

    // Section 1: GitHub Connection Wizard
    containerEl.createEl("h3", { text: "Connection Wizard", attr: { style: "margin-top: 10px;" } });

    const tokenSetting = new Setting(containerEl)
      .setName("GitHub Fine-Grained PAT")
      .setDesc(
        tokenExists
          ? `Status: Stored securely (${keyName}). Enter a new token below to replace.`
          : "Personal Access Token with Read/Write access to Contents on your vault repository."
      );

    tokenSetting.addText((text) => {
      text.setPlaceholder(tokenExists ? "••••••••••••••••••••" : "github_pat_...");
      text.onChange((value) => {
        this.tokenInputVal = value.trim();
      });
      text.inputEl.type = "password";
      text.inputEl.style.width = "240px";
    });

    tokenSetting.addButton((button) => {
      button.setButtonText("Save & Connect").setCta().onClick(async () => {
        if (!this.tokenInputVal && !tokenExists) {
          new Notice("Please enter a token to connect.");
          return;
        }
        try {
          if (this.tokenInputVal) {
            await setStoredPat(
              this.app,
              this.plugin.settings.owner,
              this.plugin.settings.repo,
              this.tokenInputVal
            );
            this.plugin.settings.secretKey = keyName;
            await this.plugin.saveSettings();
          }
          new Notice("Token saved. Discovering accessible repositories...");
          await this.discoverRepositories();
          this.tokenInputVal = "";
          this.display();
        } catch (err) {
          new Notice(`Connection failed: ${sanitizeErrorMessage(err)}`);
        }
      });
    });

    if (tokenExists) {
      tokenSetting.addButton((button) => {
        button
          .setButtonText("Clear Token")
          .setWarning()
          .onClick(async () => {
            await clearStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
            this.plugin.settings.secretKey = undefined;
            await this.plugin.saveSettings();
            this.discoveredRepos = [];
            this.discoveredBranches = [];
            new Notice("Stored GitHub PAT cleared.");
            this.display();
          });
      });
    }

    // Repository Dropdown (if repos discovered or discovered previously)
    if (this.discoveredRepos.length > 0) {
      const repoSetting = new Setting(containerEl)
        .setName("Select Repository")
        .setDesc("Choose which repository to sync with this vault.");

      repoSetting.addDropdown((dropdown) => {
        const currentFullName = this.plugin.settings.owner && this.plugin.settings.repo
          ? `${this.plugin.settings.owner}/${this.plugin.settings.repo}`
          : "";

        for (const r of this.discoveredRepos) {
          dropdown.addOption(r.fullName, `${r.fullName} ${r.isPrivate ? "🔒" : "🌐"}`);
        }

        if (currentFullName) {
          dropdown.setValue(currentFullName);
        }

        dropdown.onChange(async (val) => {
          const selected = this.discoveredRepos.find((r) => r.fullName === val);
          if (selected) {
            this.plugin.settings.owner = selected.owner;
            this.plugin.settings.repo = selected.name;
            this.plugin.settings.branch = selected.defaultBranch || "main";
            await this.plugin.saveSettings();
            await this.discoverBranches(selected.owner, selected.name);
            this.display();
          }
        });
      });
    }

    // Branch Dropdown (if branches discovered)
    if (this.discoveredBranches.length > 0) {
      const branchSetting = new Setting(containerEl)
        .setName("Select Branch")
        .setDesc("Target Git branch for synchronization.");

      branchSetting.addDropdown((dropdown) => {
        for (const b of this.discoveredBranches) {
          dropdown.addOption(b.name, b.name);
        }
        dropdown.setValue(this.plugin.settings.branch || "main");
        dropdown.onChange(async (val) => {
          this.plugin.settings.branch = val;
          await this.plugin.saveSettings();
        });
      });
    }

    // Section 2: Advanced / Manual Setup (Collapsible)
    const advToggleSetting = new Setting(containerEl)
      .setName("Advanced / Manual Setup")
      .setDesc("Manually configure repository details, custom branches, and exclusion rules.");

    advToggleSetting.addButton((btn) => {
      btn.setButtonText(this.showManualSetup ? "Hide Manual Setup" : "Show Manual Setup");
      btn.onClick(() => {
        this.showManualSetup = !this.showManualSetup;
        this.display();
      });
    });

    if (this.showManualSetup) {
      // Repository Owner Setting
      new Setting(containerEl)
        .setName("Repository Owner")
        .setDesc("GitHub username or organization that owns the repository (e.g. 'octocat').")
        .addText((text) =>
          text
            .setPlaceholder("octocat")
            .setValue(this.plugin.settings.owner)
            .onChange(async (value) => {
              const norm = normalizeRepoConfig(value, this.plugin.settings.repo);
              this.plugin.settings.owner = norm.owner;
              this.plugin.settings.repo = norm.repo;
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
              const norm = normalizeRepoConfig(this.plugin.settings.owner, value);
              this.plugin.settings.owner = norm.owner;
              this.plugin.settings.repo = norm.repo;
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
        .setDesc(
          "Directories or file paths excluded from scanning and syncing (one per line). Trailing slash indicates directory prefix."
        )
        .addTextArea((textArea) => {
          textArea
            .setPlaceholder(".obsidian/\n.git/\n_fit/")
            .setValue(this.plugin.settings.excludedPaths.join("\n"))
            .onChange(async (value) => {
              this.plugin.settings.excludedPaths = parseExclusionRules(value);
              await this.plugin.saveSettings();
            });
          textArea.inputEl.rows = 4;
          textArea.inputEl.style.width = "100%";
        });
    }

    // Section 3: Connection Diagnostics & Sync Actions
    containerEl.createEl("h3", { text: "Diagnostics & Sync", attr: { style: "margin-top: 20px;" } });

    const actionsSetting = new Setting(containerEl)
      .setName("Sync Operations")
      .setDesc("Open the primary sync dashboard or run individual safe pull/push operations.");

    actionsSetting.addButton((button) => {
      button.setButtonText("Open Sync Dashboard").setCta().onClick(() => {
        new SyncDashboardModal(this.app, this.plugin).open();
      });
    });

    actionsSetting.addButton((button) => {
      button.setButtonText("Test Connection").onClick(async () => {
        button.setButtonText("Testing...");
        button.setDisabled(true);

        try {
          const token = await getStoredPat(
            this.app,
            this.plugin.settings.owner,
            this.plugin.settings.repo
          );
          if (!token) {
            new Notice("No Personal Access Token stored for this repository.");
            return;
          }

          const client = new GitHubClient({
            token,
            owner: this.plugin.settings.owner,
            repo: this.plugin.settings.repo,
            branch: this.plugin.settings.branch,
          });

          const res = await client.testConnection();
          if (res.success) {
            new Notice(
              `Connection successful! Connected to ${res.repoFullName} (${res.targetBranch}). Permissions: ${res.canPush ? "Read & Write" : "Read-only"}`
            );
          } else {
            new Notice(`Connection failed: ${res.errorMessage || "Unknown error"}`);
          }
        } catch (err) {
          const safeMsg = sanitizeErrorMessage(err);
          new Notice(`Connection test error: ${safeMsg}`);
        } finally {
          button.setButtonText("Test Connection");
          button.setDisabled(false);
        }
      });
    });
  }

  private async discoverRepositories(): Promise<void> {
    const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
    if (!token) return;

    const client = new GitHubClient({
      token,
      owner: this.plugin.settings.owner || "user",
      repo: this.plugin.settings.repo || "repo",
      branch: this.plugin.settings.branch || "main",
    });

    try {
      this.isDiscovering = true;
      this.discoveredRepos = await client.listUserRepositories(100);
      if (this.discoveredRepos.length > 0 && (!this.plugin.settings.owner || !this.plugin.settings.repo)) {
        const first = this.discoveredRepos[0];
        this.plugin.settings.owner = first.owner;
        this.plugin.settings.repo = first.name;
        this.plugin.settings.branch = first.defaultBranch || "main";
        await this.plugin.saveSettings();
        await this.discoverBranches(first.owner, first.name);
      }
    } catch (err) {
      new Notice(`Failed to discover repositories: ${sanitizeErrorMessage(err)}`);
    } finally {
      this.isDiscovering = false;
    }
  }

  private async discoverBranches(owner: string, repo: string): Promise<void> {
    const token = await getStoredPat(this.app, owner, repo);
    if (!token) return;

    const client = new GitHubClient({ token, owner, repo, branch: this.plugin.settings.branch || "main" });
    try {
      this.discoveredBranches = await client.listBranches(owner, repo);
    } catch {
      this.discoveredBranches = [];
    }
  }
}
