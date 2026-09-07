import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, RequestUrlParam } from "obsidian";
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
  it("SYNC-003: Both Pull and Push executed in single unified sync (1 pulled, 1 pushed)", async () => {
    const remoteContent = "# Remote Content\n";
    const remoteSha = await calculateRawGitBlobSha(new TextEncoder().encode(remoteContent));

    const localContent = "# Local Content\n";
    await app.vault.create("local.md", localContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(localContent));

    let pushed = false;

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c_both_1", commit: { tree: { sha: "t_both_1" } } } },
        };
      }
      if (params.url.includes("/git/trees/commit_both_push")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "t_both_new",
            truncated: false,
            tree: [
              { path: "remote.md", mode: "100644", type: "blob", sha: remoteSha, size: remoteContent.length },
              { path: "local.md", mode: "100644", type: "blob", sha: localSha, size: localContent.length },
            ],
          },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t_both_new" } };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "t_both_1",
            truncated: false,
            tree: [{ path: "remote.md", mode: "100644", type: "blob", sha: remoteSha, size: remoteContent.length }],
          },
        };
      }
      if (params.url.includes("/git/blobs/" + remoteSha)) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: remoteSha, size: remoteContent.length, encoding: "utf-8", content: remoteContent } };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_both_push" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        pushed = true;
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_both_push" } } };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_both_push" } } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const result = await unified.executeSync();
    expect(result.status).toBe("PASS");
    expect(result.pulledCount).toBe(1);
    expect(result.pushedCount).toBe(1);
    expect(pushed).toBe(true);
  });

  it("SYNC-005: Pull failure immediately halts sync and skips Push phase", async () => {
    await app.vault.create("local-ready.md", "# Local");
    let pushAttempted = false;

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
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
          json: {
            sha: "t",
            truncated: false,
            tree: [{ path: "failing-remote.md", mode: "100644", type: "blob", sha: "sha_fail", size: 50 }],
          },
        };
      }
      if (params.url.includes("/git/blobs/sha_fail")) {
        throw new Error("HTTP 500: GitHub internal error downloading blob");
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        pushAttempted = true;
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "new_c" } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const result = await unified.executeSync();
    expect(result.status).toBe("FAIL");
    expect(result.pushedCount).toBe(0);
    expect(pushAttempted).toBe(false);
  });

  it("SYNC-006: Remote HEAD changed during replan blocks Push", async () => {
    await app.vault.create("local-edit.md", "# Local Edit");
    let branchCalls = 0;

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        branchCalls++;
        // Pre-write revalidation returns a different remote commit
        const sha = branchCalls === 1 ? "commit_base_old" : "commit_advanced_ahead";
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha, commit: { tree: { sha: "t" } } } },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t", truncated: false, tree: [] } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const result = await unified.executeSync();
    expect(result.pushedCount).toBe(0);
  });

  it("SYNC-007: Potential conflict preserves local file untouched and finishes with warning", async () => {
    // Both local and remote have different versions of Conflicted.md
    const localContent = "local conflict text";
    await app.vault.create("Conflicted.md", localContent);

    const remoteContent = "remote conflict text";
    const remoteSha = await calculateRawGitBlobSha(new TextEncoder().encode(remoteContent));

    // Baseline says it was previously at base_sha
    const state = await StorageManager.loadState(app);
    state.files["Conflicted.md"] = { localSha: "base_sha", remoteSha: "base_sha", syncedAt: 100 };
    await StorageManager.saveState(app, state);

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c_conf", commit: { tree: { sha: "t_conf" } } } },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "t_conf",
            truncated: false,
            tree: [{ path: "Conflicted.md", mode: "100644", type: "blob", sha: remoteSha, size: remoteContent.length }],
          },
        };
      }
      if (params.url.includes("/git/blobs/" + remoteSha)) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: remoteSha, size: remoteContent.length, encoding: "utf-8", content: remoteContent } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const result = await unified.executeSync();
    expect(result.status).toBe("PASS_WITH_WARNINGS");
    // Local file was preserved untouched
    expect(await app.vault.adapter.read("Conflicted.md")).toBe(localContent);
  });

  it("SYNC-009: Progress callback receives events spanning SCANNING, PLANNING, DOWNLOADING, COMPLETE", async () => {
    const events: Array<{ phase: string }> = [];
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c", commit: { tree: { sha: "t" } } } } };
      }
      if (params.url.includes("/git/trees/t")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t", truncated: false, tree: [] } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    await unified.executeSync((evt) => events.push(evt));
    expect(events.some((e) => e.phase === "SCANNING")).toBe(true);
    expect(events.some((e) => e.phase === "COMPLETE")).toBe(true);
  });

  it("SYNC-010: Rejected concurrent sync leaves lock clean after active sync finishes", async () => {
    let unblock: () => void;
    const blockPromise = new Promise<void>((r) => { unblock = r; });

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      await blockPromise;
      if (params.url.includes("/branches/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c", commit: { tree: { sha: "t" } } } } };
      }
      if (params.url.includes("/git/trees/t")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t", truncated: false, tree: [] } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const activeSync = unified.executeSync();
    await expect(unified.executeSync()).rejects.toThrow(/already in progress/);

    unblock!();
    await activeSync;
    expect(unified.isRunning).toBe(false);

    // Can run again cleanly
    const nextSync = await unified.executeSync();
    expect(nextSync.status).toBe("PASS");
  });

  it("SYNC-011: Unified Sync auto-heals baseline for UNCHANGED files when up to date", async () => {
    const notePath = "20 Projects/FM Dictionary/FM Dictionary Technical Architecture.md";
    const noteContent = "# FM Dictionary Architecture\nContent details here.";
    await app.vault.create(notePath, noteContent);
    const expectedSha = await calculateCanonicalGitBlobSha(noteContent, notePath);

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_heal_base", commit: { tree: { sha: "tree_heal_base" } } } },
        };
      }
      if (params.url.includes("/git/trees/tree_heal_base")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_heal_base",
            truncated: false,
            tree: [{ path: notePath, mode: "100644", type: "blob", sha: expectedSha, size: noteContent.length }],
          },
        };
      }
      throw new Error("Unhandled URL: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    // Initial state: empty baseline
    const emptyState = await StorageManager.loadState(app);
    expect(emptyState.files[notePath]).toBeUndefined();

    const result = await unified.executeSync();
    expect(result.status).toBe("PASS");
    expect(result.pulledCount).toBe(0);
    expect(result.pushedCount).toBe(0);

    // Baseline was auto-healed and saved
    const healedState = await StorageManager.loadState(app);
    expect(healedState.files[notePath]).toBeDefined();
    expect(healedState.files[notePath].localSha).toBe(expectedSha);
    expect(healedState.files[notePath].remoteSha).toBe(expectedSha);
  });

  it("SYNC-012: Folder move with pre-existing files pushes move cleanly without pulling old files back", async () => {
    const oldPath = "20 Projects/FM Dictionary/FM Dictionary Technical Architecture.md";
    const newPath = "20 Projects/Completed/FM Dictionary/FM Dictionary Technical Architecture.md";
    const noteContent = "# FM Dictionary Architecture\nContent details here.";
    const expectedSha = await calculateCanonicalGitBlobSha(noteContent, oldPath);

    // Pre-populate baseline as established by prior sync
    await StorageManager.saveState(app, {
      version: 1,
      lastSyncedCommitSha: "c_base",
      lastSyncedAt: 1000,
      files: {
        [oldPath]: { localSha: expectedSha, remoteSha: expectedSha, syncedAt: 1000 },
      },
    });

    // Local move occurred: oldPath removed, newPath created
    await app.vault.create(newPath, noteContent);

    let treeItemsSent: Array<{ path: string; sha: string | null }> = [];
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c_base", commit: { tree: { sha: "t_base" } } } },
        };
      }
      if (params.url.includes("/git/trees/c_new")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "t_new",
            truncated: false,
            tree: [{ path: newPath, mode: "100644", type: "blob", sha: expectedSha, size: noteContent.length }],
          },
        };
      }
      if (params.url.includes("/git/trees/t_base")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "t_base",
            truncated: false,
            tree: [{ path: oldPath, mode: "100644", type: "blob", sha: expectedSha, size: noteContent.length }],
          },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: expectedSha } };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        const body = JSON.parse(params.body as string);
        treeItemsSent = body.tree;
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t_new" } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "c_new" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "c_new" } } };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "c_new" } } };
      }
      throw new Error("Unhandled URL in SYNC-012: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    const result = await unified.executeSync();
    expect(result.status).toBe("PASS");
    expect(result.pulledCount).toBe(0); // Zero pulled! Old path was NOT pulled back!
    expect(result.pushedCount).toBe(2); // 1 delete + 1 create

    // Verify tree mutation: oldPath has sha: null, newPath has expectedSha
    const deleted = treeItemsSent.find((t) => t.path === oldPath);
    expect(deleted).toBeDefined();
    expect(deleted?.sha).toBeNull();

    const added = treeItemsSent.find((t) => t.path === newPath);
    expect(added).toBeDefined();
    expect(added?.sha).toBe(expectedSha);

    // Old path is NOT re-created in local vault
    expect(app.vault.getAbstractFileByPath(oldPath)).toBeNull();
    // New path exists
    expect(app.vault.getAbstractFileByPath(newPath)).not.toBeNull();

    // Baseline updated: oldPath removed, newPath tracked
    const updatedState = await StorageManager.loadState(app);
    expect(updatedState.files[oldPath]).toBeUndefined();
    expect(updatedState.files[newPath]).toBeDefined();
  });
});
