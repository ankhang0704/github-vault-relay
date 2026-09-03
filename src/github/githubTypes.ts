/**
 * GitHub API Response Types for GitHub Vault Relay
 */

export interface GitHubRepoPermissions {
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
  triage?: boolean;
  pull?: boolean;
}

export interface GitHubRepoResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  permissions?: GitHubRepoPermissions;
  description?: string | null;
}

export interface GitHubBranchCommit {
  sha: string;
  url: string;
  commit?: {
    tree: {
      sha: string;
      url: string;
    };
    message?: string;
  };
}

export interface GitHubBranchResponse {
  name: string;
  commit: GitHubBranchCommit;
  protected?: boolean;
}

export interface GitHubTreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
  url?: string;
}

export interface GitHubTreeResponse {
  sha: string;
  url: string;
  tree: GitHubTreeItem[];
  truncated: boolean;
}

export interface GitHubBlobResponse {
  sha: string;
  node_id?: string;
  size: number;
  url: string;
  content: string;
  encoding: "base64" | "utf-8";
}

export interface GitHubCreateBlobResponse {
  sha: string;
  url: string;
}

export interface GitHubTreeItemInput {
  path: string;
  mode: "100644" | "100755" | "040000" | string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

export interface GitHubCreateTreeResponse {
  sha: string;
  url: string;
  tree: GitHubTreeItem[];
  truncated?: boolean;
}

export interface GitHubCommitResponse {
  sha: string;
  url: string;
  message: string;
  tree: {
    sha: string;
    url?: string;
  };
  parents: Array<{
    sha: string;
    url?: string;
  }>;
}

export interface GitHubRefResponse {
  ref: string;
  node_id?: string;
  url: string;
  object: {
    sha: string;
    type: string;
    url?: string;
  };
}

export interface GitHubConnectionTestResult {
  success: boolean;
  repoFullName: string;
  defaultBranch: string;
  targetBranch: string;
  targetBranchSha?: string;
  canPush: boolean;
  canPull: boolean;
  isPrivate: boolean;
  errorMessage?: string;
}

export interface GitHubRepoSummary {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  description?: string;
}

export interface GitHubBranchSummary {
  name: string;
  commitSha: string;
  protected?: boolean;
}
