/**
 * Obsidian SecretStorage Integration for Vault Relay
 *
 * Mandates the use of official Obsidian SecretStorage (app.secretStorage)
 * introduced in Obsidian v1.11.4+.
 *
 * Personal Access Tokens (PAT) are stored exclusively in SecretStorage
 * and NEVER written to plugin data.json or sync state files.
 */

import { App } from "obsidian";
import { redactTokens, sanitizeErrorMessage } from "./redact";

export interface SecretStorageAPI {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret?(key: string): Promise<void>;
  listSecrets?(): Promise<string[]>;
}

export class SecretStorageUnavailableError extends Error {
  constructor() {
    super(
      "Obsidian SecretStorage is required for Vault Relay. Please update Obsidian to version 1.11.4 or higher to securely store Personal Access Tokens."
    );
    this.name = "SecretStorageUnavailableError";
  }
}

/**
 * Generates the namespaced secret key for a repository.
 */
export function getSecretKeyForRepo(owner: string, repo: string): string {
  const cleanOwner = (owner || "").trim().toLowerCase();
  const cleanRepo = (repo || "").trim().toLowerCase();
  if (cleanOwner && cleanRepo) {
    return `vault-relay:pat:${cleanOwner}:${cleanRepo}`;
  }
  return "vault-relay:pat";
}

/**
 * Returns the SecretStorage API if supported by the app instance.
 */
export function getSecretStorage(app: App): SecretStorageAPI | undefined {
  const candidate = (app as unknown as { secretStorage?: SecretStorageAPI }).secretStorage;
  if (
    candidate &&
    typeof candidate.getSecret === "function" &&
    typeof candidate.setSecret === "function"
  ) {
    return candidate;
  }
  return undefined;
}

/**
 * Checks if Obsidian SecretStorage is available in the current App instance.
 */
export function isSecretStorageAvailable(app: App): boolean {
  return getSecretStorage(app) !== undefined;
}

/**
 * Retrieves the stored PAT from Obsidian SecretStorage.
 * Throws SecretStorageUnavailableError if SecretStorage is not supported.
 */
export async function getStoredPat(app: App, owner: string, repo: string): Promise<string | null> {
  const storage = getSecretStorage(app);
  if (!storage) {
    throw new SecretStorageUnavailableError();
  }

  const key = getSecretKeyForRepo(owner, repo);
  try {
    const secret = await storage.getSecret(key);
    if (typeof secret === "string" && secret.trim().length > 0) {
      return secret.trim();
    }

    // Fallback lookup for global vault-relay key if repo-specific key not found
    if (key !== "vault-relay:pat") {
      const fallbackSecret = await storage.getSecret("vault-relay:pat");
      if (typeof fallbackSecret === "string" && fallbackSecret.trim().length > 0) {
        return fallbackSecret.trim();
      }
    }

    return null;
  } catch (err) {
    throw new Error(`Failed to retrieve secret from SecretStorage: ${sanitizeErrorMessage(err)}`, {
      cause: err,
    });
  }
}

/**
 * Stores the PAT in Obsidian SecretStorage.
 */
export async function setStoredPat(
  app: App,
  owner: string,
  repo: string,
  token: string
): Promise<void> {
  const storage = getSecretStorage(app);
  if (!storage) {
    throw new SecretStorageUnavailableError();
  }

  const cleanToken = (token || "").trim();
  if (!cleanToken) {
    await clearStoredPat(app, owner, repo);
    return;
  }

  const key = getSecretKeyForRepo(owner, repo);
  try {
    await storage.setSecret(key, cleanToken);
  } catch (err) {
    throw new Error(
      `Failed to save secret in SecretStorage: ${sanitizeErrorMessage(err, cleanToken)}`,
      { cause: err }
    );
  }
}

/**
 * Clears/removes the stored PAT from Obsidian SecretStorage.
 */
export async function clearStoredPat(app: App, owner: string, repo: string): Promise<void> {
  const storage = getSecretStorage(app);
  if (!storage) {
    return;
  }

  const key = getSecretKeyForRepo(owner, repo);
  try {
    if (typeof storage.deleteSecret === "function") {
      await storage.deleteSecret(key);
    } else {
      // If deleteSecret is not directly available, set to empty
      await storage.setSecret(key, "");
    }
  } catch (err) {
    console.warn(`[Vault Relay] Failed to clear secret for key ${redactTokens(key)}:`, err);
  }
}

/**
 * Checks if a PAT is configured for this repository.
 */
export async function hasStoredPat(app: App, owner: string, repo: string): Promise<boolean> {
  if (!isSecretStorageAvailable(app)) {
    return false;
  }
  const token = await getStoredPat(app, owner, repo);
  return !!token;
}
