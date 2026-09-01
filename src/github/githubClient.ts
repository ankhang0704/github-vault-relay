/**
 * GitHub API Client for Vault Relay
 *
 * Uses Obsidian requestUrl() (or injectable request function)
 * to communicate directly with api.github.com without Node dependencies.
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
  GitHubBranchResponse,
  GitHubConnectionTestResult,
  GitHubRepoResponse,
  GitHubTreeResponse,
} from "./githubTypes";
import { sanitizeErrorMessage, redactTokens } from "../security/redact";

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

export interface GitHubClientConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  requestFn?: GitHubRequestFn;
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
    this.owner = config.owner ? config.owner.trim() : "";
    this.repo = config.repo ? config.repo.trim() : "";
    this.branch = config.branch ? config.branch.trim() : "main";
    this.requestFn = config.requestFn || requestUrl;
  }

  /**
   * Helper to perform authenticated HTTP requests to GitHub REST API.
   */
  private async request<T>(endpoint: string, options: Partial<RequestUrlParam> = {}): Promise<T> {
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
      ...(options.headers || {}),
    };

    try {
      const response = await this.requestFn({
        url,
        method: options.method || "GET",
        headers,
        body: options.body,
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
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
      }

      return response.json as T;
    } catch (err) {
      if (err instanceof GitHubError) {
        throw err;
      }
      const sanitized = sanitizeErrorMessage(err, this.token);
      throw new GitHubError(`GitHub request error: ${sanitized}`, undefined, undefined, this.token);
    }
  }

  /**
   * Fetches repository metadata.
   */
  public async getRepo(): Promise<GitHubRepoResponse> {
    return this.request<GitHubRepoResponse>(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`);
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
          errorMessage: `Repository found, but branch '${this.branch}' was not found or could not be accessed: ${sanitizeErrorMessage(branchErr, this.token)}`,
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
