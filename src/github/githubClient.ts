/**
 * GitHub API Client for GitHub Vault Relay
 *
 * Implements hardened, conservative communication with GitHub REST and Git Data APIs.
 * Supports GET reads (branches, trees, blobs) and C3 Git Data writes (blobs, trees, commits, refs).
 * Features automatic token redaction, bounded retries (429 / 503 / 504), and offline preflight checks.
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
  GitHubBlobResponse,
  GitHubBranchResponse,
  GitHubCommitResponse,
  GitHubConnectionTestResult,
  GitHubCreateBlobResponse,
  GitHubCreateTreeResponse,
  GitHubRefResponse,
  GitHubRepoResponse,
  GitHubTreeItemInput,
  GitHubTreeResponse,
  GitHubRepoSummary,
  GitHubBranchSummary,
} from "./githubTypes";
import { sanitizeErrorMessage, redactTokens } from "../security/redact";
import { calculateRawGitBlobSha } from "../sync/hashUtils";
import { isOversized } from "../sync/fileSizePolicy";

export type GitHubRequestFn = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

export type TimeoutProfile = "metadata" | "content" | "mutation";

export interface TimeoutProfileConfig {
  metadataMs: number;
  contentMs: number;
  mutationMs: number;
}

export const DEFAULT_TIMEOUT_PROFILES: TimeoutProfileConfig = {
  metadataMs: 10000,   // 10s: interactive control-plane reads (repo, branches, refs, trees, user)
  contentMs: 120000,   // 120s (2m): content payloads up to 25 MiB over mobile networks (getBlob)
  mutationMs: 120000,  // 120s (2m): Git mutations (blobs up to 25 MiB, trees, commits, refs)
};

export const DEFAULT_REQUEST_TIMEOUT_MS = DEFAULT_TIMEOUT_PROFILES.metadataMs;

export class GitHubError extends Error {
  public status?: number;
  public statusText?: string;

  constructor(message: string, status?: number, statusText?: string, tokenToRedact?: string) {
    super(redactTokens(message, tokenToRedact));
    this.name = "GitHubError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class GitHubTimeoutError extends GitHubError {
  public readonly isTimeout = true;

  constructor(timeoutMs: number, tokenToRedact?: string) {
    super(
      `Network request timed out after ${timeoutMs}ms. Please check your internet connection.`,
      0,
      "TIMEOUT",
      tokenToRedact
    );
    this.name = "GitHubTimeoutError";
  }
}

export class GitHubOfflineError extends GitHubError {
  public readonly isOffline = true;

  constructor(tokenToRedact?: string) {
    super(
      "Device is offline (network disconnected or airplane mode).",
      0,
      "OFFLINE",
      tokenToRedact
    );
    this.name = "GitHubOfflineError";
  }
}

/**
 * Normalizes user-entered owner and repository strings, handling full URLs,
 * owner/repo slugs, .git suffixes, and stray slashes.
 */
export function normalizeRepoConfig(owner: string, repo: string): { owner: string; repo: string } {
  let cleanOwner = (owner || "").trim();
  let cleanRepo = (repo || "").trim();

  if (cleanRepo.startsWith("http://") || cleanRepo.startsWith("https://") || cleanRepo.startsWith("git@")) {
    const urlPattern = /(?:github\.com[/:])([^/]+)\/?([^/.]+)?(?:\.git)?/i;
    const match = cleanRepo.match(urlPattern);
    if (match) {
      cleanOwner = match[1] || cleanOwner;
      cleanRepo = match[2] || "";
    }
  }

  if (cleanRepo.includes("/")) {
    const parts = cleanRepo.split("/").filter(Boolean);
    if (parts.length >= 2) {
      cleanOwner = parts[0];
      cleanRepo = parts[1];
    } else if (parts.length === 1) {
      cleanRepo = parts[0];
    }
  }

  if (cleanOwner.startsWith("http://") || cleanOwner.startsWith("https://")) {
    const match = cleanOwner.match(/github\.com\/([^/]+)/i);
    if (match) {
      cleanOwner = match[1];
    }
  }

  if (cleanRepo.endsWith(".git")) {
    cleanRepo = cleanRepo.slice(0, -4);
  }

  cleanOwner = cleanOwner.replace(/^\/+|\/+$/g, "");
  cleanRepo = cleanRepo.replace(/^\/+|\/+$/g, "");

  return { owner: cleanOwner, repo: cleanRepo };
}

export interface GitHubClientConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  requestFn?: GitHubRequestFn;
  timeoutMs?: number;
  timeoutProfiles?: Partial<TimeoutProfileConfig>;
}

/**
 * Decodes a base64 string into a Uint8Array using standard Web APIs.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, "");
  const binaryString = atob(clean);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Helper to pause execution for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GitHubClient {
  private token: string;
  private owner: string;
  private repo: string;
  private branch: string;
  private requestFn: GitHubRequestFn;
  private timeoutProfiles: TimeoutProfileConfig;
  private readonly baseUrl = "https://api.github.com";

  constructor(config: GitHubClientConfig) {
    this.token = config.token ? config.token.trim() : "";
    const normalized = normalizeRepoConfig(config.owner, config.repo);
    this.owner = normalized.owner;
    this.repo = normalized.repo;
    this.branch = config.branch ? config.branch.trim() : "main";
    this.requestFn = config.requestFn || requestUrl;

    const baseProfiles: TimeoutProfileConfig = {
      ...DEFAULT_TIMEOUT_PROFILES,
      ...(config.timeoutProfiles || {}),
    };
    if (config.timeoutMs !== undefined) {
      this.timeoutProfiles = {
        metadataMs: config.timeoutProfiles?.metadataMs ?? config.timeoutMs,
        contentMs: config.timeoutProfiles?.contentMs ?? config.timeoutMs,
        mutationMs: config.timeoutProfiles?.mutationMs ?? config.timeoutMs,
      };
    } else {
      this.timeoutProfiles = baseProfiles;
    }
  }

  /**
   * Returns the resolved timeout duration for a given request profile.
   */
  public getTimeoutForProfile(profile: TimeoutProfile): number {
    switch (profile) {
      case "metadata":
        return this.timeoutProfiles.metadataMs;
      case "content":
        return this.timeoutProfiles.contentMs;
      case "mutation":
        return this.timeoutProfiles.mutationMs;
    }
  }

  /**
   * Executes an HTTP request with an application-level timeout envelope.
   * Obsidian's requestUrl does not expose transport-level socket cancellation (AbortSignal),
   * so this envelope returns control to the application after timeoutMs while guaranteeing:
   * 1. Late-settling underlying promises never trigger unhandled promise rejections.
   * 2. Late completions do not trigger callbacks or alter application state.
   */
  private async executeWithTimeout(
    rawPromise: Promise<RequestUrlResponse>,
    timeoutMs: number
  ): Promise<RequestUrlResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new GitHubTimeoutError(timeoutMs, this.token));
      }, timeoutMs);
    });

    try {
      return await Promise.race([rawPromise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      // CRITICAL: Suppress unhandled promise rejection if the underlying socket
      // rejects after the timeout envelope has already returned control to the caller.
      rawPromise.catch(() => {
        // Suppress late rejection
      });
    }
  }

  /**
   * Helper to perform authenticated HTTP requests to GitHub REST API with retries,
   * bounded timeouts, and token redaction.
   */
  private async request<T>(
    endpoint: string,
    options?: {
      method?: "GET" | "POST" | "PATCH";
      body?: unknown;
      headers?: Record<string, string>;
      timeoutProfile?: TimeoutProfile;
      timeoutMs?: number;
    }
  ): Promise<T> {
    const method = options?.method || "GET";
    const profile: TimeoutProfile = options?.timeoutProfile || (method === "GET" ? "metadata" : "mutation");
    const timeoutMs = options?.timeoutMs !== undefined ? options.timeoutMs : this.getTimeoutForProfile(profile);

    // Offline preflight check: Fail immediately with clear message if navigator explicitly reports offline
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new GitHubOfflineError(this.token);
    }

    if (!this.token) {
      throw new GitHubError(
        "GitHub token is missing. Please configure your Fine-Grained Personal Access Token in settings.",
        undefined,
        undefined,
        this.token
      );
    }

    if (!endpoint.startsWith("/user") && (!this.owner || !this.repo)) {
      throw new GitHubError(
        "Repository owner or name is not configured.",
        undefined,
        undefined,
        this.token
      );
    }

    const url = endpoint.startsWith("http") ? endpoint : `${this.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "VaultRelay-Obsidian-Plugin",
      ...(options?.headers || {}),
    };

    let serializedBody: string | undefined = undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(options.body);
    }

    let attempt = 0;
    // Read requests are safe to retry. Git mutations are not retried because a lost
    // response is ambiguous: GitHub may already have accepted the operation.
    const maxAttempts = method === "GET" ? 3 : 1;

    while (attempt < maxAttempts) {
      attempt++;

      try {
        const rawPromise = this.requestFn({
          url,
          method,
          headers,
          body: serializedBody,
          throw: false,
        });

        const response = await this.executeWithTimeout(rawPromise, timeoutMs);

        if (response.status >= 200 && response.status < 300) {
          return response.json as T;
        }

        // Handle Rate Limit (HTTP 429)
        if (response.status === 429 && attempt < maxAttempts) {
          const retryAfterHeader = response.headers?.["retry-after"] || response.headers?.["Retry-After"];
          let waitSec = 2 * attempt;
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed) && parsed > 0) {
              waitSec = Math.min(parsed, 10);
            }
          }
          await sleep(waitSec * 1000);
          continue;
        }

        // Handle Server Unavailable (HTTP 503 / 504)
        if ((response.status === 503 || response.status === 504) && attempt < maxAttempts) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000;
          await sleep(backoffMs);
          continue;
        }

        // Fail-fast on other status codes (401, 403, 404, 422, etc.)
        let errorMsg = `GitHub API request failed: HTTP ${response.status}`;
        try {
          const jsonBody = response.json;
          if (jsonBody && jsonBody.message) {
            errorMsg += ` - ${jsonBody.message}`;
          }
        } catch {
          if (response.text) {
            errorMsg += ` - ${response.text.slice(0, 100)}`;
          }
        }
        throw new GitHubError(errorMsg, response.status, undefined, this.token);
      } catch (err) {
        // GitHubError (including GitHubTimeoutError and GitHubOfflineError) fails fast and is not retried
        if (err instanceof GitHubError) {
          throw err;
        }
        if (attempt < maxAttempts) {
          await sleep(1000 * attempt);
          continue;
        }
        const sanitized = sanitizeErrorMessage(err, this.token);
        throw new GitHubError(`GitHub request error: ${sanitized}`, undefined, undefined, this.token);
      }
    }

    throw new GitHubError("GitHub request failed after maximum retry attempts.", undefined, undefined, this.token);
  }

  // ==========================================
  // READ PRIMITIVES (GET)
  // ==========================================

  /**
   * Fetches repository metadata.
   */
  public async getRepo(): Promise<GitHubRepoResponse> {
    return this.request<GitHubRepoResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`,
      { method: "GET", timeoutProfile: "metadata" }
    );
  }

  /**
   * Fetches branch information including HEAD commit SHA.
   */
  /**
   * Fetches the authoritative Git reference for a branch directly from the Git Data API.
   * GET /repos/{owner}/{repo}/git/ref/heads/{branch}
   */
  public async getBranchRef(branchName?: string): Promise<GitHubRefResponse> {
    const target = (branchName || this.branch).trim();
    const timestamp = Date.now();
    return this.request<GitHubRefResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/ref/heads/${encodeURIComponent(target)}?t=${timestamp}`,
      {
        method: "GET",
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        timeoutProfile: "metadata",
      }
    );
  }

  public async getBranch(branchName?: string, bypassCache = true): Promise<GitHubBranchResponse> {
    const target = branchName || this.branch;
    const url = bypassCache
      ? `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(target)}?t=${Date.now()}`
      : `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(target)}`;
    const options = {
      method: "GET" as const,
      headers: bypassCache
        ? {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
          }
        : undefined,
      timeoutProfile: "metadata" as const,
    };
    return this.request<GitHubBranchResponse>(url, options);
  }

  /**
   * Fetches the full Git tree recursively for a given commit or tree SHA.
   */
  /**
   * Authoritative commit reader from Git Data API.
   * Content-addressed and immutable: GET /repos/{owner}/{repo}/git/commits/{commitSha}
   */
  public async getCommit(commitSha: string): Promise<GitHubCommitResponse> {
    return this.request<GitHubCommitResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits/${encodeURIComponent(commitSha)}`,
      { method: "GET", timeoutProfile: "metadata" }
    );
  }

  public async getTreeRecursive(treeSha: string): Promise<GitHubTreeResponse> {
    return this.request<GitHubTreeResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
      { method: "GET", timeoutProfile: "metadata" }
    );
  }

  /**
   * Fetches a raw blob object from GitHub Git Data API.
   * Classified as CONTENT profile to safely support files up to 25 MiB over mobile networks.
   */
  public async getBlob(blobSha: string): Promise<GitHubBlobResponse> {
    return this.request<GitHubBlobResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs/${encodeURIComponent(blobSha)}`,
      {
        method: "GET",
        timeoutProfile: "content",
      }
    );
  }

  /**
   * Fetches raw bytes for a blob and strictly validates cryptographic integrity against expected blob SHA.
   */
  public async getRawBlobBytes(blobSha: string, expectedSize?: number): Promise<Uint8Array> {
    if (isOversized(expectedSize)) {
      throw new GitHubError(`Blob size exceeds Vault Relay 25 MiB safety policy: ${expectedSize} bytes`);
    }

    const blobResponse = await this.getBlob(blobSha);

    if (isOversized(blobResponse.size)) {
      throw new GitHubError(`Blob payload exceeds Vault Relay 25 MiB safety policy: ${blobResponse.size} bytes`);
    }

    let bytes: Uint8Array;
    if (blobResponse.encoding === "base64") {
      bytes = base64ToUint8Array(blobResponse.content);
    } else if (blobResponse.encoding === "utf-8") {
      bytes = new TextEncoder().encode(blobResponse.content);
    } else {
      throw new GitHubError(`Unsupported blob encoding: ${blobResponse.encoding}`);
    }

    // Cryptographic integrity check
    const computedRawSha = await calculateRawGitBlobSha(bytes);
    if (computedRawSha.toLowerCase() !== blobSha.toLowerCase()) {
      throw new GitHubError(
        `Integrity verification failed for remote blob ${blobSha}. Computed raw SHA was ${computedRawSha}.`
      );
    }

    return bytes;
  }

  // ==========================================
  // C3 WRITE PRIMITIVES (POST / PATCH)
  // ==========================================

  /**
   * Creates a Git blob object in GitHub Git Data API.
   * POST /repos/{owner}/{repo}/git/blobs
   */
  public async createBlob(content: string, encoding: "utf-8" | "base64" = "utf-8"): Promise<GitHubCreateBlobResponse> {
    return this.request<GitHubCreateBlobResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs`,
      {
        method: "POST",
        body: { content, encoding },
        timeoutProfile: "mutation",
      }
    );
  }

  /**
   * Creates a Git tree object in GitHub Git Data API.
   * POST /repos/{owner}/{repo}/git/trees
   */
  public async createTree(tree: GitHubTreeItemInput[], baseTreeSha?: string): Promise<GitHubCreateTreeResponse> {
    const body: { tree: GitHubTreeItemInput[]; base_tree?: string } = { tree };
    if (baseTreeSha) {
      body.base_tree = baseTreeSha;
    }

    return this.request<GitHubCreateTreeResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees`,
      {
        method: "POST",
        body,
        timeoutProfile: "mutation",
      }
    );
  }

  /**
   * Creates a Git commit object in GitHub Git Data API.
   * POST /repos/{owner}/{repo}/git/commits
   */
  public async createCommit(message: string, treeSha: string, parents: string[]): Promise<GitHubCommitResponse> {
    return this.request<GitHubCommitResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits`,
      {
        method: "POST",
        body: {
          message,
          tree: treeSha,
          parents,
        },
        timeoutProfile: "mutation",
      }
    );
  }

  /**
   * Updates a branch reference with optimistic concurrency.
   * PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}
   * Strictly prohibits force: true.
   */
  public async updateBranchRef(branch: string, commitSha: string, force = false): Promise<GitHubRefResponse> {
    if (force) {
      throw new GitHubError("Force ref updates are strictly forbidden by Vault Relay safety invariants.");
    }

    const targetBranch = (branch || this.branch).trim();

    const response = await this.request<GitHubRefResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/refs/heads/${encodeURIComponent(targetBranch)}`,
      {
        method: "PATCH",
        body: {
          sha: commitSha,
          force: false,
        },
        timeoutProfile: "mutation",
      }
    );

    if (!response.object || !response.object.sha) {
      throw new GitHubError("GitHub ref update response did not contain an object SHA.");
    }

    if (response.object.sha.toLowerCase() !== commitSha.toLowerCase()) {
      throw new GitHubError(
        `GitHub ref update response returned unexpected object SHA (${response.object.sha}), expected ${commitSha}.`
      );
    }

    return response;
  }

  /**
   * Tests the connection to the configured GitHub repository.
   */
  public async testConnection(): Promise<GitHubConnectionTestResult> {
    try {
      const repo = await this.getRepo();
      let targetBranchSha: string | undefined;

      try {
        const branch = await this.getBranch(this.branch);
        targetBranchSha = branch.commit?.sha;
      } catch (branchErr) {
        return {
          success: false,
          repoFullName: repo.full_name,
          defaultBranch: repo.default_branch,
          targetBranch: this.branch,
          canPush: !!repo.permissions?.push,
          canPull: !!repo.permissions?.pull,
          isPrivate: repo.private,
          errorMessage: `Repository found, but branch '${this.branch}' was not found or could not be accessed: ${sanitizeErrorMessage(
            branchErr,
            this.token
          )}`,
        };
      }

      return {
        success: true,
        repoFullName: repo.full_name,
        defaultBranch: repo.default_branch,
        targetBranch: this.branch,
        targetBranchSha,
        canPush: !!repo.permissions?.push,
        canPull: !!repo.permissions?.pull,
        isPrivate: repo.private,
      };
    } catch (err) {
      return {
        success: false,
        repoFullName: `${this.owner}/${this.repo}`,
        defaultBranch: "unknown",
        targetBranch: this.branch,
        canPush: false,
        canPull: false,
        isPrivate: false,
        errorMessage: sanitizeErrorMessage(err, this.token),
      };
    }
  }

  /**
   * Discovers repositories accessible to the configured PAT.
   * Uses GET /user/repos?per_page=100&sort=updated
   */
  /**
   * Discovers repositories accessible to the configured PAT.
   * Supports pagination beyond 100 repositories up to maxRepos (default 300).
   * Uses GET /user/repos?per_page=100&page=N&sort=updated
   */
  public async listUserRepositories(maxRepos = 300): Promise<GitHubRepoSummary[]> {
    const allRepos: GitHubRepoSummary[] = [];
    let page = 1;
    const perPage = 100;

    while (allRepos.length < maxRepos) {
      const rawRepos = await this.request<Array<{
        full_name: string;
        name: string;
        owner: { login: string };
        default_branch: string;
        private: boolean;
        description?: string | null;
      }>>(`/user/repos?per_page=${perPage}&page=${page}&sort=updated`, {
        method: "GET",
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        timeoutProfile: "metadata",
      });

      if (!rawRepos || rawRepos.length === 0) break;

      for (const r of rawRepos) {
        allRepos.push({
          fullName: r.full_name,
          owner: r.owner.login,
          name: r.name,
          defaultBranch: r.default_branch || "main",
          isPrivate: !!r.private,
          description: r.description || undefined,
        });
      }

      if (rawRepos.length < perPage) break;
      page++;
    }

    return allRepos;
  }

  /**
   * Lists branches for a repository.
   * Uses GET /repos/{owner}/{repo}/branches?per_page=100
   */
  /**
   * Lists branches for a repository with pagination support up to maxBranches (default 200).
   * Uses GET /repos/{owner}/{repo}/branches?per_page=100&page=N
   */
  public async listBranches(owner?: string, repo?: string, maxBranches = 200): Promise<GitHubBranchSummary[]> {
    const targetOwner = (owner || this.owner).trim();
    const targetRepo = (repo || this.repo).trim();
    const allBranches: GitHubBranchSummary[] = [];
    let page = 1;
    const perPage = 100;

    while (allBranches.length < maxBranches) {
      const rawBranches = await this.request<Array<{
        name: string;
        commit: { sha: string };
        protected?: boolean;
      }>>(
        `/repos/${encodeURIComponent(targetOwner)}/${encodeURIComponent(targetRepo)}/branches?per_page=${perPage}&page=${page}`,
        {
          method: "GET",
          headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
          },
          timeoutProfile: "metadata",
        }
      );

      if (!rawBranches || rawBranches.length === 0) break;

      for (const b of rawBranches) {
        allBranches.push({
          name: b.name,
          commitSha: b.commit.sha,
          protected: b.protected,
        });
      }

      if (rawBranches.length < perPage) break;
      page++;
    }

    return allBranches;
  }

}
