import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import { UnifiedSyncEngine } from "../src/sync/unifiedSyncEngine";
import { GitHubClient } from "../src/github/githubClient";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { StorageManager } from "../src/sync/storageManager";

describe("Unified Safe Sync Engine (SYNC-001..010)", () => {
  let app: App;
  const settings = {
    owner: "octocat",
    repo: "notes",
    branch: "main",
    excludedPaths: [],
  };

  beforeEach(() => {
    app = new App();
  });

  it("SYNC-001: Pull-only scenario runs Pull, skips Push, updates baseline", async () => {
    const remoteContent = "# Remote Only Note\n";
    const remoteSha = await calculateCanonicalGitBlobSha(remoteContent, "remote.md");

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_sync1", commit: { tree: { sha: "tree_sync1" } } } },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_sync1",
            truncated: false,
            tree: [{ path: "remote.md", mode: "100644", type: "blob", sha: remoteSha, size: remoteContent.length }],
          },
        };
      }
      if (params.url.includes("/git/blobs/" + remoteSha)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: remoteSha,
            size: remoteContent.length,
            encoding: "base64",
            content: Buffer.from(remoteContent).toString("base64"),
          },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const result = await unified.executeSync();
    expect(result.status).toBe("PASS");
    expect(result.pulledCount).toBe(1);
    expect(result.pushedCount).toBe(0);

    // Local file was written
    expect(app.vault.getAbstractFileByPath("remote.md")).not.toBeNull();

    // Baseline updated
    const state = await StorageManager.loadState(app);
    expect(state.files["remote.md"]).toBeDefined();
  });

  it("SYNC-002: Push-only scenario skips Pull, executes Safe Push (1 commit), updates baseline", async () => {
    const noteContent = "# Local Note\n";
    await app.vault.create("local.md", noteContent);
    const expectedSha = await calculateRawGitBlobSha(new TextEncoder().encode(noteContent));
    let patchRefCalled = false;

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_sync2", commit: { tree: { sha: "tree_sync2" } } } },
        };
      }
      if (params.url.includes("/git/trees/commit_new_push")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "new_tree_sha",
            truncated: false,
            tree: [{ path: "local.md", mode: "100644", type: "blob", sha: expectedSha, size: noteContent.length }],
          },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "new_tree_sha" },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_sync2", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: expectedSha },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_push" },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        patchRefCalled = true;
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_push" } },
        };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_push" } },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const result = await unified.executeSync();
    expect(result.status).toBe("PASS");
    expect(result.pulledCount).toBe(0);
    expect(result.pushedCount).toBe(1);
    expect(patchRefCalled).toBe(true);

    const state = await StorageManager.loadState(app);
    expect(state.lastSyncedCommitSha).toBe("commit_new_push");
  });

  it("SYNC-004: Up-to-date repository returns PASS with 0 pulled and 0 pushed", async () => {
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_clean", commit: { tree: { sha: "tree_clean" } } } },
        };
      }
      if (params.url.includes("/git/trees/tree_clean")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_clean", truncated: false, tree: [] },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const result = await unified.executeSync();
    expect(result.status).toBe("PASS");
    expect(result.pulledCount).toBe(0);
    expect(result.pushedCount).toBe(0);
    expect(result.summaryMessage).toContain("up to date");
  });

  it("SYNC-008: Concurrency lock prevents overlapping duplicate sync executions", async () => {
    let delayResolve: () => void;
    const delayPromise = new Promise<void>((r) => { delayResolve = r; });

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      await delayPromise;
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c", commit: { tree: { sha: "t" } } } },
        };
      }
      if (params.url.includes("/git/trees/t")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "t", truncated: false, tree: [] },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const firstSync = unified.executeSync();
    expect(unified.isRunning).toBe(true);

    // Second overlapping sync immediately throws
    await expect(unified.executeSync()).rejects.toThrow(/already in progress/);

    delayResolve!();
    await firstSync;
    expect(unified.isRunning).toBe(false);
  });
});
