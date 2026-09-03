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
  private readonly baseUrl = "https://api.github.com";

  constructor(config: GitHubClientConfig) {
    this.token = config.token ? config.token.trim() : "";
    const normalized = normalizeRepoConfig(config.owner, config.repo);
    this.owner = normalized.owner;
    this.repo = normalized.repo;
    this.branch = config.branch ? config.branch.trim() : "main";
    this.requestFn = config.requestFn || requestUrl;
  }

  /**
   * Helper to perform authenticated HTTP requests to GitHub REST API with retries and token redaction.
   */
  private async request<T>(
    endpoint: string,
    options?: { method?: "GET" | "POST" | "PATCH"; body?: unknown; headers?: Record<string, string> }
  ): Promise<T> {
    const method = options?.method || "GET";

    // Offline preflight check
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new GitHubError(
        "Device is offline (network disconnected or airplane mode).",
        0,
        undefined,
        this.token
      );
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
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;

      try {
        const response = await this.requestFn({
          url,
          method,
          headers,
          body: serializedBody,
          throw: false,
        });

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
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`
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
      }
    );
  }

  public async getBranch(branchName?: string, bypassCache = false): Promise<GitHubBranchResponse> {
    const target = branchName || this.branch;
    const url = bypassCache
      ? `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(target)}?t=${Date.now()}`
      : `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(target)}`;
    const options = bypassCache
      ? {
          method: "GET" as const,
          headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
          },
        }
      : undefined;
    return this.request<GitHubBranchResponse>(url, options);
  }

  /**
   * Fetches the full Git tree recursively for a given commit or tree SHA.
   */
  public async getTreeRecursive(treeSha: string): Promise<GitHubTreeResponse> {
    return this.request<GitHubTreeResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`
    );
  }

  /**
   * Fetches a raw blob object from GitHub Git Data API.
   */
  public async getBlob(blobSha: string): Promise<GitHubBlobResponse> {
    return this.request<GitHubBlobResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs/${encodeURIComponent(blobSha)}`
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
  public async listUserRepositories(perPage = 100): Promise<GitHubRepoSummary[]> {
    const rawRepos = await this.request<Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      default_branch: string;
      private: boolean;
      description?: string | null;
    }>>(`/user/repos?per_page=${perPage}&sort=updated`, {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    });

    return rawRepos.map((r) => ({
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      defaultBranch: r.default_branch || "main",
      isPrivate: !!r.private,
      description: r.description || undefined,
    }));
  }

  /**
   * Lists branches for a repository.
   * Uses GET /repos/{owner}/{repo}/branches?per_page=100
   */
  public async listBranches(owner?: string, repo?: string): Promise<GitHubBranchSummary[]> {
    const targetOwner = (owner || this.owner).trim();
    const targetRepo = (repo || this.repo).trim();
    const rawBranches = await this.request<Array<{
      name: string;
      commit: { sha: string };
      protected?: boolean;
    }>>(
      `/repos/${encodeURIComponent(targetOwner)}/${encodeURIComponent(targetRepo)}/branches?per_page=100`,
      {
        method: "GET",
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );

    return rawBranches.map((b) => ({
      name: b.name,
      commitSha: b.commit.sha,
      protected: b.protected,
    }));
  }

}
