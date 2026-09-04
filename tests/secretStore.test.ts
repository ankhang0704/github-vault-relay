import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import {
  getSecretKeyForRepo,
  getStoredPat,
  setStoredPat,
  clearStoredPat,
  hasStoredPat,
  getActiveStorageBackend,
  isSecureStorageAvailable,
} from "../src/security/secretStore";

describe("Device Secret Storage Integration (src/security/secretStore.ts)", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it("generates correct namespaced key for repo with github-vault-relay prefix", () => {
    expect(getSecretKeyForRepo("octocat", "my-vault")).toBe("github-vault-relay:pat:octocat:my-vault");
    expect(getSecretKeyForRepo("Owner", "Repo")).toBe("github-vault-relay:pat:owner:repo");
    expect(getSecretKeyForRepo("", "")).toBe("github-vault-relay:pat");
  });

  it("stores, retrieves, and clears PAT via SecretStorage when available", async () => {
    const app = new App();
    const token = "github_pat_test_secret_1234567890abcdef";

    expect(getActiveStorageBackend(app)).toBe("SECRET_STORAGE");
    expect(await hasStoredPat(app, "octocat", "vault")).toBe(false);
    expect(await getStoredPat(app, "octocat", "vault")).toBeNull();

    await setStoredPat(app, "octocat", "vault", token);

    expect(await hasStoredPat(app, "octocat", "vault")).toBe(true);
    expect(await getStoredPat(app, "octocat", "vault")).toBe(token);

    await clearStoredPat(app, "octocat", "vault");

    expect(await hasStoredPat(app, "octocat", "vault")).toBe(false);
    expect(await getStoredPat(app, "octocat", "vault")).toBeNull();
  });

  it("fails closed when app.secretStorage is absent (no localStorage fallback)", async () => {
    const appWithoutCoreStorage = new App();
    (appWithoutCoreStorage as unknown as { secretStorage: unknown }).secretStorage = undefined;

    expect(isSecureStorageAvailable(appWithoutCoreStorage)).toBe(false);
    expect(getActiveStorageBackend(appWithoutCoreStorage)).toBe("UNAVAILABLE");

    const token = "github_pat_local_storage_test_value";

    expect(await hasStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBe(false);
    expect(await getStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBeNull();

    // Must FAIL CLOSED and throw without writing to localStorage
    await expect(setStoredPat(appWithoutCoreStorage, "octocat", "notes", token)).rejects.toThrow(
      /SecretStorage is unavailable/i
    );

    // Verify ZERO writes to localStorage
    expect(window.localStorage.getItem("github-vault-relay:pat:octocat:notes")).toBeNull();
    expect(await hasStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBe(false);
    expect(await getStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBeNull();
  });

  it("migrates legacy localStorage vault-relay:pat:* key into SecretStorage once and purges localStorage", async () => {
    const app = new App();
    const token = "github_pat_legacy_key_val";

    window.localStorage.setItem("vault-relay:pat:legacyowner:legacyrepo", token);

    const retrieved = await getStoredPat(app, "legacyowner", "legacyrepo");
    expect(retrieved).toBe(token);

    // Verified written to SecretStorage
    const inSecretStorage = await app.secretStorage.getSecret("github-vault-relay:pat:legacyowner:legacyrepo");
    expect(inSecretStorage).toBe(token);

    // Verified purged immediately from localStorage
    expect(window.localStorage.getItem("vault-relay:pat:legacyowner:legacyrepo")).toBeNull();
    expect(window.localStorage.getItem("github-vault-relay:pat:legacyowner:legacyrepo")).toBeNull();
  });
});
