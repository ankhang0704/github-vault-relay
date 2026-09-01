/**
 * GitHub API Client for Vault Relay
 *
 * Strictly READ-ONLY in Checkpoint 2.
 * Uses Obsidian requestUrl() (or injectable request function)
 * to communicate directly with api.github.com without Node dependencies.
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
  GitHubBlobResponse,
  GitHubBranchResponse,
  GitHubConnectionTestResult,
  GitHubRepoResponse,
  GitHubTreeResponse,
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
  let cleanOwner = (owner || '').trim();
  let cleanRepo = (repo || '').trim();

  if (cleanRepo.startsWith('http://') || cleanRepo.startsWith('https://') || cleanRepo.startsWith('git@')) {
    const urlPattern = /(?:github\.com[/:])([^/]+)\/?([^/.]+)?(?:\.git)?/i;
    const match = cleanRepo.match(urlPattern);
    if (match) {
      cleanOwner = match[1] || cleanOwner;
      cleanRepo = match[2] || '';
    }
  }

  if (cleanRepo.includes('/')) {
    const parts = cleanRepo.split('/').filter(Boolean);
    if (parts.length >= 2) {
      cleanOwner = parts[0];
      cleanRepo = parts[1];
    } else if (parts.length === 1) {
      cleanRepo = parts[0];
    }
  }

  if (cleanOwner.startsWith('http://') || cleanOwner.startsWith('https://')) {
    const match = cleanOwner.match(/github\.com\/([^/]+)/i);
    if (match) {
      cleanOwner = match[1];
    }
  }

  if (cleanRepo.endsWith('.git')) {
    cleanRepo = cleanRepo.slice(0, -4);
  }

  cleanOwner = cleanOwner.replace(/^\/+|\/+$/g, '');
  cleanRepo = cleanRepo.replace(/^\/+|\/+$/g, '');

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
   * Helper to perform authenticated GET HTTP requests to GitHub REST API with retries.
   */
  private async request<T>(endpoint: string): Promise<T> {
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

    if (!this.owner || !this.repo) {
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
    };

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;

      try {
        const response = await this.requestFn({
          url,
          method: "GET",
          headers,
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
  public async getBranch(branchName?: string): Promise<GitHubBranchResponse> {
    const target = branchName || this.branch;
    return this.request<GitHubBranchResponse>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/branches/${encodeURIComponent(target)}`
    );
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
}
