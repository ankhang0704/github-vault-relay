/**
 * Desktop Local Git Handoff Manager
 *
 * Implements a conservative Remote Commit Handoff signal architecture.
 *
 * Purity & Security Invariants:
 * - 100% pure Obsidian Vault API. Zero shell execution, zero child_process, zero native Git calls.
 * - Conforms strictly to Obsidian Community Plugin Security Policies (no arbitrary process execution).
 * - Writes a durable, declarative signal file (`git-handoff.json`) under plugin internal storage.
 * - An external script (e.g. `scripts/git-handoff.ps1` or `scripts/git-handoff.sh`) or local agent
 *   can consume this signal and reconcile local .git metadata using `git fetch` and `git reset --mixed`.
 * - Strictly isolated to Desktop via Platform.isDesktopApp.
 */

import { App, Platform } from "obsidian";
import { StorageManager } from "./storageManager";
import { sanitizeErrorMessage } from "../security/redact";
import type { VaultRelaySettings } from "../settings";

export interface GitHandoffSignal {
  $schemaVersion: 1;
  action: "adopt-remote-commit";
  status: "pending" | "completed" | "failed";
  branch: string;
  remoteCommitSha: string;
  createdAt: string;
  appliedAt: string | null;
  lastError: string | null;
}

export interface DesktopGitHandoffResult {
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  signal?: GitHandoffSignal;
  error?: string;
  message?: string;
}

/**
 * Validates a 40-character hexadecimal Git commit SHA.
 */
export function isValidCommitSha(sha: unknown): sha is string {
  if (typeof sha !== "string") return false;
  return /^[0-9a-f]{40}$/i.test(sha.trim());
}

/**
 * Validates branch name to prevent any unexpected control characters or path traversal.
 */
export function isValidBranchName(branch: unknown): branch is string {
  if (typeof branch !== "string") return false;
  const trimmed = branch.trim();
  if (!trimmed || trimmed.length > 255) return false;
  return /^[a-zA-Z0-9._\-/]+$/.test(trimmed) && !trimmed.includes("..");
}

/**
 * Resolves the path to git-handoff.json within plugin internal storage.
 */
export function getGitHandoffFilePath(app: App): string {
  return `${StorageManager.getPluginStorageDir(app)}/git-handoff.json`;
}

/**
 * Emits a durable git-handoff.json signal when running on Desktop.
 * Completely pure: uses Obsidian's vault adapter, no child processes.
 */
export async function emitGitHandoffSignal(
  app: App,
  branch: string,
  commitSha: string
): Promise<DesktopGitHandoffResult> {
  if (!Platform.isDesktopApp) {
    return { status: "SKIPPED", message: "Desktop Git handoff skipped: not running on Desktop." };
  }

  if (!isValidCommitSha(commitSha)) {
    return { status: "FAILED", error: `Invalid commit SHA format: "${String(commitSha)}"` };
  }

  const safeBranch = branch && isValidBranchName(branch) ? branch.trim() : "main";
  const safeSha = commitSha.trim();

  const signal: GitHandoffSignal = {
    $schemaVersion: 1,
    action: "adopt-remote-commit",
    status: "pending",
    branch: safeBranch,
    remoteCommitSha: safeSha,
    createdAt: new Date().toISOString(),
    appliedAt: null,
    lastError: null,
  };

  try {
    const storageDir = StorageManager.getPluginStorageDir(app);
    if (!(await app.vault.adapter.exists(storageDir))) {
      await app.vault.adapter.mkdir(storageDir);
    }

    const handoffPath = getGitHandoffFilePath(app);
    await app.vault.adapter.write(handoffPath, JSON.stringify(signal, null, 2));

    return {
      status: "SUCCESS",
      signal,
      message: `Git handoff signal emitted for commit ${safeSha.slice(0, 7)}.`,
    };
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err);
    return {
      status: "FAILED",
      error: sanitized,
    };
  }
}

/**
 * Reads the current git-handoff.json signal if it exists.
 */
export async function readGitHandoffSignal(app: App): Promise<GitHandoffSignal | null> {
  try {
    const handoffPath = getGitHandoffFilePath(app);
    if (!(await app.vault.adapter.exists(handoffPath))) {
      return null;
    }
    const content = await app.vault.adapter.read(handoffPath);
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      parsed &&
      parsed.$schemaVersion === 1 &&
      parsed.action === "adopt-remote-commit" &&
      typeof parsed.remoteCommitSha === "string" &&
      isValidCommitSha(parsed.remoteCommitSha)
    ) {
      return parsed as unknown as GitHandoffSignal;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Triggers background git handoff signal emission if enabled in settings and running on Desktop.
 * Non-blocking, failure-tolerant.
 */
export function triggerDesktopGitAdvanceInBackground(
  app: App,
  settings: VaultRelaySettings,
  commitSha: string | undefined
): void {
  if (!settings.autoAdvanceDesktopGit) return;
  if (!commitSha || !isValidCommitSha(commitSha)) return;

  void (async () => {
    try {
      const res = await emitGitHandoffSignal(app, settings.branch || "main", commitSha);
      if (res.status === "FAILED") {
        console.warn(`[Vault Relay] Desktop Git handoff signal error: ${res.error ?? "unknown error"}`);
      }
    } catch (err) {
      console.warn("[Vault Relay] Desktop Git handoff signal unexpected exception:", sanitizeErrorMessage(err));
    }
  })();
}
