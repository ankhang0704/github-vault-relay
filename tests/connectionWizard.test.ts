import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "../src/github/githubClient";

describe("GitHub Connection Wizard & Repository Discovery (CONN-001..009)", () => {
  it("CONN-001: listUserRepositories discovers repositories with privacy and default branches", async () => {
    const fakeRepos = [
      {
        full_name: "octocat/my-vault",
        name: "my-vault",
        owner: { login: "octocat" },
        default_branch: "main",
        private: true,
        description: "My personal notes",
      },
      {
        full_name: "octocat/public-wiki",
        name: "public-wiki",
        owner: { login: "octocat" },
        default_branch: "master",
        private: false,
        description: null,
      },
    ];

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/user/repos")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: fakeRepos,
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({
      token: "dummy_token",
      owner: "",
      repo: "",
      branch: "main",
      requestFn: fakeRequestFn,
    });

    const repos = await client.listUserRepositories();
    expect(repos.length).toBe(2);
    expect(repos[0].fullName).toBe("octocat/my-vault");
    expect(repos[0].isPrivate).toBe(true);
    expect(repos[0].defaultBranch).toBe("main");
    expect(repos[1].fullName).toBe("octocat/public-wiki");
    expect(repos[1].isPrivate).toBe(false);
    expect(repos[1].defaultBranch).toBe("master");
  });

  it("CONN-002: listBranches lists all branches for a given repository", async () => {
    const fakeBranches = [
      { name: "main", commit: { sha: "sha_main" }, protected: true },
      { name: "feature", commit: { sha: "sha_feat" }, protected: false },
    ];

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: fakeBranches,
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({
      token: "dummy_token",
      owner: "octocat",
      repo: "my-vault",
      branch: "main",
      requestFn: fakeRequestFn,
    });

    const branches = await client.listBranches("octocat", "my-vault");
    expect(branches.length).toBe(2);
    expect(branches[0].name).toBe("main");
    expect(branches[0].protected).toBe(true);
    expect(branches[1].name).toBe("feature");
  });

  it("CONN-003: Allows /user/repos queries even when owner and repo are blank", async () => {
    const fakeRequestFn = vi.fn(async () => ({
      status: 200,
      headers: {},
      text: "",
      arrayBuffer: new ArrayBuffer(0),
      json: [],
    }));

    const client = new GitHubClient({
      token: "valid_pat",
      owner: "",
      repo: "",
      branch: "main",
      requestFn: fakeRequestFn,
    });

    const repos = await client.listUserRepositories();
    expect(repos).toEqual([]);
  });

  it("CONN-004: testConnection validates permissions and default branch", async () => {
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_sha_xyz" } },
        };
      }
      if (params.url.includes("/repos/octocat/notes")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            id: 1,
            name: "notes",
            full_name: "octocat/notes",
            private: true,
            default_branch: "main",
            permissions: { push: true, pull: true },
          },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({
      token: "test_token",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: fakeRequestFn,
    });

    const testRes = await client.testConnection();
    expect(testRes.success).toBe(true);
    expect(testRes.canPush).toBe(true);
    expect(testRes.canPull).toBe(true);
    expect(testRes.targetBranchSha).toBe("commit_sha_xyz");
  });

  it("CONN-005: Token error / missing PAT throws human-readable message with token redacted", async () => {
    const client = new GitHubClient({
      token: "",
      owner: "octocat",
      repo: "notes",
      branch: "main",
    });

    await expect(client.getRepo()).rejects.toThrow(/GitHub token is missing/);
  });
  it("CONN-006: listUserRepositories paginates automatically beyond 100 repositories", async () => {
    let callCount = 0;
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      callCount++;
      if (params.url.includes("page=1&") || params.url.endsWith("page=1")) {
        // Return 100 items on page 1
        const page1 = Array.from({ length: 100 }, (_, i) => ({
          full_name: `user/repo-${i}`,
          name: `repo-${i}`,
          owner: { login: "user" },
          default_branch: "main",
          private: false,
        }));
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: page1 };
      }
      if (params.url.includes("page=2&") || params.url.endsWith("page=2")) {
        // Return 10 items on page 2 (terminating page)
        const page2 = Array.from({ length: 10 }, (_, i) => ({
          full_name: `user/repo-${100 + i}`,
          name: `repo-${100 + i}`,
          owner: { login: "user" },
          default_branch: "main",
          private: false,
        }));
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: page2 };
      }
      return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: [] };
    });

    const client = new GitHubClient({ token: "tok", owner: "", repo: "", branch: "main", requestFn: fakeRequestFn });
    const repos = await client.listUserRepositories();
    expect(repos.length).toBe(110);
    expect(callCount).toBe(2);
  });

  it("CONN-007: listBranches paginates automatically beyond 100 branches", async () => {
    let callCount = 0;
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      callCount++;
      if (params.url.includes("page=1&") || params.url.endsWith("page=1")) {
        const page1 = Array.from({ length: 100 }, (_, i) => ({
          name: `branch-${i}`,
          commit: { sha: `sha-${i}` },
          protected: false,
        }));
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: page1 };
      }
      if (params.url.includes("page=2&") || params.url.endsWith("page=2")) {
        const page2 = Array.from({ length: 5 }, (_, i) => ({
          name: `branch-${100 + i}`,
          commit: { sha: `sha-${100 + i}` },
          protected: false,
        }));
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: page2 };
      }
      return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: [] };
    });

    const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main", requestFn: fakeRequestFn });
    const branches = await client.listBranches("owner", "repo");
    expect(branches.length).toBe(105);
    expect(callCount).toBe(2);
  });

  it("CONN-008: Offline detection aborts wizard actions safely without unhandled error", async () => {
    const originalNavigator = globalThis.navigator;
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        configurable: true,
      });

      const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main" });
      await expect(client.listUserRepositories()).rejects.toThrow(/Device is offline/);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
      });
    }
  });

  it("CONN-009: Missing Contents permission on testConnection provides actionable advice", async () => {
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        throw new Error("HTTP 403: Resource not accessible by personal access token");
      }
      return {
        status: 200,
        headers: {},
        text: "",
        arrayBuffer: new ArrayBuffer(0),
        json: {
          full_name: "owner/repo",
          default_branch: "main",
          private: true,
          permissions: { push: false, pull: true },
        },
      };
    });

    const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main", requestFn: fakeRequestFn });
    const result = await client.testConnection();
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("branch 'main' was not found or could not be accessed");
  });
});
