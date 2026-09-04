/**
 * Device Secret Storage Integration for GitHub Vault Relay
 *
 * Implements strict, isolated token storage:
 * 1. Active PAT storage = Obsidian SecretStorage (app.secretStorage) ONLY.
 * 2. Personal Access Tokens (PAT) are NEVER stored in plugin data.json,
 *    plaintext stores, or synchronized via vault sync.
 * 3. Zero plaintext fallback. If SecretStorage is unavailable or fails,
 *    system fails closed.
 * 4. Legacy localStorage tokens (if any exist from earlier versions) are
 *    migrated ONCE to SecretStorage, verified, and immediately purged from localStorage.
 */

import { App } from "obsidian";
import { sanitizeErrorMessage } from "./redact";

export interface SecretStorageAPI {
  getSecret(key: string): Promise<string | null> | string | null;
  setSecret(key: string, value: string | null): Promise<void> | void;
  deleteSecret?(key: string): Promise<void> | void;
  removeSecret?(key: string): Promise<void> | void;
  listSecrets?(): Promise<string[]> | string[];
}

export interface AppWithSecretStorage {
  secretStorage?: SecretStorageAPI;
}

export type StorageBackendType = "SECRET_STORAGE" | "UNAVAILABLE";

/**
 * Generates the namespaced secret key for a repository.
 */
export function getSecretKeyForRepo(owner: string, repo: string): string {
  const cleanOwner = (owner || "").trim().toLowerCase();
  const cleanRepo = (repo || "").trim().toLowerCase();
  if (cleanOwner && cleanRepo) {
    return `github-vault-relay:pat:${cleanOwner}:${cleanRepo}`;
  }
  return "github-vault-relay:pat";
}

/**
 * Returns the SecretStorage API if supported by the app instance.
 */
export function getSecretStorage(app: App): SecretStorageAPI | undefined {
  const appWithStorage = app as unknown as AppWithSecretStorage;
  if (
    appWithStorage &&
    appWithStorage.secretStorage &&
    typeof appWithStorage.secretStorage.getSecret === "function" &&
    typeof appWithStorage.secretStorage.setSecret === "function"
  ) {
    return appWithStorage.secretStorage;
  }
  return undefined;
}

/**
 * Cross-environment safe accessor for device localStorage.
 * STRICTLY restricted to legacy token cleanup and one-time migration.
 * NEVER used as an active or runtime storage fallback.
 */
export function getDeviceLocalStorage(): Storage | undefined {
  if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
    return window.localStorage;
  }
  if (typeof globalThis !== "undefined" && (globalThis as unknown as { localStorage?: Storage }).localStorage) {
    return (globalThis as unknown as { localStorage?: Storage }).localStorage;
  }
  return undefined;
}

/**
 * Detects the active secure storage backend.
 * ONLY Obsidian SecretStorage is authorized as an active storage backend.
 */
export function getActiveStorageBackend(app: App): StorageBackendType {
  if (getSecretStorage(app) !== undefined) {
    return "SECRET_STORAGE";
  }
  return "UNAVAILABLE";
}

/**
 * Checks if secure token storage is available on this device.
 */
export function isSecureStorageAvailable(app: App): boolean {
  return getActiveStorageBackend(app) === "SECRET_STORAGE";
}

/**
 * Helper to delete a secret from SecretStorage using available API methods.
 */
async function deleteFromSecretStorage(secretStorage: SecretStorageAPI, key: string): Promise<void> {
  try {
    if (typeof secretStorage.deleteSecret === "function") {
      await secretStorage.deleteSecret(key);
    } else if (typeof secretStorage.removeSecret === "function") {
      await secretStorage.removeSecret(key);
    } else {
      await secretStorage.setSecret(key, null);
    }
  } catch (err) {
    console.warn(`[GitHub Vault Relay] Failed to delete secret key:`, sanitizeErrorMessage(err));
  }
}

/**
 * Helper to purge legacy keys from localStorage to guarantee no plaintext retention.
 */
export function purgeLegacyLocalStorageKeys(owner: string, repo: string): void {
  const localStorage = getDeviceLocalStorage();
  if (!localStorage) return;
  try {
    const key = getSecretKeyForRepo(owner, repo);
    const legacyKey = `vault-relay:pat:${(owner || "").trim().toLowerCase()}:${(repo || "").trim().toLowerCase()}`;
    localStorage.removeItem(key);
    localStorage.removeItem(legacyKey);
    localStorage.removeItem("github-vault-relay:pat");
    localStorage.removeItem("vault-relay:pat");
  } catch {
    // Ignore localStorage cleanup errors
  }
}

/**
 * Retrieves the stored PAT from device secure storage.
 * Reads ONLY from Obsidian SecretStorage.
 * If legacy localStorage token exists, migrates it once into SecretStorage,
 * verifies the write, immediately deletes it from localStorage, and returns it.
 * If SecretStorage is unavailable, FAILS CLOSED and returns null.
 */
export async function getStoredPat(app: App, owner: string, repo: string): Promise<string | null> {
  const secretStorage = getSecretStorage(app);
  if (!secretStorage) {
    // FAIL CLOSED: No SecretStorage available, never read from plaintext fallback
    return null;
  }

  const key = getSecretKeyForRepo(owner, repo);
  const legacyKey = `vault-relay:pat:${(owner || "").trim().toLowerCase()}:${(repo || "").trim().toLowerCase()}`;

  // 1. Read from SecretStorage (canonical key)
  try {
    let secret = await secretStorage.getSecret(key);
    if (typeof secret === "string" && secret.trim().length > 0) {
      // Purge any stale legacy localStorage entries as a safety hygiene measure
      purgeLegacyLocalStorageKeys(owner, repo);
      return secret.trim();
    }

    // 2. Read from SecretStorage (legacy key within SecretStorage)
    secret = await secretStorage.getSecret(legacyKey);
    if (typeof secret === "string" && secret.trim().length > 0) {
      const trimmed = secret.trim();
      // Migrate within SecretStorage to canonical key
      await secretStorage.setSecret(key, trimmed);
      const verified = await secretStorage.getSecret(key);
      if (verified === trimmed) {
        await deleteFromSecretStorage(secretStorage, legacyKey);
      }
      purgeLegacyLocalStorageKeys(owner, repo);
      return trimmed;
    }

    // 3. Read from SecretStorage (global fallback key)
    if (key !== "github-vault-relay:pat") {
      const fallbackSecret = await secretStorage.getSecret("github-vault-relay:pat");
      if (typeof fallbackSecret === "string" && fallbackSecret.trim().length > 0) {
        purgeLegacyLocalStorageKeys(owner, repo);
        return fallbackSecret.trim();
      }
    }
  } catch (err) {
    console.warn("[GitHub Vault Relay] Failed to read from SecretStorage:", sanitizeErrorMessage(err));
    return null;
  }

  // 4. One-time migration from legacy localStorage (ONLY if SecretStorage is active and empty)
  const localStorage = getDeviceLocalStorage();
  if (localStorage) {
    try {
      const candidates = [
        key,
        legacyKey,
        "github-vault-relay:pat",
        "vault-relay:pat",
      ];

      for (const candidateKey of candidates) {
        const rawLegacy = localStorage.getItem(candidateKey);
        if (typeof rawLegacy === "string" && rawLegacy.trim().length > 0) {
          const cleanLegacy = rawLegacy.trim();
          // Write into SecretStorage
          await secretStorage.setSecret(key, cleanLegacy);
          // Verify SecretStorage write
          const verified = await secretStorage.getSecret(key);
          if (verified === cleanLegacy) {
            // Immediately purge legacy value and all related keys from localStorage
            purgeLegacyLocalStorageKeys(owner, repo);
            return cleanLegacy;
          } else {
            console.error("[GitHub Vault Relay] Failed to verify SecretStorage write during legacy migration.");
            return null;
          }
        }
      }
    } catch (err) {
      console.warn("[GitHub Vault Relay] Error during legacy localStorage migration:", sanitizeErrorMessage(err));
    }
  }

  return null;
}

/**
 * Stores the PAT in device secure storage.
 * Writes EXCLUSIVELY to Obsidian SecretStorage.
 * Never writes to localStorage or any other plaintext store.
 * Verifies write immediately. Fails closed if SecretStorage is unavailable or write fails.
 */
export async function setStoredPat(
  app: App,
  owner: string,
  repo: string,
  token: string
): Promise<void> {
  const cleanToken = (token || "").trim();
  const key = getSecretKeyForRepo(owner, repo);

  if (!cleanToken) {
    await clearStoredPat(app, owner, repo);
    return;
  }

  const secretStorage = getSecretStorage(app);
  if (!secretStorage) {
    // FAIL CLOSED: SecretStorage is strictly required
    throw new Error(
      "Obsidian SecretStorage is unavailable. Personal Access Tokens cannot be stored safely without Obsidian SecretStorage."
    );
  }

  try {
    // Write ONLY to SecretStorage
    await secretStorage.setSecret(key, cleanToken);

    // Verify write
    const verified = await secretStorage.getSecret(key);
    if (verified !== cleanToken) {
      throw new Error("SecretStorage write verification failed: stored value did not match.");
    }

    // Safety hygiene: ensure no legacy plaintext leftovers remain in localStorage
    purgeLegacyLocalStorageKeys(owner, repo);
  } catch (err) {
    throw new Error(`Failed to save PAT in Obsidian SecretStorage: ${sanitizeErrorMessage(err, cleanToken)}`);
  }
}

/**
 * Clears/removes the stored PAT from device storage.
 * Deletes from SecretStorage and purges any legacy localStorage entries.
 */
export async function clearStoredPat(app: App, owner: string, repo: string): Promise<void> {
  const key = getSecretKeyForRepo(owner, repo);
  const legacyKey = `vault-relay:pat:${(owner || "").trim().toLowerCase()}:${(repo || "").trim().toLowerCase()}`;

  // 1. Clear from SecretStorage if present
  const secretStorage = getSecretStorage(app);
  if (secretStorage) {
    await deleteFromSecretStorage(secretStorage, key);
    await deleteFromSecretStorage(secretStorage, legacyKey);
    if (key !== "github-vault-relay:pat") {
      await deleteFromSecretStorage(secretStorage, "github-vault-relay:pat");
    }
  }

  // 2. Always purge any legacy entries from localStorage as safety hygiene
  purgeLegacyLocalStorageKeys(owner, repo);
}

/**
 * Checks if a PAT is configured for this repository.
 */
export async function hasStoredPat(app: App, owner: string, repo: string): Promise<boolean> {
  const token = await getStoredPat(app, owner, repo);
  return !!token;
}

