/**
 * GitHub Vault Relay - Conservative GitHub-backed Obsidian Vault Sync Plugin
 * Main Plugin Entry Point (C4 Unified Sync)
 */

import { Notice, Plugin } from "obsidian";
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  VaultRelaySettings,
  VaultRelaySettingTab,
} from "./settings";
import { SyncDashboardModal } from "./ui/syncDashboardModal";
import { SyncPreviewModal } from "./ui/syncPreviewModal";
import { PullConfirmModal } from "./ui/pullConfirmModal";
import { PushConfirmModal } from "./ui/pushConfirmModal";
import { GitHubClient } from "./github/githubClient";
import { sanitizeErrorMessage } from "./security/redact";
import { CANONICAL_SECRET_KEY, getStoredPat } from "./security/secretStore";
import { StorageManager } from "./sync/storageManager";
import { migrateLegacyExclusions } from "./sync/pathFilter";

export default class VaultRelayPlugin extends Plugin {
  public settings: VaultRelaySettings = DEFAULT_SETTINGS;

  public async onload(): Promise<void> {
    await this.loadSettings();

    // C4 Automatic Storage Migration: migrate legacy _vault-relay to hidden plugin storage
    try {
      await StorageManager.migrateLegacyStorage(this.app);
    } catch (migErr) {
      console.warn("[Vault Relay] Automatic storage migration warning:", migErr);
    }

    // Register Plugin Settings Tab
    this.addSettingTab(new VaultRelaySettingTab(this.app, this));

    // Register Primary Ribbon Icon: opens Unified Sync Dashboard
    this.addRibbonIcon("refresh-cw", "GitHub Vault Relay: Sync Dashboard", () => {
      new SyncDashboardModal(this.app, this).open();
    });

    // Register Primary Command: Open Sync Dashboard
    this.addCommand({
      id: "github-vault-relay-sync-dashboard",
      name: "Open Sync Dashboard",
      callback: () => {
        new SyncDashboardModal(this.app, this).open();
      },
    });

    // Backward-compatible Command: Preview Sync Status (Read-Only)
    this.addCommand({
      id: "github-vault-relay-preview-sync",
      name: "Preview sync status (Read-Only)",
      callback: () => {
        new SyncPreviewModal(this.app, this).open();
      },
    });

    // Backward-compatible Command: Pull Safe Remote Changes
    this.addCommand({
      id: "github-vault-relay-pull-safe-changes",
      name: "Pull safe remote changes (GitHub -> Local)",
      callback: () => {
        new PullConfirmModal(this.app, this).open();
      },
    });

    // Backward-compatible Command: Push Safe Local Changes
    this.addCommand({
      id: "github-vault-relay-push-safe-changes",
      name: "Push safe local changes (Local -> GitHub)",
      callback: () => {
        new PushConfirmModal(this.app, this).open();
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
    const rawData = (await this.loadData()) as Partial<VaultRelaySettings> | null;
    const loaded = rawData || {};
    const previousVersion = typeof loaded.settingsVersion === "number" ? loaded.settingsVersion : 1;

    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

    let needsSave = false;

    if (this.settings.secretKey && this.settings.secretKey !== CANONICAL_SECRET_KEY) {
      this.settings.secretKey = CANONICAL_SECRET_KEY;
      needsSave = true;
    }

    // One-time migration: pre-v2 settings had _vault-relay/ in default exclusions.
    // In C4, _vault-relay/ is user-owned, so remove old persisted default once.
    // If user later explicitly re-adds it, settingsVersion is already 2 so it is preserved.
    if (previousVersion < CURRENT_SETTINGS_VERSION) {
      this.settings.excludedPaths = migrateLegacyExclusions(this.settings.excludedPaths);
      this.settings.settingsVersion = CURRENT_SETTINGS_VERSION;
      needsSave = true;
    }

    if (needsSave) {
      await this.saveSettings();
    }
  }

  public async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
