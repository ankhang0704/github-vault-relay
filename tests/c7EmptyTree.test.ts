/**
 * C7 Empty-Tree Repository & Zero-File Acceptance Test Suite (tests/c7EmptyTree.test.ts)
 *
 * Verifies that a synchronized repository legitimately handles zero files / empty tree
 * without workarounds (.gitkeep, README), preserving branch, history, and ref safety.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, PluginManifest, RequestUrlParam } from "obsidian";
import VaultRelayPlugin from "../src/main";
import { GitHubClient, base64ToUint8Array } from "../src/github/githubClient";
import { PushEngine } from "../src/sync/pushEngine";
import { PullEngine } from "../src/sync/pullEngine";
import { SyncEngine } from "../src/sync/syncEngine";
import { StorageManager } from "../src/sync/storageManager";
import { setStoredPat } from "../src/security/secretStore";
import { CANONICAL_EMPTY_TREE_SHA, calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { computeSemanticPreview } from "../src/sync/semanticSummary";
import { classifySyncState } from "../src/sync/syncClassifier";
import { SyncStateData, FileSyncStateEntry } from "../src/sync/syncTypes";

function createTestState(files: Record<string, FileSyncStateEntry> = {}, commitSha = "commit_base_001"): SyncStateData {
  return {
    version: 1,
    lastSyncedCommitSha: commitSha,
    lastSyncedAt: Date.now() - 10000,
    files,
  };
}

describe("C7 — Empty Tree & Release Readiness (C7-EMPTY-001..017)", () => {
  let app: App;
  let plugin: VaultRelayPlugin;
  const owner = "octocat";
  const repo = "notes";
  const branch = "main";
  const token = "github_pat_valid_token_123";

  beforeEach(async () => {
    app = new App();
    const manifest: PluginManifest = {
      id: "github-vault-relay",
      name: "GitHub Vault Relay",
      version: "0.6.1",
      minAppVersion: "0.15.0",
      description: "A conservative GitHub bridge for Obsidian Mobile.",
      author: "Vault Relay Contributors",
    };
    plugin = new VaultRelayPlugin(app, manifest);
    plugin.settings = {
      owner,
      repo,
      branch,
      excludedPaths: [".obsidian/", ".git/", "_fit/", ".trash/"],
    };
    await setStoredPat(app, owner, repo, token);
  });

  it("C7-EMPTY-001 & C7-EMPTY-002: delete final remote file from local -> resulting root tree has zero entries", async () => {
    const lastFilePath = "final-note.md";
    const initialBlobSha = "blob_sha_final_001";
    const baseCommitSha = "commit_base_001";
    const baseTreeSha = "tree_sha_single_file_001";

    await StorageManager.saveState(
      app,
      createTestState({
        [lastFilePath]: {
          localSha: initialBlobSha,
          remoteSha: initialBlobSha,
          syncedAt: Date.now() - 10000,
        },
      }, baseCommitSha)
    );

    const requests: RequestUrlParam[] = [];
    let currentCommitSha = baseCommitSha;
    let currentTreeSha = baseTreeSha;

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      requests.push(params);

      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: currentCommitSha,
              commit: {
                tree: { sha: currentTreeSha },
                message: "baseline commit",
              },
            },
          },
        };
      }

      if (params.url.includes("/git/trees/") && (!params.method || params.method === "GET")) {
        if (params.url.includes(CANONICAL_EMPTY_TREE_SHA)) {
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: CANONICAL_EMPTY_TREE_SHA, tree: [], truncated: false },
          };
        }
        if (params.url.includes(currentCommitSha) && currentTreeSha === CANONICAL_EMPTY_TREE_SHA) {
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: CANONICAL_EMPTY_TREE_SHA, tree: [], truncated: false },
          };
        }
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: baseTreeSha,
            tree: [{ path: lastFilePath, mode: "100644", type: "blob", sha: initialBlobSha, size: 50 }],
            truncated: false,
          },
        };
      }

      if (params.url.includes("/git/commits") && params.method === "POST") {
        const body = JSON.parse(params.body as string);
        currentCommitSha = "commit_empty_tree_sha_002";
        currentTreeSha = body.tree;
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: currentCommitSha,
            tree: { sha: body.tree },
            parents: body.parents.map((p: string) => ({ sha: p })),
            message: body.message,
          },
        };
      }

      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            ref: "refs/heads/main",
            object: { sha: currentCommitSha, type: "commit" },
          },
        };
      }

      if (params.url.includes("/git/ref/heads/main") && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            ref: "refs/heads/main",
            object: { sha: currentCommitSha, type: "commit" },
          },
        };
      }

      throw new Error(`Unhandled mock request: ${params.method} ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.pushedDeleted).toBe(1);

    // C7-EMPTY-001: Commit was created directly with CANONICAL_EMPTY_TREE_SHA without failing createTree
    const commitReq = requests.find((r) => r.url.includes("/git/commits") && r.method === "POST");
    expect(commitReq).toBeDefined();
    const commitBody = JSON.parse(commitReq!.body as string);
    expect(commitBody.tree).toBe(CANONICAL_EMPTY_TREE_SHA);

    // C7-EMPTY-002: Resulting root tree has zero entries
    const postTreeReq = requests.find((r) => r.url.includes("/git/trees") && r.method === "POST");
    expect(postTreeReq).toBeUndefined(); // Did NOT call failing POST /git/trees

    // Baseline is now empty
    const state = await StorageManager.loadState(app);
    expect(Object.keys(state.files).length).toBe(0);
    expect(state.lastSyncedCommitSha).toBe("commit_empty_tree_sha_002");
  });

  it("C7-EMPTY-003, C7-EMPTY-004 & C7-EMPTY-005: branch exists, parent history preserved, baseline is zero", async () => {
    const lastFilePath = "note.md";
    const initialBlobSha = "sha_initial";
    const baseCommit = "commit_111";

    await StorageManager.saveState(
      app,
      createTestState({ [lastFilePath]: { localSha: initialBlobSha, remoteSha: initialBlobSha, syncedAt: Date.now() } }, baseCommit)
    );

    let patchRefBody: { sha?: string; force?: boolean } = {};
    let commitParent: string[] = [];

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: baseCommit,
              commit: { tree: { sha: "tree_one_file" } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/") && (!params.method || params.method === "GET")) {
        const isEmpty = params.url.includes(CANONICAL_EMPTY_TREE_SHA) || params.url.includes("commit_empty_002");
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: isEmpty ? CANONICAL_EMPTY_TREE_SHA : "tree_one_file",
            tree: isEmpty ? [] : [{ path: lastFilePath, type: "blob", sha: initialBlobSha, mode: "100644" }],
            truncated: false,
          },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        const parsed = JSON.parse(params.body as string);
        commitParent = parsed.parents;
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_empty_002", tree: { sha: parsed.tree } },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        patchRefBody = JSON.parse(params.body as string);
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { object: { sha: "commit_empty_002" } },
        };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");

    // C7-EMPTY-003: Branch updated via non-force PATCH
    expect(patchRefBody.force).toBe(false);

    // C7-EMPTY-004: Parent history intact
    expect(commitParent).toEqual([baseCommit]);

    // C7-EMPTY-005: Baseline is zero entries
    const state = await StorageManager.loadState(app);
    expect(Object.keys(state.files).length).toBe(0);
  });

  it("C7-EMPTY-006: zero-file dashboard is clean with '0 files synchronized'", () => {
    const preview = computeSemanticPreview([]);
    expect(preview.unchanged).toBe(0);
    expect(preview.totalPushMutations).toBe(0);
    expect(preview.totalPullMutations).toBe(0);
    expect(preview.totalSemanticMoves).toBe(0);
    expect(preview.totalConflicts).toBe(0);

    const classification = classifySyncState({
      localFiles: new Map(),
      remoteBlobs: new Map(),
      state: createTestState({}, "commit_empty"),
    });

    expect(classification.items.length).toBe(0);
    expect(classification.counts.UNCHANGED).toBe(0);
  });

  it("C7-EMPTY-007: create first file after empty convergence", async () => {
    const emptyCommitSha = "commit_empty_state";
    await StorageManager.saveState(app, createTestState({}, emptyCommitSha));

    const newNoteContent = "# My First Note\nThis note is created after empty state.\n";
    await app.vault.create("first-new-note.md", newNoteContent);
    const expectedBlobSha = await calculateRawGitBlobSha(new TextEncoder().encode(newNoteContent));

    let createdTreeBase: string | undefined;
    let commitParent: string[] = [];

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: emptyCommitSha,
              commit: { tree: { sha: CANONICAL_EMPTY_TREE_SHA } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/") && (!params.method || params.method === "GET")) {
        if (params.url.includes(CANONICAL_EMPTY_TREE_SHA)) {
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: CANONICAL_EMPTY_TREE_SHA, tree: [], truncated: false },
          };
        }
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "new_tree_sha_001",
            tree: [{ path: "first-new-note.md", type: "blob", sha: expectedBlobSha, mode: "100644" }],
            truncated: false,
          },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: expectedBlobSha },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        const body = JSON.parse(params.body as string);
        createdTreeBase = body.base_tree;
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "new_tree_sha_001" },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        const body = JSON.parse(params.body as string);
        commitParent = body.parents;
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_first_file_001", tree: { sha: body.tree } },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { object: { sha: "commit_first_file_001" } },
        };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.pushedCreated).toBe(1);

    expect(createdTreeBase).toBe(CANONICAL_EMPTY_TREE_SHA);
    expect(commitParent).toEqual([emptyCommitSha]);

    const state = await StorageManager.loadState(app);
    expect(Object.keys(state.files).length).toBe(1);
    expect(state.files["first-new-note.md"].localSha).toBe(expectedBlobSha);
  });

  it("C7-EMPTY-008: external actor deletes final remote file -> pull classifies REMOTE_DELETED and cleans up", async () => {
    const fileContent = "Final remaining file.";
    await app.vault.create("final.md", fileContent);
    const blobSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    await StorageManager.saveState(
      app,
      createTestState({
        "final.md": { localSha: blobSha, remoteSha: blobSha, syncedAt: Date.now() },
      }, "commit_prior")
    );

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: "commit_external_empty",
              commit: { tree: { sha: CANONICAL_EMPTY_TREE_SHA } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: CANONICAL_EMPTY_TREE_SHA, tree: [], truncated: false },
        };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pullEngine = new PullEngine(app, plugin.settings, client);

    const report = await pullEngine.executeSafePull();
    expect(report.status).toBe("PASS");
    expect(report.counts.pulledDeleted).toBe(1);

    expect(app.vault.getAbstractFileByPath("final.md")).toBeNull();

    const state = await StorageManager.loadState(app);
    expect(Object.keys(state.files).length).toBe(0);
    expect(state.lastSyncedCommitSha).toBe("commit_external_empty");
  });

  it("C7-EMPTY-009: stale device converges to empty without resurrection", async () => {
    const fileContent = "Stale note content.";
    await app.vault.create("stale.md", fileContent);
    const blobSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    await StorageManager.saveState(
      app,
      createTestState({
        "stale.md": { localSha: blobSha, remoteSha: blobSha, syncedAt: Date.now() - 50000 },
      }, "commit_stale_prior")
    );

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: "commit_remote_empty",
              commit: { tree: { sha: CANONICAL_EMPTY_TREE_SHA } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: CANONICAL_EMPTY_TREE_SHA, tree: [], truncated: false },
        };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const syncEngine = new SyncEngine(app, plugin.settings, client);
    const preview = await syncEngine.generatePreview();

    expect(preview.items.length).toBe(1);
    expect(preview.items[0].category).toBe("REMOTE_DELETED");
    expect(preview.items[0].path).toBe("stale.md");

    const pullEngine = new PullEngine(app, plugin.settings, client);
    const pullReport = await pullEngine.executeSafePull();
    expect(pullReport.status).toBe("PASS");
    expect(app.vault.getAbstractFileByPath("stale.md")).toBeNull();

    const previewAfter = await syncEngine.generatePreview();
    expect(previewAfter.items.length).toBe(0);
  });

  it("C7-EMPTY-010: both sides deleted final file -> converged DELETED removes baseline", async () => {
    await StorageManager.saveState(
      app,
      createTestState({
        "converged.md": { localSha: "sha1", remoteSha: "sha1", syncedAt: Date.now() - 10000 },
      }, "commit_old")
    );

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: "commit_empty_converged",
              commit: { tree: { sha: CANONICAL_EMPTY_TREE_SHA } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: CANONICAL_EMPTY_TREE_SHA, tree: [], truncated: false },
        };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const syncEngine = new SyncEngine(app, plugin.settings, client);
    const preview = await syncEngine.generatePreview();

    expect(preview.items.length).toBe(1);
    expect(preview.items[0].category).toBe("DELETED");

    const pullEngine = new PullEngine(app, plugin.settings, client);
    const report = await pullEngine.executeSafePull();
    expect(report.status).toBe("PASS");

    const state = await StorageManager.loadState(app);
    expect(Object.keys(state.files).length).toBe(0);
  });

  it("C7-EMPTY-011: modified-local vs empty-remote becomes DELETE_CONFLICT", async () => {
    const modifiedContent = "# Modified Content\nLocally changed.";
    await app.vault.create("conflict-note.md", modifiedContent);

    await StorageManager.saveState(
      app,
      createTestState({
        "conflict-note.md": { localSha: "sha_original", remoteSha: "sha_original", syncedAt: Date.now() - 10000 },
      }, "commit_prior")
    );

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: "commit_empty_remote",
              commit: { tree: { sha: CANONICAL_EMPTY_TREE_SHA } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: CANONICAL_EMPTY_TREE_SHA, tree: [], truncated: false },
        };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const syncEngine = new SyncEngine(app, plugin.settings, client);
    const preview = await syncEngine.generatePreview();

    expect(preview.items.length).toBe(1);
    expect(preview.items[0].category).toBe("DELETE_CONFLICT");
    expect(preview.items[0].deleteConflictType).toBe("REMOTE_DELETED_LOCAL_MODIFIED");

    const pullEngine = new PullEngine(app, plugin.settings, client);
    const report = await pullEngine.executeSafePull();
    expect(report.status).toBe("PASS_WITH_WARNINGS");
    expect(report.counts.conflictsPreserved).toBe(1);
    expect(app.vault.getAbstractFileByPath("conflict-note.md")).not.toBeNull();
  });

  it("C7-EMPTY-012: binary final file deletion produces empty tree", async () => {
    const binaryPath = "image.png";
    const binarySha = "sha_binary_blob";
    const baseCommit = "commit_bin_001";

    await StorageManager.saveState(
      app,
      createTestState({ [binaryPath]: { localSha: binarySha, remoteSha: binarySha, syncedAt: Date.now() } }, baseCommit)
    );

    let committedTree: string | undefined;

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: baseCommit,
              commit: { tree: { sha: "tree_bin_single" } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/")) {
        const isEmpty = params.url.includes(CANONICAL_EMPTY_TREE_SHA) || params.url.includes("commit_bin_empty");
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: isEmpty ? CANONICAL_EMPTY_TREE_SHA : "tree_bin_single",
            tree: isEmpty ? [] : [{ path: binaryPath, type: "blob", sha: binarySha, mode: "100644" }],
            truncated: false,
          },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        const parsed = JSON.parse(params.body as string);
        committedTree = parsed.tree;
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_bin_empty" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { object: { sha: "commit_bin_empty" } } };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(committedTree).toBe(CANONICAL_EMPTY_TREE_SHA);
  });

  it("C7-EMPTY-013: _vault-relay final user file deletion produces empty tree", async () => {
    const userFilePath = "_vault-relay/my-notes.md";
    const userBlobSha = "sha_user_note_blob";
    const baseCommit = "commit_user_001";

    await StorageManager.saveState(
      app,
      createTestState({ [userFilePath]: { localSha: userBlobSha, remoteSha: userBlobSha, syncedAt: Date.now() } }, baseCommit)
    );

    let committedTree: string | undefined;

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: baseCommit,
              commit: { tree: { sha: "tree_user_single" } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/")) {
        const isEmpty = params.url.includes(CANONICAL_EMPTY_TREE_SHA) || params.url.includes("commit_user_empty");
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: isEmpty ? CANONICAL_EMPTY_TREE_SHA : "tree_user_single",
            tree: isEmpty ? [] : [{ path: userFilePath, type: "blob", sha: userBlobSha, mode: "100644" }],
            truncated: false,
          },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        const parsed = JSON.parse(params.body as string);
        committedTree = parsed.tree;
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_user_empty" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { object: { sha: "commit_user_empty" } } };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(committedTree).toBe(CANONICAL_EMPTY_TREE_SHA);
  });

  it("C7-EMPTY-014: empty folders generate no placeholder objects or .gitkeep", async () => {
    await app.vault.createFolder("empty-folder");
    await app.vault.createFolder("nested/empty/subfolder");

    const syncEngine = new SyncEngine(app, plugin.settings, new GitHubClient({ token, owner, repo, branch, requestFn: vi.fn() }));
    const localFiles = await (syncEngine as unknown as { scanLocalVault: () => Promise<Map<string, unknown>> }).scanLocalVault();

    expect(localFiles.size).toBe(0);
    expect(localFiles.has("empty-folder")).toBe(false);
    expect(localFiles.has("nested/empty/subfolder")).toBe(false);
    expect(localFiles.has("empty-folder/.gitkeep")).toBe(false);
  });

  it("C7-EMPTY-015: no force ref update on empty tree commit", async () => {
    const lastFilePath = "note.md";
    await StorageManager.saveState(
      app,
      createTestState({ [lastFilePath]: { localSha: "s1", remoteSha: "s1", syncedAt: Date.now() } }, "c1")
    );

    let patchBody: { force?: boolean } = {};
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c1", commit: { tree: { sha: "t1" } } } } };
      }
      if (params.url.includes("/git/trees/")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t1", tree: [{ path: lastFilePath, type: "blob", sha: "s1", mode: "100644" }] } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "c2" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        patchBody = JSON.parse(params.body as string);
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { object: { sha: "c2" } } };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);
    await pushEngine.executeSafePush();

    expect(patchBody.force).toBe(false);
  });

  it("C7-EMPTY-016: no HTTP DELETE endpoint used during empty-tree deletion", async () => {
    const lastFilePath = "note.md";
    await StorageManager.saveState(
      app,
      createTestState({ [lastFilePath]: { localSha: "s1", remoteSha: "s1", syncedAt: Date.now() } }, "c1")
    );

    const usedMethods: string[] = [];
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      usedMethods.push(params.method || "GET");
      if (params.url.includes("/branches/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c1", commit: { tree: { sha: "t1" } } } } };
      }
      if (params.url.includes("/git/trees/")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t1", tree: [{ path: lastFilePath, type: "blob", sha: "s1", mode: "100644" }] } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "c2" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { object: { sha: "c2" } } };
      }
      throw new Error(`Unexpected: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);
    await pushEngine.executeSafePush();

    expect(usedMethods).not.toContain("DELETE");
  });

  it("C7-EMPTY-017 & STRESS (100 cycles): empty -> first file -> empty again repeated cycles", async () => {
    let currentCommitSha = "commit_root";
    let currentTreeSha = CANONICAL_EMPTY_TREE_SHA;
    const remoteFiles: Map<string, string> = new Map();

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: currentCommitSha,
              commit: { tree: { sha: currentTreeSha } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/") && (!params.method || params.method === "GET")) {
        const isEmpty = params.url.includes(CANONICAL_EMPTY_TREE_SHA) || currentTreeSha === CANONICAL_EMPTY_TREE_SHA;
        const treeItems = isEmpty ? [] : Array.from(remoteFiles.entries()).map(([p, s]) => ({
          path: p,
          type: "blob",
          sha: s,
          mode: "100644",
        }));
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: isEmpty ? CANONICAL_EMPTY_TREE_SHA : currentTreeSha,
            tree: treeItems,
            truncated: false,
          },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        const body = JSON.parse(params.body as string);
        const bytes = base64ToUint8Array(body.content);
        const sha = await calculateRawGitBlobSha(bytes);
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        const body = JSON.parse(params.body as string);
        for (const item of body.tree) {
          if (item.sha === null) {
            remoteFiles.delete(item.path);
          } else {
            remoteFiles.set(item.path, item.sha);
          }
        }
        currentTreeSha = "stress_tree_sha";
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: currentTreeSha },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        const body = JSON.parse(params.body as string);
        currentCommitSha = `commit_${Date.now()}_${Math.random()}`;
        currentTreeSha = body.tree;
        if (currentTreeSha === CANONICAL_EMPTY_TREE_SHA) {
          remoteFiles.clear();
        }
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: currentCommitSha, tree: { sha: body.tree } },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { object: { sha: currentCommitSha } },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    await StorageManager.saveState(app, createTestState({}, currentCommitSha));

    // Run 100 alternating cycles: create 1 file -> push (1/1/1) -> delete file -> push (0/0/0)
    for (let i = 0; i < 100; i++) {
      // 1. Create file locally
      const fileName = `stress-note-${i}.md`;
      await app.vault.create(fileName, `Content for cycle ${i}`);

      // Push creation
      const pushCreateReport = await pushEngine.executeSafePush();
      expect(pushCreateReport.status).toBe("PASS");
      expect(pushCreateReport.counts.pushedCreated).toBe(1);

      let state = await StorageManager.loadState(app);
      expect(Object.keys(state.files).length).toBe(1);

      // 2. Delete file locally
      const file = app.vault.getAbstractFileByPath(fileName);
      if (file) await app.vault.delete(file);

      // Push deletion (final file deletion -> 0 files)
      const pushDeleteReport = await pushEngine.executeSafePush();
      expect(pushDeleteReport.status).toBe("PASS");
      expect(pushDeleteReport.counts.pushedDeleted).toBe(1);
      expect(currentTreeSha).toBe(CANONICAL_EMPTY_TREE_SHA);

      state = await StorageManager.loadState(app);
      expect(Object.keys(state.files).length).toBe(0); // 0 baseline drift
    }

    // After 100 cycles:
    const finalState = await StorageManager.loadState(app);
    expect(Object.keys(finalState.files).length).toBe(0);
    expect(remoteFiles.size).toBe(0);
  });
});
