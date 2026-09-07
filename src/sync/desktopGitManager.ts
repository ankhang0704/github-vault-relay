/**
 * Desktop Local Git Manager
 *
 * Automatically reconciles local native .git repository metadata (HEAD & Index)
 * with the authoritative remote commit SHA after a successful Vault Relay sync.
 *
 * Safety Invariants:
 * - Strictly isolated to Desktop via Platform.isDesktopApp. Zero runtime overhead or Node imports on Mobile.
 * - Uses `git reset --mixed <commitSha>` only. Never uses `--hard` or `--keep` to guarantee local uncommitted notes are never deleted.
 * - Argument-based execution via `execFile` prevents shell injection.
 * - Strict commit SHA hex format validation (/^[0-9a-f]{40}$/i).
 * - Bounded 15s execution timeout prevents hanging on network or credential prompts.
 * - Non-blocking: failures log warnings and never roll back or abort Obsidian sync results.
 */

import { App, FileSystemAdapter, Platform } from "obsidian";
import { sanitizeErrorMessage } from "../security/redact";
import type { VaultRelaySettings } from "../settings";

export interface DesktopGitAdvanceResult {
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  commitSha?: string;
  error?: string;
  message?: string;
}

export type ExecFileFunction = (
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number; env?: Record<string, string> },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

interface ChildProcessModule {
  execFile: ExecFileFunction;
}

/**
 * Validates a 40-character hexadecimal Git commit SHA.
 */
export function isValidCommitSha(sha: unknown): sha is string {
  if (typeof sha !== "string") return false;
  return /^[0-9a-f]{40}$/i.test(sha.trim());
}

/**
 * Validates branch name to prevent any unexpected control characters or shell separators.
 */
export function isValidBranchName(branch: unknown): branch is string {
  if (typeof branch !== "string") return false;
  const trimmed = branch.trim();
  if (!trimmed || trimmed.length > 255) return false;
  return /^[a-zA-Z0-9._\-/]+$/.test(trimmed) && !trimmed.includes("..");
}

/**
 * Builds process execution environment with augmented PATH on Unix/macOS
 * to ensure binaries installed in /opt/homebrew/bin or /usr/local/bin can be resolved by Electron.
 */
export function buildExecutionEnv(): Record<string, string> | undefined {
  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (typeof val === "string") {
      env[key] = val;
    }
  }

  if (!Platform.isWin) {
    const currentPath = env["PATH"] || "";
    const additions = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    const segments = currentPath ? currentPath.split(":") : [];
    for (const add of additions) {
      if (!segments.includes(add)) {
        segments.push(add);
      }
    }
    env["PATH"] = segments.join(":");
  }

  return env;
}

/**
 * Safely resolves the Node.js child_process module on Electron Desktop.
 * Returns null on Mobile or if Node environment is unavailable.
 */
export function getChildProcess(): ChildProcessModule | null {
  if (!Platform.isDesktopApp) return null;
  const win = window as unknown as { require?: (mod: string) => ChildProcessModule };
  if (typeof win.require === "function") {
    try {
      return win.require("child_process");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Checks if the vault is located in a native Git repository on Desktop.
 */
export async function isDesktopGitAvailable(app: App): Promise<boolean> {
  if (!Platform.isDesktopApp) return false;
  if (!(app.vault.adapter instanceof FileSystemAdapter)) return false;
  try {
    return await app.vault.adapter.exists(".git");
  } catch {
    return false;
  }
}

export interface AdvanceDesktopGitOptions {
  timeoutMs?: number;
  customExecFile?: ExecFileFunction;
}

/**
 * Executes a single command safely using execFile.
 */
function runGitCommand(
  execFileFn: ExecFileFunction,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = buildExecutionEnv();
    execFileFn("git", args, { cwd, timeout: timeoutMs, env }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Advances local .git repository metadata to match the remote commit SHA without re-downloading files.
 * Performs:
 * 1. git fetch origin <branch> --quiet (bounded timeout 15s)
 * 2. git cat-file -e <commitSha> (verifies object exists locally)
 * 3. git reset --mixed <commitSha> (updates HEAD & index safely)
 */
export async function advanceDesktopGit(
  app: App,
  branch: string,
  commitSha: string,
  options?: AdvanceDesktopGitOptions
): Promise<DesktopGitAdvanceResult> {
  if (!Platform.isDesktopApp) {
    return { status: "SKIPPED", message: "Desktop Git auto-advance skipped: not running on Desktop." };
  }

  if (!(app.vault.adapter instanceof FileSystemAdapter)) {
    return { status: "SKIPPED", message: "Desktop Git auto-advance skipped: file system adapter unavailable." };
  }

  const hasGit = await app.vault.adapter.exists(".git");
  if (!hasGit) {
    return { status: "SKIPPED", message: "Desktop Git auto-advance skipped: .git directory not found in vault." };
  }

  if (!isValidCommitSha(commitSha)) {
    return { status: "FAILED", error: `Invalid commit SHA format: "${String(commitSha)}"` };
  }

  const safeBranch = branch && isValidBranchName(branch) ? branch.trim() : "main";
  const safeSha = commitSha.trim();
  const cwd = app.vault.adapter.getBasePath();
  const timeoutMs = options?.timeoutMs ?? 15000;

  const execFileFn = options?.customExecFile ?? getChildProcess()?.execFile;
  if (!execFileFn) {
    return { status: "FAILED", error: "child_process.execFile is not available in current environment." };
  }

  try {
    // Step 1: Fetch commit object from remote
    await runGitCommand(execFileFn, ["fetch", "origin", safeBranch, "--quiet"], cwd, timeoutMs);

    // Step 2: Verify object exists locally in object store
    await runGitCommand(execFileFn, ["cat-file", "-e", safeSha], cwd, timeoutMs);

    // Step 3: Advance HEAD and index to target commit without modifying working tree
    await runGitCommand(execFileFn, ["reset", "--mixed", safeSha], cwd, timeoutMs);

    return {
      status: "SUCCESS",
      commitSha: safeSha,
      message: `Local .git repository advanced to ${safeSha.slice(0, 7)}.`,
    };
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err);
    return {
      status: "FAILED",
      commitSha: safeSha,
      error: sanitized,
    };
  }
}

/**
 * Triggers background git advance if enabled in settings and running on Desktop.
 * Non-blocking, failure-tolerant (does not throw).
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
      const res = await advanceDesktopGit(app, settings.branch || "main", commitSha);
      if (res.status === "FAILED") {
        console.warn(`[Vault Relay] Desktop Git auto-advance warning: ${res.error ?? "unknown error"}`);
      }
    } catch (err) {
      console.warn("[Vault Relay] Desktop Git auto-advance unexpected exception:", sanitizeErrorMessage(err));
    }
  })();
}
