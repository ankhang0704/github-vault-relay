/**
 * Device Secret Storage Integration for GitHub Vault Relay
 *
 * Implements strict, isolated token storage:
 * 1. Active PAT storage = Obsidian SecretStorage (app.secretStorage) ONLY.
 * 2. Personal Access Tokens (PAT) are NEVER stored in plugin data.json,
 *    plaintext stores, or synchronized via vault sync.
 * 3. Zero plaintext fallback. If SecretStorage is unavailable or fails,
 *    system fails closed.
 * 4. Obsidian SecretStorage enforces key validation: /^[a-z0-9-]+$/ with length <= 64.
 *    The canonical plugin SecretStorage key is "github-vault-relay-pat".
 * 5. Legacy credentials (from localStorage or older key schemas) are migrated ONCE
 *    to SecretStorage under CANONICAL_SECRET_KEY, verified, and immediately purged.
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
 * Canonical plugin-global SecretStorage key.
 * Strictly conforms to Obsidian's SecretStorage ID validation: /^[a-z0-9-]+$/ && length <= 64.
 */
export const CANONICAL_SECRET_KEY = "github-vault-relay-pat";

/**
 * Validates whether a key satisfies Obsidian's SecretStorage ID requirements.
 */
export function isValidSecretId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id) && id.length <= 64;
}

/**
 * Generates the namespaced secret key for a repository.
 * In the unified/global storage model, this maps to CANONICAL_SECRET_KEY.
 */
export function getSecretKeyForRepo(_owner?: string, _repo?: string): string {
  return CANONICAL_SECRET_KEY;
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
  if (!isValidSecretId(key)) return;
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
export function purgeLegacyLocalStorageKeys(owner?: string, repo?: string): void {
  const localStorage = getDeviceLocalStorage();
  if (!localStorage) return;
  try {
    const cleanOwner = (owner || "").trim().toLowerCase();
    const cleanRepo = (repo || "").trim().toLowerCase();
    const knownKeys = [
      CANONICAL_SECRET_KEY,
      "vault-relay-pat",
      "github-vault-relay:pat",
      "vault-relay:pat",
    ];
    if (cleanOwner && cleanRepo) {
      knownKeys.push(`github-vault-relay:pat:${cleanOwner}:${cleanRepo}`);
      knownKeys.push(`vault-relay:pat:${cleanOwner}:${cleanRepo}`);
    }
    for (const k of knownKeys) {
      localStorage.removeItem(k);
    }

    // Also scan all keys in localStorage to purge any remaining legacy patterns
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /vault-relay.*pat/i.test(k)) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
    }
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
export async function getStoredPat(app: App, owner?: string, repo?: string): Promise<string | null> {
  const secretStorage = getSecretStorage(app);
  if (!secretStorage) {
    // FAIL CLOSED: No SecretStorage available, never read from plaintext fallback
    return null;
  }

  // 1. Read from SecretStorage using canonical key ("github-vault-relay-pat")
  try {
    const secret = await secretStorage.getSecret(CANONICAL_SECRET_KEY);
    if (typeof secret === "string" && secret.trim().length > 0) {
      // Purge any stale legacy localStorage entries as safety hygiene
      purgeLegacyLocalStorageKeys(owner, repo);
      return secret.trim();
    }
  } catch (err) {
    console.warn("[GitHub Vault Relay] Failed to read from SecretStorage:", sanitizeErrorMessage(err));
  }

  // 2. Read from SecretStorage using valid legacy keys if any (e.g., "vault-relay-pat")
  const legacySecretKeys = ["vault-relay-pat"];
  for (const legKey of legacySecretKeys) {
    try {
      if (isValidSecretId(legKey)) {
        const legVal = await secretStorage.getSecret(legKey);
        if (typeof legVal === "string" && legVal.trim().length > 0) {
          const trimmed = legVal.trim();
          await secretStorage.setSecret(CANONICAL_SECRET_KEY, trimmed);
          const verified = await secretStorage.getSecret(CANONICAL_SECRET_KEY);
          if (verified === trimmed) {
            await deleteFromSecretStorage(secretStorage, legKey);
            purgeLegacyLocalStorageKeys(owner, repo);
            return trimmed;
          }
        }
      }
    } catch {
      // Ignore legacy SecretStorage query issues
    }
  }

  // 3. One-time migration from legacy localStorage (ONLY if SecretStorage is active and empty)
  const localStorage = getDeviceLocalStorage();
  if (localStorage) {
    try {
      const cleanOwner = (owner || "").trim().toLowerCase();
      const cleanRepo = (repo || "").trim().toLowerCase();
      const candidates: string[] = [];

      if (cleanOwner && cleanRepo) {
        candidates.push(`github-vault-relay:pat:${cleanOwner}:${cleanRepo}`);
        candidates.push(`vault-relay:pat:${cleanOwner}:${cleanRepo}`);
      }
      candidates.push("github-vault-relay:pat");
      candidates.push("vault-relay:pat");
      candidates.push(CANONICAL_SECRET_KEY);
      candidates.push("vault-relay-pat");

      // Also scan all localStorage keys for any match
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /vault-relay.*pat/i.test(k) && !candidates.includes(k)) {
          candidates.push(k);
        }
      }

      for (const candidateKey of candidates) {
        const rawLegacy = localStorage.getItem(candidateKey);
        if (typeof rawLegacy === "string" && rawLegacy.trim().length > 0) {
          const cleanLegacy = rawLegacy.trim();
          // Write into SecretStorage under canonical key
          await secretStorage.setSecret(CANONICAL_SECRET_KEY, cleanLegacy);
          // Verify SecretStorage write
          const verified = await secretStorage.getSecret(CANONICAL_SECRET_KEY);
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
    // Write ONLY to SecretStorage using CANONICAL_SECRET_KEY
    await secretStorage.setSecret(CANONICAL_SECRET_KEY, cleanToken);

    // Verify write
    const verified = await secretStorage.getSecret(CANONICAL_SECRET_KEY);
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
export async function clearStoredPat(app: App, owner?: string, repo?: string): Promise<void> {
  // 1. Clear from SecretStorage if present
  const secretStorage = getSecretStorage(app);
  if (secretStorage) {
    await deleteFromSecretStorage(secretStorage, CANONICAL_SECRET_KEY);
    await deleteFromSecretStorage(secretStorage, "vault-relay-pat");
  }

  // 2. Always purge any legacy entries from localStorage as safety hygiene
  purgeLegacyLocalStorageKeys(owner, repo);
}

/**
 * Checks if a PAT is configured for this repository.
 */
export async function hasStoredPat(app: App, owner?: string, repo?: string): Promise<boolean> {
  const token = await getStoredPat(app, owner, repo);
  return !!token;
}
