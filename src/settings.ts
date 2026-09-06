/**
 * Settings Schema & Settings Tab UI for GitHub Vault Relay
 *
 * Includes C4 Connection Wizard:
 * - Direct token authentication & automatic repository discovery (owner/repo dropdown)
 * - Automatic default branch selection and branch discovery dropdown
 * - Collapsible Advanced/Manual setup fallback
 */

import {
  App,
  ButtonComponent,
  Notice,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
} from "obsidian";
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
  hasStoredPatSync,
  setStoredPat,
} from "./security/secretStore";
import { SyncDashboardModal } from "./ui/syncDashboardModal";
import { ClearTokenConfirmModal } from "./ui/clearTokenConfirmModal";

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
  private tokenExists = false;
  private isCheckingToken = false;
  private repositoryLoadState: "TOKEN_MISSING" | "LOADING" | "LOADED" | "EMPTY" | "ERROR" = "TOKEN_MISSING";
  private repositoryLoadError = "";

  constructor(app: App, plugin: VaultRelayPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.tokenExists = hasStoredPatSync(app) ?? !!this.plugin.settings.secretKey;
    void this.refreshTokenStatus();
  }

  /**
   * Declarative settings definition for Obsidian >= 1.13.0.
   * Performs ZERO I/O in definitions and enables global settings search indexing.
   */
  public override getSettingDefinitions(): SettingDefinitionItem[] {
    const keyName = getSecretKeyForRepo(
      this.plugin.settings.owner,
      this.plugin.settings.repo
    );

    return [
      {
        type: "group",
        heading: "Connection Wizard",
        items: [
          {
            name: "GitHub Fine-Grained PAT",
            desc: this.tokenExists
              ? `Status: Stored securely (${keyName}). Enter a new token to replace.`
              : "Personal Access Token with Read/Write access to Contents on your vault repository.",
            render: (setting: Setting) => {
              setting.addText((text) => {
                text.setPlaceholder(this.tokenExists ? "••••••••••••••••••••" : "github_pat_...");
                text.onChange((value) => {
                  this.tokenInputVal = value.trim();
                });
                text.inputEl.type = "password";
                text.inputEl.addClass("vault-relay-token-input");
              });
              setting.addButton((button) => {
                button
                  .setButtonText("Save & Connect")
                  .setCta()
                  .onClick(() => {
                    void this.handleSaveAndConnect(button);
                  });
                button.buttonEl.addClass("vault-relay-btn-lg");
              });
            },
          },
          {
            name: "Repository",
            desc: "Select a repository discovered from your GitHub account, or use the saved value as a manual fallback.",
            render: (setting: Setting) => {
              const currentFullName = this.plugin.settings.owner && this.plugin.settings.repo
                ? `${this.plugin.settings.owner}/${this.plugin.settings.repo}`
                : "";
              const statusText = this.repositoryLoadState === "LOADING"
                ? "Loading repositories..."
                : this.repositoryLoadState === "ERROR"
                  ? `Repository discovery failed${this.repositoryLoadError ? `: ${this.repositoryLoadError}` : "."}`
                  : this.repositoryLoadState === "EMPTY"
                    ? "No accessible repositories were returned."
                    : this.repositoryLoadState === "TOKEN_MISSING"
                      ? "Save a token to load repositories."
                      : "Choose a repository.";

              setting.setDesc(statusText);
              setting.addDropdown((dropdown) => {
                if (currentFullName && !this.discoveredRepos.some((repo) => repo.fullName === currentFullName)) {
                  dropdown.addOption(currentFullName, `${currentFullName} (saved)`);
                }
                for (const repo of this.discoveredRepos) {
                  dropdown.addOption(repo.fullName, `${repo.fullName} ${repo.isPrivate ? "🔒" : "🌐"}`);
                }
                if (this.discoveredRepos.length === 0 && !currentFullName) {
                  dropdown.addOption("__no_repository__", statusText);
                }
                if (currentFullName) dropdown.setValue(currentFullName);
                else if (this.discoveredRepos.length > 0) dropdown.setValue(this.discoveredRepos[0].fullName);
                else dropdown.setValue("__no_repository__");
                dropdown.setDisabled(this.repositoryLoadState !== "LOADED" && this.discoveredRepos.length === 0 && !currentFullName);
                dropdown.onChange((value) => {
                  const selected = this.discoveredRepos.find((repo) => repo.fullName === value);
                  if (!selected) return;
                  void (async () => {
                    this.plugin.settings.owner = selected.owner;
                    this.plugin.settings.repo = selected.name;
                    this.plugin.settings.branch = selected.defaultBranch || "main";
                    await this.plugin.saveSettings();
                    await this.discoverBranches(selected.owner, selected.name);
                    this.refreshTab();
                  })().catch((err) => {
                    new Notice(`Failed to save repository selection: ${sanitizeErrorMessage(err)}`);
                  });
                });
              });
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Advanced / Security",
        items: [
          {
            name: "Advanced Settings",
            desc: "Show branch, manual repository, credential, and exclusion controls.",
            render: (setting: Setting) => {
              setting.addButton((button) => {
                button
                  .setButtonText(this.showManualSetup ? "Collapse Advanced Settings" : "Expand Advanced Settings")
                  .onClick(() => {
                    this.showManualSetup = !this.showManualSetup;
                    this.refreshTab();
                  });
                button.buttonEl.addClass("vault-relay-btn-lg");
              });
            },
          },
          {
            name: "Repository Owner",
            desc: "GitHub username or organization that owns the repository (e.g. 'octocat').",
            visible: () => this.showManualSetup,
            control: {
              type: "text",
              key: "owner",
              placeholder: "octocat",
            },
          },
          {
            name: "Repository Name",
            desc: "Name of the GitHub repository (e.g. 'my-notes').",
            visible: () => this.showManualSetup,
            control: {
              type: "text",
              key: "repo",
              placeholder: "my-notes",
            },
          },
          {
            name: "Branch",
            desc: "Target Git branch (default: 'main').",
            visible: () => this.showManualSetup,
            render: (setting: Setting) => {
              setting.addDropdown((dropdown) => {
                if (this.discoveredBranches.length > 0) {
                  for (const branch of this.discoveredBranches) dropdown.addOption(branch.name, branch.name);
                } else {
                  dropdown.addOption(this.plugin.settings.branch || "main", this.plugin.settings.branch || "main");
                }
                dropdown.setValue(this.plugin.settings.branch || "main");
                dropdown.onChange((value) => {
                  this.plugin.settings.branch = value.trim() || "main";
                  void this.plugin.saveSettings();
                });
              });
            },
          },
          {
            name: "Excluded Paths",
            desc: "Directories or file paths excluded from scanning and syncing (one per line).",
            visible: () => this.showManualSetup,
            render: (setting: Setting) => {
              setting.addTextArea((textArea) => {
                textArea
                  .setPlaceholder(`${this.app.vault.configDir}/\n.git/\n_fit/`)
                  .setValue(this.plugin.settings.excludedPaths.join("\n"))
                  .onChange((value) => {
                    this.plugin.settings.excludedPaths = parseExclusionRules(value, this.app.vault.configDir);
                    void this.plugin.saveSettings().catch((err) => {
                      console.warn("[GitHub Vault Relay] Failed to save settings:", sanitizeErrorMessage(err));
                    });
                  });
                textArea.inputEl.rows = 4;
                textArea.inputEl.addClass("vault-relay-textarea");
              });
            },
          },
          {
            name: "Stored Credential",
            desc: this.tokenExists
              ? `Active in Obsidian SecretStorage (${keyName}).`
              : "No token currently stored in SecretStorage.",
            render: (setting: Setting) => {
              if (this.tokenExists) {
                setting.addButton((button) => {
                  button.setButtonText("Clear Token");
                  const btn = button as unknown as Record<string, (() => ButtonComponent) | undefined>;
                  if (typeof btn["setDestructive"] === "function") {
                    btn["setDestructive"]();
                  } else {
                    button.buttonEl.addClass("mod-warning");
                  }
                  button.onClick(() => {
                    this.handleClearToken();
                  });
                  button.buttonEl.addClass("vault-relay-btn-lg");
                });
              }
            },
            visible: () => this.showManualSetup,
          },
        ],
      },
      {
        type: "group",
        heading: "Diagnostics & Sync",
        items: [
          {
            name: "Sync Operations",
            desc: "Open the primary sync dashboard or run individual safe pull/push operations.",
            render: (setting: Setting) => {
              setting.addButton((button) => {
                button
                  .setButtonText("Open Sync Dashboard")
                  .setCta()
                  .onClick(() => {
                    new SyncDashboardModal(this.app, this.plugin).open();
                  });
                button.buttonEl.addClass("vault-relay-btn-lg");
              });
              setting.addButton((button) => {
                button
                  .setButtonText("Test Connection")
                  .onClick(() => {
                    void this.handleTestConnection(button);
                  });
                button.buttonEl.addClass("vault-relay-btn-lg");
              });
            },
          },
        ],
      },
    ];
  }

  public override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "owner" && typeof value === "string") {
      const norm = normalizeRepoConfig(value, this.plugin.settings.repo);
      this.plugin.settings.owner = norm.owner;
      this.plugin.settings.repo = norm.repo;
      await this.plugin.saveSettings();
      return;
    }
    if (key === "repo" && typeof value === "string") {
      const norm = normalizeRepoConfig(this.plugin.settings.owner, value);
      this.plugin.settings.owner = norm.owner;
      this.plugin.settings.repo = norm.repo;
      await this.plugin.saveSettings();
      return;
    }
    if (key === "branch" && typeof value === "string") {
      this.plugin.settings.branch = value.trim() || "main";
      await this.plugin.saveSettings();
      return;
    }
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
  }

  public override getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /**
   * Imperative display() method for Obsidian < 1.13.0 and backward compatibility.
   * Pure synchronous method conforming strictly to PluginSettingTab.display(): void.
   */
  public override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("vault-relay-settings");

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

    const syncToken = hasStoredPatSync(this.app);
    if (syncToken !== undefined) {
      this.tokenExists = syncToken;
    } else if (this.plugin.settings.secretKey) {
      this.tokenExists = true;
    }
    const tokenExists = this.tokenExists;
    const keyName = getSecretKeyForRepo(
      this.plugin.settings.owner,
      this.plugin.settings.repo
    );

    // Section 1: GitHub Connection Wizard (Primary Connection Flow: ONE primary CTA only)
    new Setting(containerEl).setName("Connection Wizard").setHeading();

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
      text.inputEl.addClass("vault-relay-token-input");
    });

    tokenSetting.addButton((button) => {
      button
        .setButtonText("Save & Connect")
        .setCta()
        .onClick(() => {
          void this.handleSaveAndConnect(button);
        });
      button.buttonEl.addClass("vault-relay-btn-lg");
    });

    // Repository Dropdown (if repos discovered or discovered previously)
    if (this.discoveredRepos.length > 0) {
      const repoSetting = new Setting(containerEl)
        .setName("Select Repository")
        .setDesc("Choose which repository to sync with this vault.");

      repoSetting.addDropdown((dropdown) => {
        const currentFullName =
          this.plugin.settings.owner && this.plugin.settings.repo
            ? `${this.plugin.settings.owner}/${this.plugin.settings.repo}`
            : "";

        for (const r of this.discoveredRepos) {
          dropdown.addOption(r.fullName, `${r.fullName} ${r.isPrivate ? "🔒" : "🌐"}`);
        }

        if (currentFullName) {
          dropdown.setValue(currentFullName);
        }

        dropdown.onChange((val) => {
          void (async () => {
            const selected = this.discoveredRepos.find((r) => r.fullName === val);
            if (selected) {
              this.plugin.settings.owner = selected.owner;
              this.plugin.settings.repo = selected.name;
              this.plugin.settings.branch = selected.defaultBranch || "main";
              await this.plugin.saveSettings();
              await this.discoverBranches(selected.owner, selected.name);
              this.refreshTab();
            }
          })();
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
        dropdown.onChange((val) => {
          void (async () => {
            this.plugin.settings.branch = val;
            await this.plugin.saveSettings();
          })();
        });
      });
    }

    // Section 2: Advanced / Security
    new Setting(containerEl).setName("Advanced / Security").setHeading();

    // Stored Credential Setting (Clear Token moved out of primary flow into Advanced / Security)
    const credSetting = new Setting(containerEl)
      .setName("Stored Credential")
      .setDesc(
        tokenExists
          ? `Active in Obsidian SecretStorage (${keyName}).`
          : "No token currently stored in SecretStorage."
      );

    if (tokenExists) {
      credSetting.addButton((button) => {
        button.setButtonText("Clear Token");
        const btn = button as unknown as Record<string, (() => ButtonComponent) | undefined>;
        if (typeof btn["setDestructive"] === "function") {
          btn["setDestructive"]();
        } else {
          button.buttonEl.addClass("mod-warning");
        }
        button.onClick(() => {
          this.handleClearToken();
        });
        button.buttonEl.addClass("vault-relay-btn-lg");
      });
    }

    // Manual Repository Configuration (Collapsible)
    const advToggleSetting = new Setting(containerEl)
      .setName("Manual Configuration")
      .setDesc("Manually configure repository details, custom branches, and exclusion rules.");

    advToggleSetting.addButton((btn) => {
      btn.setButtonText(this.showManualSetup ? "Hide Manual Setup" : "Show Manual Setup");
      btn.buttonEl.addClass("vault-relay-btn-lg");
      btn.onClick(() => {
        this.showManualSetup = !this.showManualSetup;
        this.refreshTab();
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
            .onChange((value) => {
              void (async () => {
                const norm = normalizeRepoConfig(value, this.plugin.settings.repo);
                this.plugin.settings.owner = norm.owner;
                this.plugin.settings.repo = norm.repo;
                await this.plugin.saveSettings();
              })();
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
            .onChange((value) => {
              void (async () => {
                const norm = normalizeRepoConfig(this.plugin.settings.owner, value);
                this.plugin.settings.owner = norm.owner;
                this.plugin.settings.repo = norm.repo;
                await this.plugin.saveSettings();
              })();
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
            .onChange((value) => {
              void (async () => {
                this.plugin.settings.branch = value.trim() || "main";
                await this.plugin.saveSettings();
              })();
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
            .setPlaceholder(`${this.app.vault.configDir}/\n.git/\n_fit/`)
            .setValue(this.plugin.settings.excludedPaths.join("\n"))
            .onChange((value) => {
              void (async () => {
                this.plugin.settings.excludedPaths = parseExclusionRules(value, this.app.vault.configDir);
                await this.plugin.saveSettings();
              })();
            });
          textArea.inputEl.rows = 4;
          textArea.inputEl.addClass("vault-relay-textarea");
        });
    }

    // Section 3: Connection Diagnostics & Sync Actions
    new Setting(containerEl).setName("Diagnostics & Sync").setHeading();

    const actionsSetting = new Setting(containerEl)
      .setName("Sync Operations")
      .setDesc("Open the primary sync dashboard or run individual safe pull/push operations.");

    actionsSetting.addButton((button) => {
      button
        .setButtonText("Open Sync Dashboard")
        .setCta()
        .onClick(() => {
          new SyncDashboardModal(this.app, this.plugin).open();
        });
      button.buttonEl.addClass("vault-relay-btn-lg");
    });

    actionsSetting.addButton((button) => {
      button
        .setButtonText("Test Connection")
        .onClick(() => {
          void this.handleTestConnection(button);
        });
      button.buttonEl.addClass("vault-relay-btn-lg");
    });

    // Refresh token status asynchronously if not already up to date
    void this.refreshTokenStatus();
  }

  private refreshTab(): void {
    const tabWithUpdate = this as unknown as Record<string, (() => void) | undefined>;
    if (typeof tabWithUpdate["update"] === "function") {
      tabWithUpdate["update"]();
    } else {
      this.display();
    }
  }

  private async refreshTokenStatus(): Promise<void> {
    if (this.isCheckingToken) return;
    this.isCheckingToken = true;
    try {
      const exists = await hasStoredPat(
        this.app,
        this.plugin.settings.owner,
        this.plugin.settings.repo
      );
      if (this.tokenExists !== exists) {
        this.tokenExists = exists;
        this.refreshTab();
      }
      if (exists && this.repositoryLoadState === "TOKEN_MISSING") {
        void this.discoverRepositories();
      } else if (!exists) {
        this.repositoryLoadState = "TOKEN_MISSING";
      }
    } catch (err) {
      console.warn("[GitHub Vault Relay] Failed to check token status:", sanitizeErrorMessage(err));
    } finally {
      this.isCheckingToken = false;
    }
  }

  private handleClearToken(): void {
    new ClearTokenConfirmModal(this.app, async () => {
      await clearStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
      this.plugin.settings.secretKey = undefined;
      await this.plugin.saveSettings();
      this.tokenExists = false;
      this.discoveredRepos = [];
      this.discoveredBranches = [];
      this.repositoryLoadState = "TOKEN_MISSING";
      new Notice("Stored GitHub PAT cleared from SecretStorage.");
      this.refreshTab();
    }).open();
  }

  private async handleSaveAndConnect(button?: ButtonComponent): Promise<void> {
    if (!this.tokenInputVal && !this.tokenExists) {
      new Notice("Please enter a token to connect.");
      return;
    }
    if (button) {
      button.setDisabled(true);
      button.setButtonText("Connecting...");
    }
    try {
      const keyName = getSecretKeyForRepo(
        this.plugin.settings.owner,
        this.plugin.settings.repo
      );
      if (this.tokenInputVal) {
        await setStoredPat(
          this.app,
          this.plugin.settings.owner,
          this.plugin.settings.repo,
          this.tokenInputVal
        );
        this.plugin.settings.secretKey = keyName;
        await this.plugin.saveSettings();
        this.tokenExists = true;
      }
      new Notice("Token saved. Discovering accessible repositories...");
      await this.discoverRepositories();
      this.tokenInputVal = "";
      this.refreshTab();
    } catch (err) {
      new Notice(`Connection failed: ${sanitizeErrorMessage(err)}`);
    } finally {
      if (button) {
        button.setDisabled(false);
        button.setButtonText("Save & Connect");
      }
    }
  }

  private async handleTestConnection(button?: ButtonComponent): Promise<void> {
    if (button) {
      button.setButtonText("Testing...");
      button.setDisabled(true);
    }

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
      if (button) {
        button.setButtonText("Test Connection");
        button.setDisabled(false);
      }
    }
  }

  private async discoverRepositories(): Promise<void> {
    const token = await getStoredPat(this.app, this.plugin.settings.owner, this.plugin.settings.repo);
    if (!token) {
      this.repositoryLoadState = "TOKEN_MISSING";
      this.refreshTab();
      return;
    }

    const client = new GitHubClient({
      token,
      owner: this.plugin.settings.owner || "user",
      repo: this.plugin.settings.repo || "repo",
      branch: this.plugin.settings.branch || "main",
    });

    try {
      this.isDiscovering = true;
      this.repositoryLoadState = "LOADING";
      this.repositoryLoadError = "";
      this.refreshTab();
      this.discoveredRepos = await client.listUserRepositories(100);
      this.repositoryLoadState = this.discoveredRepos.length > 0 ? "LOADED" : "EMPTY";
      if (this.discoveredRepos.length > 0 && (!this.plugin.settings.owner || !this.plugin.settings.repo)) {
        const first = this.discoveredRepos[0];
        this.plugin.settings.owner = first.owner;
        this.plugin.settings.repo = first.name;
        this.plugin.settings.branch = first.defaultBranch || "main";
        await this.plugin.saveSettings();
        await this.discoverBranches(first.owner, first.name);
      } else if (this.plugin.settings.owner && this.plugin.settings.repo) {
        await this.discoverBranches(this.plugin.settings.owner, this.plugin.settings.repo);
      }
    } catch (err) {
      this.repositoryLoadState = "ERROR";
      this.repositoryLoadError = sanitizeErrorMessage(err);
      new Notice(`Failed to discover repositories: ${this.repositoryLoadError}`);
    } finally {
      this.isDiscovering = false;
      this.refreshTab();
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
