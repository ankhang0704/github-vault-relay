/**
 * GitHub API Response Types
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
