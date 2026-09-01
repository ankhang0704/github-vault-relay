/**
 * Device Secret Storage Integration for GitHub Vault Relay
 *
 * Implements secure, isolated device token storage:
 * 1. Uses Obsidian SecretStorage (app.secretStorage) when available.
 * 2. Uses device localStorage (isolated within Obsidian app profile) on platforms
 *    where core SecretStorage is not yet present.
 *
 * Personal Access Tokens (PAT) are NEVER stored in plugin data.json
 * or synchronized via vault sync.
 */

import { App } from "obsidian";
import { redactTokens, sanitizeErrorMessage } from "./redact";

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

export type StorageBackendType = "SECRET_STORAGE" | "LOCAL_STORAGE" | "UNAVAILABLE";

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
 */
export function getActiveStorageBackend(app: App): StorageBackendType {
  if (getSecretStorage(app) !== undefined) {
    return "SECRET_STORAGE";
  }
  if (getDeviceLocalStorage() !== undefined) {
    return "LOCAL_STORAGE";
  }
  return "UNAVAILABLE";
}

/**
 * Checks if secure token storage is available on this device.
 */
export function isSecureStorageAvailable(app: App): boolean {
  return getActiveStorageBackend(app) !== "UNAVAILABLE";
}

/**
 * Retrieves the stored PAT from device secure storage.
 */
export async function getStoredPat(app: App, owner: string, repo: string): Promise<string | null> {
  const key = getSecretKeyForRepo(owner, repo);
  const legacyKey = `vault-relay:pat:${(owner || "").trim().toLowerCase()}:${(repo || "").trim().toLowerCase()}`;

  // 1. Try Obsidian SecretStorage if available
  const secretStorage = getSecretStorage(app);
  if (secretStorage) {
    try {
      let secret = await secretStorage.getSecret(key);
      if (typeof secret === "string" && secret.trim().length > 0) {
        return secret.trim();
      }

      // Check legacy key in SecretStorage if exists
      secret = await secretStorage.getSecret(legacyKey);
      if (typeof secret === "string" && secret.trim().length > 0) {
        return secret.trim();
      }

      // Check global fallback key
      if (key !== "github-vault-relay:pat") {
        const fallbackSecret = await secretStorage.getSecret("github-vault-relay:pat");
        if (typeof fallbackSecret === "string" && fallbackSecret.trim().length > 0) {
          return fallbackSecret.trim();
        }
      }
    } catch (err) {
      console.warn("[GitHub Vault Relay] Failed to read from SecretStorage:", sanitizeErrorMessage(err));
    }
  }

  // 2. Try device localStorage (isolated to Obsidian app storage)
  const localStorage = getDeviceLocalStorage();
  if (localStorage) {
    try {
      let localVal = localStorage.getItem(key);
      if (typeof localVal === "string" && localVal.trim().length > 0) {
        return localVal.trim();
      }

      // Check legacy key
      localVal = localStorage.getItem(legacyKey);
      if (typeof localVal === "string" && localVal.trim().length > 0) {
        return localVal.trim();
      }

      // Check global key
      if (key !== "github-vault-relay:pat") {
        const fallbackVal = localStorage.getItem("github-vault-relay:pat");
        if (typeof fallbackVal === "string" && fallbackVal.trim().length > 0) {
          return fallbackVal.trim();
        }
      }
    } catch (err) {
      console.warn("[GitHub Vault Relay] Failed to read from localStorage:", sanitizeErrorMessage(err));
    }
  }

  return null;
}

/**
 * Stores the PAT in device secure storage.
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

  const backend = getActiveStorageBackend(app);
  if (backend === "UNAVAILABLE") {
    throw new Error("Device secure storage is unavailable in current runtime environment.");
  }

  let saved = false;

  // 1. Save to SecretStorage if present
  const secretStorage = getSecretStorage(app);
  if (secretStorage) {
    try {
      await secretStorage.setSecret(key, cleanToken);
      saved = true;
    } catch (err) {
      console.warn("[GitHub Vault Relay] Failed to save in SecretStorage:", sanitizeErrorMessage(err, cleanToken));
    }
  }

  // 2. Save to localStorage (ensures universal persistence across current Obsidian releases)
  const localStorage = getDeviceLocalStorage();
  if (localStorage) {
    try {
      localStorage.setItem(key, cleanToken);
      saved = true;
    } catch (err) {
      console.warn("[GitHub Vault Relay] Failed to save in localStorage:", sanitizeErrorMessage(err, cleanToken));
    }
  }

  if (!saved) {
    throw new Error("Failed to write PAT to device storage.");
  }
}

/**
 * Clears/removes the stored PAT from device storage.
 */
export async function clearStoredPat(app: App, owner: string, repo: string): Promise<void> {
  const key = getSecretKeyForRepo(owner, repo);
  const legacyKey = `vault-relay:pat:${(owner || "").trim().toLowerCase()}:${(repo || "").trim().toLowerCase()}`;

  // 1. Clear from SecretStorage if present
  const secretStorage = getSecretStorage(app);
  if (secretStorage) {
    try {
      if (typeof secretStorage.deleteSecret === "function") {
        await secretStorage.deleteSecret(key);
        await secretStorage.deleteSecret(legacyKey);
      } else if (typeof secretStorage.removeSecret === "function") {
        await secretStorage.removeSecret(key);
        await secretStorage.removeSecret(legacyKey);
      } else {
        await secretStorage.setSecret(key, null);
      }
    } catch (err) {
      console.warn(`[GitHub Vault Relay] Failed to clear secret for ${redactTokens(key)}:`, err);
    }
  }

  // 2. Clear from localStorage
  const localStorage = getDeviceLocalStorage();
  if (localStorage) {
    try {
      localStorage.removeItem(key);
      localStorage.removeItem(legacyKey);
    } catch (err) {
      console.warn(`[GitHub Vault Relay] Failed to remove item from localStorage:`, err);
    }
  }
}

/**
 * Checks if a PAT is configured for this repository.
 */
export async function hasStoredPat(app: App, owner: string, repo: string): Promise<boolean> {
  const token = await getStoredPat(app, owner, repo);
  return !!token;
}
