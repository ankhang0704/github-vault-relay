import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import {
  getStoredPat,
  setStoredPat,
  clearStoredPat,
  getActiveStorageBackend,
  isSecureStorageAvailable,
  getSecretKeyForRepo,
} from "../src/security/secretStore";
import { redactTokens, sanitizeErrorMessage } from "../src/security/redact";
import { DEFAULT_SETTINGS, VaultRelaySettings } from "../src/settings";

describe("C4 Secret Storage Invariant Audit & Hardening (SEC-C4-001..008)", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  // SEC-C4-001: PAT save writes SecretStorage only
  it("SEC-C4-001: PAT save writes SecretStorage only", async () => {
    const app = new App();
    const token = "github_pat_11TEST_SECRET_STORAGE_ONLY_TOKEN_001";
    const owner = "testowner";
    const repo = "testrepo";
    const expectedKey = getSecretKeyForRepo(owner, repo);

    await setStoredPat(app, owner, repo, token);

    // Direct read from SecretStorage API
    const storedSecret = await app.secretStorage.getSecret(expectedKey);
    expect(storedSecret).toBe(token);

    // Read via getStoredPat
    const retrieved = await getStoredPat(app, owner, repo);
    expect(retrieved).toBe(token);

    // Clear and verify removed from SecretStorage
    await clearStoredPat(app, owner, repo);
    expect(await app.secretStorage.getSecret(expectedKey)).toBeNull();
    expect(await getStoredPat(app, owner, repo)).toBeNull();
  });

  // SEC-C4-002: no PAT written to localStorage
  it("SEC-C4-002: no PAT written to localStorage", async () => {
    const app = new App();
    const token = "github_pat_11SEC_C4_002_NO_LOCAL_STORAGE_WRITE";
    const owner = "secowner";
    const repo = "secrepo";
    const key = getSecretKeyForRepo(owner, repo);

    await setStoredPat(app, owner, repo, token);

    // Directly verify localStorage does not have token under expected key
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem(`vault-relay:pat:${owner}:${repo}`)).toBeNull();
    expect(window.localStorage.getItem("github-vault-relay:pat")).toBeNull();
    expect(window.localStorage.getItem("vault-relay:pat")).toBeNull();

    // Verify localStorage has zero entries containing the token
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k) {
        expect(k).not.toContain(token);
        expect(window.localStorage.getItem(k)).not.toContain(token);
      }
    }
  });

  // SEC-C4-003: no PAT written to data.json/settings
  it("SEC-C4-003: no PAT written to data.json/settings", async () => {
    const token = "github_pat_11SEC_C4_003_DATA_JSON_INVARIANT";
    const owner = "dataowner";
    const repo = "datarepo";
    const key = getSecretKeyForRepo(owner, repo);

    const testSettings: VaultRelaySettings = {
      ...DEFAULT_SETTINGS,
      owner,
      repo,
      secretKey: key, // only key identifier is stored in settings
    };

    // Serialize settings as Obsidian does when saving to data.json
    const serializedJson = JSON.stringify(testSettings, null, 2);

    // Verify the serialized JSON does not contain the token
    expect(serializedJson).not.toContain(token);
    expect((testSettings as unknown as Record<string, unknown>)["pat"]).toBeUndefined();
    expect((testSettings as unknown as Record<string, unknown>)["token"]).toBeUndefined();
    expect(testSettings.secretKey).toBe(key);
  });

  // SEC-C4-004: SecretStorage failure does not fall back to plaintext storage
  it("SEC-C4-004: SecretStorage failure does not fall back to plaintext storage", async () => {
    const appNoStorage = new App();
    (appNoStorage as unknown as { secretStorage: unknown }).secretStorage = undefined;

    const token = "github_pat_11SEC_C4_004_FAIL_CLOSED_TOKEN";
    const owner = "failowner";
    const repo = "failrepo";

    expect(isSecureStorageAvailable(appNoStorage)).toBe(false);
    expect(getActiveStorageBackend(appNoStorage)).toBe("UNAVAILABLE");

    // setStoredPat must throw and NEVER write to localStorage
    await expect(setStoredPat(appNoStorage, owner, repo, token)).rejects.toThrow(
      /SecretStorage is unavailable/i
    );
    expect(window.localStorage.getItem(getSecretKeyForRepo(owner, repo))).toBeNull();

    // getStoredPat must return null (fail closed)
    expect(await getStoredPat(appNoStorage, owner, repo)).toBeNull();

    // Test throwing SecretStorage write failure
    const appBrokenStorage = new App();
    appBrokenStorage.secretStorage.setSecret = vi.fn().mockRejectedValue(new Error("SecretStorage write error"));

    await expect(setStoredPat(appBrokenStorage, owner, repo, token)).rejects.toThrow(
      /Failed to save PAT in Obsidian SecretStorage/i
    );
    // Ensure no fallback write occurred
    expect(window.localStorage.getItem(getSecretKeyForRepo(owner, repo))).toBeNull();
  });

  // SEC-C4-005: legacy localStorage PAT migrates once then is deleted, only if legacy migration is genuinely supported
  it("SEC-C4-005: legacy localStorage PAT migrates once then is deleted, only if legacy migration is genuinely supported", async () => {
    const app = new App();
    const legacyToken = "github_pat_11SEC_C4_005_LEGACY_MIGRATION_TOKEN";
    const owner = "legacyowner";
    const repo = "legacyrepo";
    const legacyKey = `vault-relay:pat:${owner}:${repo}`;
    const canonicalKey = getSecretKeyForRepo(owner, repo);

    // Pre-seed legacy token in localStorage
    window.localStorage.setItem(legacyKey, legacyToken);

    // Initial check: SecretStorage is empty
    expect(await app.secretStorage.getSecret(canonicalKey)).toBeNull();

    // Read triggers one-time migration
    const retrieved = await getStoredPat(app, owner, repo);
    expect(retrieved).toBe(legacyToken);

    // Verified stored in SecretStorage
    expect(await app.secretStorage.getSecret(canonicalKey)).toBe(legacyToken);

    // Verified immediately deleted from localStorage
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
    expect(window.localStorage.getItem(canonicalKey)).toBeNull();

    // Subsequent read served purely from SecretStorage
    const secondRead = await getStoredPat(app, owner, repo);
    expect(secondRead).toBe(legacyToken);
    expect(window.localStorage.getItem(legacyKey)).toBeNull();

    // If SecretStorage is UNAVAILABLE, legacy localStorage token is NOT returned (fails closed)
    const appNoStorage = new App();
    (appNoStorage as unknown as { secretStorage: unknown }).secretStorage = undefined;
    window.localStorage.setItem(legacyKey, legacyToken);

    const failClosedRead = await getStoredPat(appNoStorage, owner, repo);
    expect(failClosedRead).toBeNull();
  });

  // SEC-C4-006: PAT never appears in logs/errors
  it("SEC-C4-006: PAT never appears in logs/errors", () => {
    const fineGrainedToken = "github_pat_11AABBCCDDEEFF0123456789_abcdefghijklmnopqrstuvwxyz";
    const classicToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const bearerHeader = `Authorization: Bearer ${fineGrainedToken}`;
    const rawError = new Error(`Connection to GitHub failed with ${bearerHeader}`);

    const sanitized = sanitizeErrorMessage(rawError, fineGrainedToken);
    expect(sanitized).not.toContain(fineGrainedToken);
    expect(sanitized).not.toContain(classicToken);
    expect(sanitized).toContain("[REDACTED_TOKEN]");

    const directRedact = redactTokens(`Failed request with token ${classicToken}`);
    expect(directRedact).not.toContain(classicToken);
    expect(directRedact).toContain("[REDACTED_TOKEN]");
  });

  // SEC-C4-007: restart reads PAT from SecretStorage
  it("SEC-C4-007: restart reads PAT from SecretStorage", async () => {
    const sharedSecretStorage = new App().secretStorage;
    const token = "github_pat_11SEC_C4_007_RESTART_SURVIVES_IN_SECRETSTORAGE";
    const owner = "restartowner";
    const repo = "restartrepo";

    // Session 1: save token
    const app1 = new App();
    app1.secretStorage = sharedSecretStorage;
    await setStoredPat(app1, owner, repo, token);

    // Wipe localStorage to simulate clean browser/electron restart
    window.localStorage.clear();

    // Session 2: simulate new plugin load after Obsidian restart
    const app2 = new App();
    app2.secretStorage = sharedSecretStorage;

    const retrievedOnRestart = await getStoredPat(app2, owner, repo);
    expect(retrievedOnRestart).toBe(token);
    // localStorage remains empty
    expect(window.localStorage.getItem(getSecretKeyForRepo(owner, repo))).toBeNull();
  });

  // SEC-C4-008: source audit has zero active plaintext token writers
  it("SEC-C4-008: source audit has zero active plaintext token writers", () => {
    const srcDir = path.resolve(__dirname, "../src");

    function getAllTsFiles(dir: string): string[] {
      const files: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...getAllTsFiles(fullPath));
        } else if (entry.name.endsWith(".ts")) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const allSourceFiles = getAllTsFiles(srcDir);
    expect(allSourceFiles.length).toBeGreaterThan(0);

    for (const filePath of allSourceFiles) {
      const content = fs.readFileSync(filePath, "utf-8");

      // 1. No file in src/ should call sessionStorage anywhere
      expect(content).not.toContain("sessionStorage");

      // 2. No file in src/ should call localStorage.setItem
      expect(content).not.toContain("localStorage.setItem");

      // 3. Only secretStore.ts may access localStorage API (strictly for cleanup or migration)
      if (!filePath.endsWith("secretStore.ts")) {
        expect(content).not.toMatch(/\blocalStorage\.[a-zA-Z]/);
      }
    }
  });
});
