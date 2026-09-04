/**
 * Legacy Saved Exclusion Migration Tests (LEGACY-EXCL-001..010)
 *
 * Verifies one-time settings migration of legacy _vault-relay/ exclusion:
 * - Old persisted default '_vault-relay/' is removed on upgrade to settingsVersion 2
 * - User custom exclusions are preserved byte/semantic equivalent
 * - Fresh installs never include '_vault-relay/'
 * - Normal classification (LOCAL_ONLY) and pushing of user '_vault-relay/' notes
 * - Idempotency and respecting user re-exclusion after migration
 * - Non-interference with repository settings or SecretStorage PAT
 */

import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import VaultRelayPlugin from "../src/main";
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  VaultRelaySettings,
} from "../src/settings";
import {
  DEFAULT_EXCLUSIONS,
  isPathExcluded,
  migrateLegacyExclusions,
} from "../src/sync/pathFilter";
import { classifySyncState } from "../src/sync/syncClassifier";
import { PushEngine } from "../src/sync/pushEngine";
import { GitHubClient } from "../src/github/githubClient";
import {
  CANONICAL_SECRET_KEY,
  getStoredPat,
  setStoredPat,
} from "../src/security/secretStore";

describe("C4 Legacy Saved Exclusion Migration (LEGACY-EXCL-001..010)", () => {
  let app: App;
  let plugin: VaultRelayPlugin;

  beforeEach(() => {
    app = new App();
    plugin = new VaultRelayPlugin(app, {
      id: "github-vault-relay",
      name: "GitHub Vault Relay",
      version: "0.3.0",
      minAppVersion: "1.0.0",
      author: "Test",
      description: "Test",
    });
  });

  // LEGACY-EXCL-001: old saved _vault-relay/ default is removed on upgrade
  it("LEGACY-EXCL-001: old saved _vault-relay/ default is removed on upgrade", async () => {
    const legacySavedData: Partial<VaultRelaySettings> = {
      owner: "ankhang0704",
      repo: "vault-relay-acceptance",
      branch: "main",
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
      secretKey: "github-vault-relay-pat",
      // settingsVersion is undefined in pre-v2 configurations
    };

    let savedData: Record<string, unknown> | null = null;
    plugin.loadData = async () => legacySavedData;
    plugin.saveData = async (data: unknown) => {
      savedData = data as Record<string, unknown>;
    };

    await plugin.loadSettings();

    // Verified: _vault-relay/ is removed, essential defaults remain
    expect(plugin.settings.excludedPaths).toEqual([".obsidian/", ".git/", "_fit/"]);
    expect(plugin.settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);

    // Verified: saved to disk
    expect(savedData).not.toBeNull();
    expect((savedData as unknown as VaultRelaySettings).excludedPaths).toEqual([
      ".obsidian/",
      ".git/",
      "_fit/",
    ]);
    expect((savedData as unknown as VaultRelaySettings).settingsVersion).toBe(2);
  });

  // LEGACY-EXCL-002: all unrelated custom exclusions survive byte/semantic equivalent
  it("LEGACY-EXCL-002: all unrelated custom exclusions survive byte/semantic equivalent", async () => {
    const customExclusions = [
      ".obsidian/",
      ".git/",
      "_fit/",
      "_vault-relay/",
      "Private/",
      "Archive/tmp/",
      "Secret Notes/2026.md",
    ];

    const migrated = migrateLegacyExclusions(customExclusions);

    expect(migrated).toEqual([
      ".obsidian/",
      ".git/",
      "_fit/",
      "Private/",
      "Archive/tmp/",
      "Secret Notes/2026.md",
    ]);

    // Test with variations of _vault-relay
    const withVariations = [
      ".obsidian/",
      "_vault-relay",
      "_vault-relay/",
      "Private/",
    ];
    expect(migrateLegacyExclusions(withVariations)).toEqual([
      ".obsidian/",
      "Private/",
    ]);
  });

  // LEGACY-EXCL-003: fresh install never adds _vault-relay/
  it("LEGACY-EXCL-003: fresh install never adds _vault-relay/", async () => {
    expect(DEFAULT_EXCLUSIONS).not.toContain("_vault-relay/");
    expect(DEFAULT_EXCLUSIONS).not.toContain("_vault-relay");
    expect(DEFAULT_SETTINGS.excludedPaths).not.toContain("_vault-relay/");
    expect(DEFAULT_SETTINGS.excludedPaths).not.toContain("_vault-relay");
    expect(DEFAULT_SETTINGS.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);

    // Simulate fresh install: loadData returns null
    plugin.loadData = async () => null;
    await plugin.loadSettings();

    expect(plugin.settings.excludedPaths).toEqual([".obsidian/", ".git/", "_fit/"]);
    expect(plugin.settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  // LEGACY-EXCL-004: after migration _vault-relay/file.md is scanned normally
  it("LEGACY-EXCL-004: after migration _vault-relay/file.md is scanned normally", async () => {
    plugin.loadData = async () => ({
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
    });
    await plugin.loadSettings();

    const filePath = "_vault-relay/file.md";
    expect(isPathExcluded(filePath, plugin.settings.excludedPaths)).toBe(false);

    // .obsidian and .git remain excluded
    expect(isPathExcluded(".obsidian/config.json", plugin.settings.excludedPaths)).toBe(true);
    expect(isPathExcluded(".git/HEAD", plugin.settings.excludedPaths)).toBe(true);
    expect(isPathExcluded("_fit/cache.json", plugin.settings.excludedPaths)).toBe(true);
  });

  // LEGACY-EXCL-005: after migration _vault-relay/file.md classifies LOCAL_ONLY
  it("LEGACY-EXCL-005: after migration _vault-relay/file.md classifies LOCAL_ONLY", async () => {
    plugin.loadData = async () => ({
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
    });
    await plugin.loadSettings();

    const localPath = "_vault-relay/notes.md";
    const localFiles = new Map();
    localFiles.set(localPath, {
      path: localPath,
      gitBlobSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      size: 100,
      mtime: Date.now(),
    });

    const result = classifySyncState({
      localFiles,
      remoteBlobs: new Map(),
      state: { version: 1, files: {} },
      excludedPaths: plugin.settings.excludedPaths,
    });

    const item = result.items.find((i) => i.path === localPath);
    expect(item).toBeDefined();
    expect(item?.category).toBe("LOCAL_ONLY");
  });

  // LEGACY-EXCL-006: Unified Sync can push _vault-relay/file.md
  it("LEGACY-EXCL-006: Unified Sync can push _vault-relay/file.md", async () => {
    plugin.loadData = async () => ({
      owner: "octocat",
      repo: "notes",
      branch: "main",
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
    });
    await plugin.loadSettings();

    // Register file in mock vault using vault.create
    await app.vault.create("_vault-relay/user-note.md", "# User note in _vault-relay\n");

    const client = new GitHubClient({
      token: "test_token",
      owner: "octocat",
      repo: "notes",
      branch: "main",
    });

    const engine = new PushEngine(app, plugin.settings, client);

    const localFiles = await engine.scanLocalVault();
    const found = localFiles.get("_vault-relay/user-note.md");
    expect(found).toBeDefined();
    expect(found?.path).toBe("_vault-relay/user-note.md");
  });

  // LEGACY-EXCL-007: migration is idempotent
  it("LEGACY-EXCL-007: migration is idempotent", async () => {
    let saveCount = 0;
    const legacySavedData: Partial<VaultRelaySettings> = {
      owner: "ankhang0704",
      repo: "vault-relay-acceptance",
      branch: "main",
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
    };

    plugin.loadData = async () => legacySavedData;
    plugin.saveData = async (data: unknown) => {
      saveCount++;
      Object.assign(legacySavedData, data);
    };

    // First load: triggers migration
    await plugin.loadSettings();
    expect(saveCount).toBe(1);
    expect(plugin.settings.excludedPaths).toEqual([".obsidian/", ".git/", "_fit/"]);
    expect(plugin.settings.settingsVersion).toBe(2);

    // Second load: already v2, no migration or saving needed
    await plugin.loadSettings();
    expect(saveCount).toBe(1);
    expect(plugin.settings.excludedPaths).toEqual([".obsidian/", ".git/", "_fit/"]);
    expect(plugin.settings.settingsVersion).toBe(2);
  });

  // LEGACY-EXCL-008: after migration user manually re-adds _vault-relay/ -> respected
  it("LEGACY-EXCL-008: after migration user manually re-adds _vault-relay/ -> exclusion is respected", async () => {
    // Already migrated to v2, and user manually configured _vault-relay/ in settings
    const userConfiguredV2Data: Partial<VaultRelaySettings> = {
      owner: "ankhang0704",
      repo: "vault-relay-acceptance",
      branch: "main",
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
      settingsVersion: 2, // User is already at v2
    };

    let savedData: unknown = null;
    plugin.loadData = async () => userConfiguredV2Data;
    plugin.saveData = async (data: unknown) => {
      savedData = data;
    };

    await plugin.loadSettings();

    // User's deliberate choice to exclude _vault-relay/ MUST NOT be stripped
    expect(plugin.settings.excludedPaths).toContain("_vault-relay/");
    expect(isPathExcluded("_vault-relay/file.md", plugin.settings.excludedPaths)).toBe(true);
    // Did not trigger any spurious save
    expect(savedData).toBeNull();
  });

  // LEGACY-EXCL-009: owner/repo/branch/other settings unchanged
  it("LEGACY-EXCL-009: owner/repo/branch/other settings unchanged", async () => {
    const originalConfig: Partial<VaultRelaySettings> = {
      owner: "custom-user",
      repo: "custom-vault",
      branch: "develop",
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/", "Personal/"],
      secretKey: CANONICAL_SECRET_KEY,
    };

    plugin.loadData = async () => originalConfig;
    await plugin.loadSettings();

    expect(plugin.settings.owner).toBe("custom-user");
    expect(plugin.settings.repo).toBe("custom-vault");
    expect(plugin.settings.branch).toBe("develop");
    expect(plugin.settings.secretKey).toBe(CANONICAL_SECRET_KEY);
    expect(plugin.settings.excludedPaths).toEqual([
      ".obsidian/",
      ".git/",
      "_fit/",
      "Personal/",
    ]);
  });

  // LEGACY-EXCL-010: SecretStorage / PAT behavior unchanged
  it("LEGACY-EXCL-010: SecretStorage / PAT behavior unchanged", async () => {
    const token = "github_pat_11LEGACY_EXCL_010_TOKEN";
    await setStoredPat(app, "testowner", "testrepo", token);

    // Run settings migration
    plugin.loadData = async () => ({
      owner: "testowner",
      repo: "testrepo",
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
    });
    await plugin.loadSettings();

    // PAT is untouched and fully accessible via SecretStorage
    const pat = await getStoredPat(app, plugin.settings.owner, plugin.settings.repo);
    expect(pat).toBe(token);
  });
});
