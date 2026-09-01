import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import {
  getSecretKeyForRepo,
  getStoredPat,
  setStoredPat,
  clearStoredPat,
  hasStoredPat,
  isSecretStorageAvailable,
  SecretStorageUnavailableError,
} from "../src/security/secretStore";

describe("SecretStorage Integration (src/security/secretStore.ts)", () => {
  it("generates correct namespaced key for repo", () => {
    expect(getSecretKeyForRepo("octocat", "my-vault")).toBe("vault-relay:pat:octocat:my-vault");
    expect(getSecretKeyForRepo("Owner", "Repo")).toBe("vault-relay:pat:owner:repo");
    expect(getSecretKeyForRepo("", "")).toBe("vault-relay:pat");
  });

  it("stores, retrieves, and clears PAT in SecretStorage", async () => {
    const app = new App();
    const token = "github_pat_test_secret_1234567890abcdef";

    expect(await hasStoredPat(app, "octocat", "vault")).toBe(false);
    expect(await getStoredPat(app, "octocat", "vault")).toBeNull();

    await setStoredPat(app, "octocat", "vault", token);

    expect(await hasStoredPat(app, "octocat", "vault")).toBe(true);
    expect(await getStoredPat(app, "octocat", "vault")).toBe(token);

    await clearStoredPat(app, "octocat", "vault");

    expect(await hasStoredPat(app, "octocat", "vault")).toBe(false);
    expect(await getStoredPat(app, "octocat", "vault")).toBeNull();
  });

  it("throws SecretStorageUnavailableError if app.secretStorage is missing (no silent plaintext degradation)", async () => {
    const brokenApp = new App();
    (brokenApp as unknown as { secretStorage: unknown }).secretStorage = undefined;

    expect(isSecretStorageAvailable(brokenApp)).toBe(false);

    await expect(getStoredPat(brokenApp, "owner", "repo")).rejects.toThrow(
      SecretStorageUnavailableError
    );
    await expect(setStoredPat(brokenApp, "owner", "repo", "tok")).rejects.toThrow(
      SecretStorageUnavailableError
    );
  });
});
