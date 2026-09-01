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

  it("stores, retrieves, and clears PAT via device localStorage when app.secretStorage is absent", async () => {
    const appWithoutCoreStorage = new App();
    (appWithoutCoreStorage as unknown as { secretStorage: unknown }).secretStorage = undefined;

    expect(isSecureStorageAvailable(appWithoutCoreStorage)).toBe(true);
    expect(getActiveStorageBackend(appWithoutCoreStorage)).toBe("LOCAL_STORAGE");

    const token = "github_pat_local_storage_test_value";

    expect(await hasStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBe(false);
    expect(await getStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBeNull();

    await setStoredPat(appWithoutCoreStorage, "octocat", "notes", token);

    expect(await hasStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBe(true);
    expect(await getStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBe(token);

    // Verify it is stored in localStorage under correct key
    expect(window.localStorage.getItem("github-vault-relay:pat:octocat:notes")).toBe(token);

    await clearStoredPat(appWithoutCoreStorage, "octocat", "notes");

    expect(await hasStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBe(false);
    expect(await getStoredPat(appWithoutCoreStorage, "octocat", "notes")).toBeNull();
    expect(window.localStorage.getItem("github-vault-relay:pat:octocat:notes")).toBeNull();
  });

  it("reads legacy vault-relay:pat:* key seamlessly for backward compatibility", async () => {
    const app = new App();
    const token = "github_pat_legacy_key_val";

    window.localStorage.setItem("vault-relay:pat:legacyowner:legacyrepo", token);

    const retrieved = await getStoredPat(app, "legacyowner", "legacyrepo");
    expect(retrieved).toBe(token);
  });
});
