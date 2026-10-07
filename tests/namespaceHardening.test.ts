import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import { StorageManager } from "../src/sync/storageManager";
import { isPathExcluded } from "../src/sync/pathFilter";
import { validatePathSafety } from "../src/sync/pathSafety";
import { classifySyncState } from "../src/sync/syncClassifier";
import { PushEngine } from "../src/sync/pushEngine";
import { PullEngine } from "../src/sync/pullEngine";
import { GitHubClient } from "../src/github/githubClient";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";

describe("Internal Storage Namespace Hardening (NS-001..005)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("NS-001: User-created _vault-relay/file.md is not excluded or rejected", () => {
    const userPath = "_vault-relay/project.md";
    expect(isPathExcluded(userPath)).toBe(false);
    expect(validatePathSafety(userPath).valid).toBe(true);
  });

  it("NS-002: User-created _vault-relay/file.md classifies as LOCAL_ONLY", async () => {
    const filePath = "_vault-relay/personal-notes.md";
    const content = "# My Personal Notes\nNot plugin state.";
    await app.vault.create(filePath, content);

    const localSha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), filePath);
    const localFiles = new Map([[filePath, { path: filePath, mtime: 1000, size: content.length, sha: localSha }]]);
    const remoteBlobs = new Map();
    const emptyState = { version: 1, files: {} };

    const report = classifySyncState({ localFiles, remoteBlobs, state: emptyState, excludedPaths: [] });

    expect(report.counts.LOCAL_ONLY).toBe(1);
    const item = report.items.find((i) => i.path === filePath);
    expect(item).toBeDefined();
    expect(item?.category).toBe("LOCAL_ONLY");
  });

  it("NS-003: User-created _vault-relay/file.md pushes normally and establishes baseline", async () => {
    const filePath = "_vault-relay/todo.md";
    const content = "# Tasks\n- Task 1";
    await app.vault.create(filePath, content);

    const localSha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), filePath);

    let currentBranchSha = "head_commit_1";
    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string; body?: unknown }) => {
      const method = params.method || "GET";
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: currentBranchSha } },
        };
      }
      if (params.url.includes("/git/trees/head_commit_1")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "base_tree_1", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/trees/new_commit_sha")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "new_tree_sha", truncated: false, tree: [{ path: filePath, type: "blob", sha: localSha }] },
        };
      }
      if (params.url.includes("/git/blobs") && method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/trees") && method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "new_tree_sha" } };
      }
      if (params.url.includes("/git/commits") && method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "new_commit_sha" } };
      }
      if ((params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) && method === "GET") {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: currentBranchSha, type: "commit" } },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && method === "PATCH") {
        currentBranchSha = "new_commit_sha";
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { object: { sha: "new_commit_sha" } } };
      }
      throw new Error("Unhandled endpoint: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main", requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, { owner: "owner", repo: "repo", branch: "main", excludedPaths: [] }, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.pushedCreated).toBe(1);

    const canonicalState = await StorageManager.loadState(app);
    expect(canonicalState.files[filePath]).toBeDefined();
    expect(canonicalState.files[filePath].localSha).toBe(localSha);
  }, 15000);

  it("NS-004: Plugin never recreates root _vault-relay or .obsidian/vault-relay during conflict", async () => {
    // Trigger conflict during Safe Pull
    await app.vault.create("ConflictFile.md", "Local Notes");
    const remoteContent = "Remote Different Notes";
    const remoteSha = await calculateRawGitBlobSha(new TextEncoder().encode(remoteContent));

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c_head", commit: { tree: { sha: "t_head" } } } },
        };
      }
      if (params.url.includes("/git/trees/t_head")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "t_head",
            truncated: false,
            tree: [{ path: "ConflictFile.md", mode: "100644", type: "blob", sha: remoteSha, size: remoteContent.length }],
          },
        };
      }
      if (params.url.includes("/git/blobs/" + remoteSha)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: remoteSha, size: remoteContent.length, encoding: "utf-8", content: remoteContent },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main", requestFn: fakeRequestFn });
    const pullEngine = new PullEngine(app, { owner: "owner", repo: "repo", branch: "main", excludedPaths: [] }, client);

    const report = await pullEngine.executeSafePull();
    expect(report.counts.conflictsPreserved).toBe(1);

    // Neither legacy nor intermediate path was created
    expect(await app.vault.adapter.exists("_vault-relay")).toBe(false);
    expect(await app.vault.adapter.exists(".obsidian/vault-relay")).toBe(false);

    // Canonical storage was used
    expect(await app.vault.adapter.exists(".obsidian/github-vault-relay/conflicts")).toBe(true);
  });

  it("NS-005: Final state survives restart", async () => {
    const state = {
      version: 1,
      lastSyncedCommitSha: "persistent_commit_sha",
      lastSyncedAt: 999999999,
      files: {
        "PersistentNote.md": { localSha: "p1", remoteSha: "p1", syncedAt: 999999999 },
      },
    };

    await StorageManager.saveState(app, state);

    // Simulate complete plugin restart / reload
    const reloaded = await StorageManager.loadState(app);
    expect(reloaded.version).toBe(1);
    expect(reloaded.lastSyncedCommitSha).toBe("persistent_commit_sha");
    expect(reloaded.files["PersistentNote.md"].localSha).toBe("p1");
  });
});
