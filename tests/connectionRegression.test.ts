/**
 * Connection Regression Tests (CONN-REG-001..010)
 *
 * Verifies the resolution of the C4 Windows Connection Regression:
 * - Plugin-global canonical key "github-vault-relay-pat" strictly complies with Obsidian SecretStorage ID regex /^[a-z0-9-]+$/
 * - Lifecycle: pre-selection -> discovery -> repo selection -> restart -> test connection -> unified sync
 * - Migration from legacy colon-separated keys in localStorage without plaintext remnants
 * - Fail closed when SecretStorage is unavailable
 * - Zero plaintext token leakage
 */

import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import {
  CANONICAL_SECRET_KEY,
  getSecretKeyForRepo,
  getStoredPat,
  setStoredPat,
  clearStoredPat,
  hasStoredPat,
  isValidSecretId,
  isSecureStorageAvailable,
} from "../src/security/secretStore";
import { GitHubClient } from "../src/github/githubClient";
import { DEFAULT_SETTINGS, VaultRelaySettings } from "../src/settings";

describe("C4 Real Windows Connection Regression Forensics & Lifecycle (CONN-REG-001..010)", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  // CONN-REG-001: PAT available before owner/repo selection
  it("CONN-REG-001: PAT available before owner/repo selection", async () => {
    const app = new App();
    const token = "github_pat_11CONN_REG_001_PRE_SELECTION_TOKEN";

    // Initial state: empty owner and repo
    expect(await hasStoredPat(app, "", "")).toBe(false);
    expect(await getStoredPat(app, "", "")).toBeNull();

    // User pastes PAT in setup wizard before repo is chosen
    await setStoredPat(app, "", "", token);

    // PAT is immediately retrievable with empty owner/repo
    expect(await hasStoredPat(app, "", "")).toBe(true);
    const retrieved = await getStoredPat(app, "", "");
    expect(retrieved).toBe(token);

    // Stored strictly in SecretStorage under canonical key
    expect(await app.secretStorage.getSecret(CANONICAL_SECRET_KEY)).toBe(token);
    expect(isValidSecretId(CANONICAL_SECRET_KEY)).toBe(true);
  });

  // CONN-REG-002: repo discovery works with no owner/repo configured
  it("CONN-REG-002: repo discovery works with no owner/repo configured", async () => {
    const app = new App();
    const token = "github_pat_11CONN_REG_002_DISCOVERY_TOKEN";

    // Store token prior to discovery
    await setStoredPat(app, "", "", token);

    // Settings has no owner/repo yet
    const settings: VaultRelaySettings = {
      ...DEFAULT_SETTINGS,
      owner: "",
      repo: "",
    };

    // Client created for discovery retrieves token successfully
    const retrievedPat = await getStoredPat(app, settings.owner, settings.repo);
    expect(retrievedPat).toBe(token);

    const client = new GitHubClient({
      token: retrievedPat!,
      owner: settings.owner || "user",
      repo: settings.repo || "repo",
      branch: settings.branch || "main",
    });

    expect(client).toBeDefined();
    // Token is correctly passed to client
    expect(retrievedPat).not.toBeNull();
  });

  // CONN-REG-003: repo selection does not orphan stored PAT
  it("CONN-REG-003: repo selection does not orphan stored PAT", async () => {
    const app = new App();
    const token = "github_pat_11CONN_REG_003_NO_ORPHAN_TOKEN";

    // Step 1: User enters PAT before repo selection
    await setStoredPat(app, "", "", token);

    // Step 2: Discovery selects owner & repo
    const selectedOwner = "ankhang0704";
    const selectedRepo = "vault-relay-acceptance";

    // Step 3: Querying with newly selected owner and repo must find the same PAT
    const patAfterSelection = await getStoredPat(app, selectedOwner, selectedRepo);
    expect(patAfterSelection).toBe(token);
    expect(await hasStoredPat(app, selectedOwner, selectedRepo)).toBe(true);

    // Both queries point to the exact same canonical SecretStorage key
    expect(getSecretKeyForRepo("", "")).toBe(CANONICAL_SECRET_KEY);
    expect(getSecretKeyForRepo(selectedOwner, selectedRepo)).toBe(CANONICAL_SECRET_KEY);
  });

  // CONN-REG-004: restart restores connection without re-entering PAT
  it("CONN-REG-004: restart restores connection without re-entering PAT", async () => {
    const sharedSecretStorage = new App().secretStorage;
    const token = "github_pat_11CONN_REG_004_RESTART_TOKEN";
    const owner = "ankhang0704";
    const repo = "vault-relay-acceptance";

    // Session 1: User connects and saves token
    const appSession1 = new App();
    appSession1.secretStorage = sharedSecretStorage;
    await setStoredPat(appSession1, owner, repo, token);

    // Simulate Obsidian app restart: clear memory, localStorage, and reinitialize
    window.localStorage.clear();

    // Session 2: Obsidian restarts, plugin loads from disk
    const appSession2 = new App();
    appSession2.secretStorage = sharedSecretStorage;

    const restoredPat = await getStoredPat(appSession2, owner, repo);
    expect(restoredPat).toBe(token);
    expect(await hasStoredPat(appSession2, owner, repo)).toBe(true);
  });

  // CONN-REG-005: Test Connection after restart uses correct SecretStorage key
  it("CONN-REG-005: Test Connection after restart uses correct SecretStorage key", async () => {
    const sharedSecretStorage = new App().secretStorage;
    const token = "github_pat_11CONN_REG_005_TEST_CONN_TOKEN";
    const owner = "ankhang0704";
    const repo = "vault-relay-acceptance";

    // Precondition: Secret saved in SecretStorage
    await sharedSecretStorage.setSecret(CANONICAL_SECRET_KEY, token);

    // Simulate restart
    const app = new App();
    app.secretStorage = sharedSecretStorage;

    // Test Connection flow
    const resolvedPat = await getStoredPat(app, owner, repo);
    expect(resolvedPat).toBe(token);

    // Must not throw "Invalid secret ID" or reject with colons
    expect(isValidSecretId(CANONICAL_SECRET_KEY)).toBe(true);
    expect(CANONICAL_SECRET_KEY).not.toContain(":");
  });

  // CONN-REG-006: Unified Sync after restart receives PAT correctly
  it("CONN-REG-006: Unified Sync after restart receives PAT correctly", async () => {
    const sharedSecretStorage = new App().secretStorage;
    const token = "github_pat_11CONN_REG_006_UNIFIED_SYNC_TOKEN";
    const owner = "ankhang0704";
    const repo = "vault-relay-acceptance";

    const app1 = new App();
    app1.secretStorage = sharedSecretStorage;
    await setStoredPat(app1, owner, repo, token);

    // Restart
    const app2 = new App();
    app2.secretStorage = sharedSecretStorage;

    // Unified Sync queries getStoredPat
    const syncPat = await getStoredPat(app2, owner, repo);
    expect(syncPat).toBe(token);
    expect(syncPat).toBeTruthy();
  });

  // CONN-REG-007: repo switch does not lose PAT
  it("CONN-REG-007: repo switch does not lose PAT", async () => {
    const app = new App();
    const token = "github_pat_11CONN_REG_007_REPO_SWITCH_TOKEN";

    // Initial repo A
    await setStoredPat(app, "ankhang0704", "repo-a", token);

    // Switch settings to repo B
    const patForRepoB = await getStoredPat(app, "ankhang0704", "repo-b");
    expect(patForRepoB).toBe(token);

    // Switch settings to organization repo C
    const patForRepoC = await getStoredPat(app, "org-account", "repo-c");
    expect(patForRepoC).toBe(token);

    // No re-entry required across repo switches
    expect(await hasStoredPat(app, "org-account", "repo-c")).toBe(true);
  });

  // CONN-REG-008: legacy per-repo SecretStorage key migrates safely if architecture changed
  it("CONN-REG-008: legacy per-repo SecretStorage key migrates safely if architecture changed", async () => {
    const app = new App();
    const token = "github_pat_11CONN_REG_008_LEGACY_MIGRATION_TOKEN";
    const owner = "ankhang0704";
    const repo = "vault-relay-acceptance";

    // Precondition: Real acceptance vault state before fix
    // Legacy colon key was written into localStorage:
    const legacyLocalStorageKey = `github-vault-relay:pat:${owner}:${repo}`;
    window.localStorage.setItem(legacyLocalStorageKey, token);

    // SecretStorage has no canonical token yet
    expect(await app.secretStorage.getSecret(CANONICAL_SECRET_KEY)).toBeNull();

    // Plugin starts up or user clicks Test Connection
    const migratedToken = await getStoredPat(app, owner, repo);
    expect(migratedToken).toBe(token);

    // Verified: Token is now safely in SecretStorage under canonical key
    expect(await app.secretStorage.getSecret(CANONICAL_SECRET_KEY)).toBe(token);

    // Verified: Legacy plaintext key was purged from localStorage
    expect(window.localStorage.getItem(legacyLocalStorageKey)).toBeNull();
    expect(window.localStorage.getItem("github-vault-relay-pat")).toBeNull();

    // Also test legacy "vault-relay-pat" within SecretStorage
    const app2 = new App();
    const token2 = "github_pat_11CONN_REG_008_SECRET_STORAGE_MIGRATE";
    await app2.secretStorage.setSecret("vault-relay-pat", token2);
    expect(await app2.secretStorage.getSecret(CANONICAL_SECRET_KEY)).toBeNull();

    const migratedToken2 = await getStoredPat(app2, owner, repo);
    expect(migratedToken2).toBe(token2);
    expect(await app2.secretStorage.getSecret(CANONICAL_SECRET_KEY)).toBe(token2);
    expect(await app2.secretStorage.getSecret("vault-relay-pat")).toBeNull();
  });

  // CONN-REG-009: SecretStorage unavailable still fails closed
  it("CONN-REG-009: SecretStorage unavailable still fails closed", async () => {
    const appWithoutStorage = new App();
    (appWithoutStorage as unknown as { secretStorage: unknown }).secretStorage = undefined;

    expect(isSecureStorageAvailable(appWithoutStorage)).toBe(false);

    // Even if legacy localStorage contains a token, fail closed when SecretStorage is unavailable
    window.localStorage.setItem("github-vault-relay:pat:owner:repo", "github_pat_unauthorized");
    window.localStorage.setItem("github-vault-relay-pat", "github_pat_unauthorized");

    const pat = await getStoredPat(appWithoutStorage, "owner", "repo");
    expect(pat).toBeNull();

    // Saving PAT must fail closed and throw
    await expect(setStoredPat(appWithoutStorage, "owner", "repo", "github_pat_test")).rejects.toThrow(
      /SecretStorage is unavailable/i
    );
  });

  // CONN-REG-010: zero PAT plaintext persistence
  it("CONN-REG-010: zero PAT plaintext persistence", async () => {
    const app = new App();
    const token = "github_pat_11CONN_REG_010_ZERO_PLAINTEXT_SECRET";
    const owner = "ankhang0704";
    const repo = "vault-relay-acceptance";

    // 1. Save PAT
    await setStoredPat(app, owner, repo, token);

    // Verify localStorage has 0 entries containing the token
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k) {
        expect(k).not.toContain(token);
        expect(window.localStorage.getItem(k)).not.toContain(token);
      }
    }

    // 2. Settings serialization check
    const settings: VaultRelaySettings = {
      ...DEFAULT_SETTINGS,
      owner,
      repo,
      secretKey: CANONICAL_SECRET_KEY,
    };
    const serialized = JSON.stringify(settings);
    expect(serialized).not.toContain(token);

    // 3. Clear PAT
    await clearStoredPat(app, owner, repo);
    expect(await app.secretStorage.getSecret(CANONICAL_SECRET_KEY)).toBeNull();

    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k) {
        expect(k).not.toContain(token);
        expect(window.localStorage.getItem(k)).not.toContain(token);
      }
    }
  });
});
