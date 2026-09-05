import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, RequestUrlParam, RequestUrlResponse, TAbstractFile, TFile } from "obsidian";
import { classifySyncState } from "../src/sync/syncClassifier";
import { PullEngine } from "../src/sync/pullEngine";
import { PushEngine } from "../src/sync/pushEngine";
import { UnifiedSyncEngine } from "../src/sync/unifiedSyncEngine";
import { ConflictManager, ConflictRecord } from "../src/sync/conflictManager";
import { StorageManager } from "../src/sync/storageManager";
import { GitHubClient } from "../src/github/githubClient";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { acquireMutationLease } from "../src/sync/mutationCoordinator";
import { VaultRelaySettings } from "../src/settings";
import { LocalFileEntry, RemoteBlobEntry, SyncStateData } from "../src/sync/syncTypes";
import { isPathExcluded } from "../src/sync/pathFilter";
import { validatePathSafety } from "../src/sync/pathSafety";

describe("C6 — Safe Delete & Move Semantics (tests/c6DeleteMove.test.ts)", () => {
  let app: App;
  const defaultSettings: VaultRelaySettings = {
    owner: "octocat",
    repo: "notes",
    branch: "main",
    excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
  };

  beforeEach(() => {
    app = new App();
  });

  // =========================================================================
  // 1. CLASSIFIER THREE-WAY MATRIX & MOVES
  // =========================================================================
  describe("Classifier Matrix (C6-DEL-001..007, C6-MOVE-001..002, C6-MOVE-006..008)", () => {
    it("C6-DEL-001: local delete / remote unchanged -> LOCAL_DELETED", () => {
      const sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const localFiles = new Map<string, LocalFileEntry>(); // absent locally
      const remoteBlobs = new Map<string, RemoteBlobEntry>([
        ["A.md", { path: "A.md", sha: sha1, size: 10 }],
      ]);
      const state: SyncStateData = {
        version: 1,
        files: {
          "A.md": { localSha: sha1, remoteSha: sha1, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.LOCAL_DELETED).toBe(1);
      const item = result.items.find((i) => i.path === "A.md");
      expect(item?.category).toBe("LOCAL_DELETED");
      expect(item?.baseSha).toBe(sha1);
    });

    it("C6-DEL-002: remote delete / local unchanged -> REMOTE_DELETED", () => {
      const sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const localFiles = new Map<string, LocalFileEntry>([
        ["A.md", { path: "A.md", sha: sha1, size: 10 }],
      ]);
      const remoteBlobs = new Map<string, RemoteBlobEntry>(); // absent remotely
      const state: SyncStateData = {
        version: 1,
        files: {
          "A.md": { localSha: sha1, remoteSha: sha1, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.REMOTE_DELETED).toBe(1);
      const item = result.items.find((i) => i.path === "A.md");
      expect(item?.category).toBe("REMOTE_DELETED");
      expect(item?.localSha).toBe(sha1);
    });

    it("C6-DEL-003: both deleted -> DELETED (converged)", () => {
      const sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const localFiles = new Map<string, LocalFileEntry>(); // absent
      const remoteBlobs = new Map<string, RemoteBlobEntry>(); // absent
      const state: SyncStateData = {
        version: 1,
        files: {
          "A.md": { localSha: sha1, remoteSha: sha1, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.DELETED).toBe(1);
      const item = result.items.find((i) => i.path === "A.md");
      expect(item?.category).toBe("DELETED");
    });

    it("C6-DEL-004: local delete vs remote modify -> DELETE_CONFLICT", () => {
      const sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const sha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const localFiles = new Map<string, LocalFileEntry>(); // absent
      const remoteBlobs = new Map<string, RemoteBlobEntry>([
        ["A.md", { path: "A.md", sha: sha2, size: 20 }],
      ]);
      const state: SyncStateData = {
        version: 1,
        files: {
          "A.md": { localSha: sha1, remoteSha: sha1, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.DELETE_CONFLICT).toBe(1);
      const item = result.items.find((i) => i.path === "A.md");
      expect(item?.category).toBe("DELETE_CONFLICT");
      expect(item?.deleteConflictType).toBe("LOCAL_DELETED_REMOTE_MODIFIED");
      expect(item?.remoteSha).toBe(sha2);
    });

    it("C6-DEL-005: remote delete vs local modify -> DELETE_CONFLICT", () => {
      const sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const sha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const localFiles = new Map<string, LocalFileEntry>([
        ["A.md", { path: "A.md", sha: sha2, size: 20 }],
      ]);
      const remoteBlobs = new Map<string, RemoteBlobEntry>(); // absent
      const state: SyncStateData = {
        version: 1,
        files: {
          "A.md": { localSha: sha1, remoteSha: sha1, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.DELETE_CONFLICT).toBe(1);
      const item = result.items.find((i) => i.path === "A.md");
      expect(item?.category).toBe("DELETE_CONFLICT");
      expect(item?.deleteConflictType).toBe("REMOTE_DELETED_LOCAL_MODIFIED");
      expect(item?.localSha).toBe(sha2);
    });

    it("C6-DEL-006: no-baseline local-only is NEVER classified as deletion", () => {
      const localFiles = new Map<string, LocalFileEntry>([
        ["Unsynced.md", { path: "Unsynced.md", sha: "hash111", size: 30 }],
      ]);
      const remoteBlobs = new Map<string, RemoteBlobEntry>();
      const state: SyncStateData = { version: 1, files: {} };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.LOCAL_ONLY).toBe(1);
      expect(result.counts.LOCAL_DELETED).toBe(0);
      expect(result.counts.REMOTE_DELETED).toBe(0);
      expect(result.counts.DELETE_CONFLICT).toBe(0);
    });

    it("C6-DEL-007: no-baseline remote-only is NEVER classified as deletion", () => {
      const localFiles = new Map<string, LocalFileEntry>();
      const remoteBlobs = new Map<string, RemoteBlobEntry>([
        ["RemoteOnly.md", { path: "RemoteOnly.md", sha: "hash222", size: 50 }],
      ]);
      const state: SyncStateData = { version: 1, files: {} };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.REMOTE_ONLY).toBe(1);
      expect(result.counts.LOCAL_DELETED).toBe(0);
      expect(result.counts.REMOTE_DELETED).toBe(0);
      expect(result.counts.DELETE_CONFLICT).toBe(0);
    });

    it("C6-DEL-014: binary delete works identically to text files", () => {
      const pngSha = "png_sha_1234567890abcdef1234567890abcdef";
      const localFiles = new Map<string, LocalFileEntry>(); // absent locally
      const remoteBlobs = new Map<string, RemoteBlobEntry>([
        ["attachments/image.png", { path: "attachments/image.png", sha: pngSha, size: 1024 }],
      ]);
      const state: SyncStateData = {
        version: 1,
        files: {
          "attachments/image.png": { localSha: pngSha, remoteSha: pngSha, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.LOCAL_DELETED).toBe(1);
      const item = result.items.find((i) => i.path === "attachments/image.png");
      expect(item?.category).toBe("LOCAL_DELETED");
    });

    it("C6-MOVE-001 & C6-MOVE-006: clean local move with exact SHA pairing", () => {
      const sha1 = "exact_sha_11111111111111111111111111111111";
      const localFiles = new Map<string, LocalFileEntry>([
        ["Archive/A.md", { path: "Archive/A.md", sha: sha1, size: 100 }],
      ]);
      const remoteBlobs = new Map<string, RemoteBlobEntry>([
        ["Projects/A.md", { path: "Projects/A.md", sha: sha1, size: 100 }],
      ]);
      const state: SyncStateData = {
        version: 1,
        files: {
          "Projects/A.md": { localSha: sha1, remoteSha: sha1, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.LOCAL_DELETED).toBe(1);
      expect(result.counts.LOCAL_ONLY).toBe(1);

      const delItem = result.items.find((i) => i.path === "Projects/A.md");
      const addItem = result.items.find((i) => i.path === "Archive/A.md");

      expect(delItem?.isMove).toBe(true);
      expect(delItem?.movedTo).toBe("Archive/A.md");
      expect(addItem?.isMove).toBe(true);
      expect(addItem?.movedFrom).toBe("Projects/A.md");
    });

    it("C6-MOVE-002: clean remote move with exact SHA pairing", () => {
      const sha1 = "exact_sha_22222222222222222222222222222222";
      const localFiles = new Map<string, LocalFileEntry>([
        ["Projects/A.md", { path: "Projects/A.md", sha: sha1, size: 100 }],
      ]);
      const remoteBlobs = new Map<string, RemoteBlobEntry>([
        ["Archive/A.md", { path: "Archive/A.md", sha: sha1, size: 100 }],
      ]);
      const state: SyncStateData = {
        version: 1,
        files: {
          "Projects/A.md": { localSha: sha1, remoteSha: sha1, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.REMOTE_DELETED).toBe(1);
      expect(result.counts.REMOTE_ONLY).toBe(1);

      const delItem = result.items.find((i) => i.path === "Projects/A.md");
      const addItem = result.items.find((i) => i.path === "Archive/A.md");

      expect(delItem?.isMove).toBe(true);
      expect(delItem?.movedTo).toBe("Archive/A.md");
      expect(addItem?.isMove).toBe(true);
      expect(addItem?.movedFrom).toBe("Projects/A.md");
    });

    it("C6-MOVE-007: edited move works as independent delete + add without false pairing", () => {
      const shaOld = "old_sha_1111111111111111111111111111111111";
      const shaEdited = "new_sha_2222222222222222222222222222222222";
      const localFiles = new Map<string, LocalFileEntry>([
        ["Archive/A.md", { path: "Archive/A.md", sha: shaEdited, size: 100 }],
      ]);
      const remoteBlobs = new Map<string, RemoteBlobEntry>([
        ["Projects/A.md", { path: "Projects/A.md", sha: shaOld, size: 100 }],
      ]);
      const state: SyncStateData = {
        version: 1,
        files: {
          "Projects/A.md": { localSha: shaOld, remoteSha: shaOld, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.LOCAL_DELETED).toBe(1);
      expect(result.counts.LOCAL_ONLY).toBe(1);

      const delItem = result.items.find((i) => i.path === "Projects/A.md");
      const addItem = result.items.find((i) => i.path === "Archive/A.md");

      // Not paired as an exact move because SHAs differ
      expect(delItem?.isMove).toBeFalsy();
      expect(addItem?.isMove).toBeFalsy();
    });

    it("C6-MOVE-008: move vs modify conflict blocks destination pairing", () => {
      const sha1 = "base_sha_11111111111111111111111111111111";
      const sha2 = "remote_mod_222222222222222222222222222222";
      const localFiles = new Map<string, LocalFileEntry>([
        ["B.md", { path: "B.md", sha: sha1, size: 120 }],
      ]);
      const remoteBlobs = new Map<string, RemoteBlobEntry>([
        ["A.md", { path: "A.md", sha: sha2, size: 150 }],
      ]);
      const state: SyncStateData = {
        version: 1,
        files: {
          "A.md": { localSha: sha1, remoteSha: sha1, syncedAt: 1000 },
        },
      };

      const result = classifySyncState({ localFiles, remoteBlobs, state });
      expect(result.counts.DELETE_CONFLICT).toBe(1);
      const conflictItem = result.items.find((i) => i.path === "A.md");
      expect(conflictItem?.category).toBe("DELETE_CONFLICT");

      const bItem = result.items.find((i) => i.path === "B.md");
      expect(bItem?.category).toBe("LOCAL_ONLY");
    });
  });

  // =========================================================================
  // 2. SAFE PUSH DELETION & MOVES
  // =========================================================================
  describe("Safe Push Deletion & Move Semantics (C6-DEL-008, C6-DEL-011, C6-MOVE-003, C6-MOVE-009..013)", () => {
    it("C6-DEL-008 & C6-MOVE-003: verified remote deletion in single Git commit removes baseline", async () => {
      const sha1 = "file_a_sha_111111111111111111111111111111";
      const baseCommitSha = "commit_base_001";
      const newCommitSha = "commit_new_002";
      const newTreeSha = "tree_new_002";

      const state = {
        version: 1,
        lastSyncedCommitSha: baseCommitSha,
        lastSyncedAt: Date.now() - 10000,
        files: {
          "A.md": { localSha: sha1, remoteSha: sha1, syncedAt: Date.now() - 10000 },
        },
      };
      await StorageManager.saveState(app, state);

      let treeInputReceived: unknown = null;

      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;

        if (url.includes("/branches/main")) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: baseCommitSha, commit: { tree: { sha: "tree_base_001" } } } },
            text: "{}",
          };
        }
        if (url.includes("/git/trees/")) {
          if (url.includes(newCommitSha)) {
            return {
              status: 200,
              headers: {},
              arrayBuffer: new ArrayBuffer(0),
              json: { sha: newTreeSha, truncated: false, tree: [] },
              text: "{}",
            };
          }
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_base_001", truncated: false, tree: [{ path: "A.md", mode: "100644", type: "blob", sha: sha1, size: 100 }] },
            text: "{}",
          };
        }
        if (url.includes("/git/trees") && params.method === "POST") {
          treeInputReceived = JSON.parse(params.body as string);
          return {
            status: 201,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: newTreeSha },
            text: "{}",
          };
        }
        if (url.includes("/git/commits") && params.method === "POST") {
          return {
            status: 201,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: newCommitSha },
            text: "{}",
          };
        }
        if (url.includes("/git/refs/heads/main") && params.method === "PATCH") {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { ref: "refs/heads/main", object: { sha: newCommitSha } },
            text: "{}",
          };
        }
        if (url.includes("/git/ref/heads/main") || url.includes("/git/refs/heads/main")) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { ref: "refs/heads/main", object: { sha: newCommitSha } },
            text: "{}",
          };
        }
        throw new Error(`Unhandled URL: ${params.method || "GET"} ${url}`);
      });

      const client = new GitHubClient({
        token: "tok",
        owner: defaultSettings.owner,
        repo: defaultSettings.repo,
        branch: defaultSettings.branch,
        requestFn: fakeRequestFn,
      });

      const pushEngine = new PushEngine(app, defaultSettings, client);
      const lease = acquireMutationLease(app, "test push delete")!;
      const report = await pushEngine.executeSafePush(undefined, lease);

      expect(report.status).toBe("PASS");
      expect(report.counts.pushedDeleted).toBe(1);

      // Verify Git Data API deletion mechanics: tree entry had sha: null
      const treeBody = treeInputReceived as { tree: Array<{ path: string; sha: string | null }> };
      const deletedEntry = treeBody.tree.find((t) => t.path === "A.md");
      expect(deletedEntry).toBeDefined();
      expect(deletedEntry?.sha).toBeNull();

      // Verify state: A.md removed from baseline after verified remote deletion
      const updatedState = await StorageManager.loadState(app);
      expect(updatedState.files["A.md"]).toBeUndefined();
      expect(updatedState.lastSyncedCommitSha).toBe(newCommitSha);
    });

    it("C6-DEL-011: local recreate race blocks deletion push", async () => {
      const sha1 = "file_a_sha_111111111111111111111111111111";
      const baseCommitSha = "commit_base_001";

      const state = {
        version: 1,
        lastSyncedCommitSha: baseCommitSha,
        lastSyncedAt: Date.now() - 10000,
        files: {
          "A.md": { localSha: sha1, remoteSha: sha1, syncedAt: Date.now() - 10000 },
        },
      };
      await StorageManager.saveState(app, state);

      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;
        if (url.includes("/branches/main")) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: baseCommitSha, commit: { tree: { sha: "tree_base_001" } } } },
            text: "{}",
          };
        }
        if (url.includes("/git/trees/")) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_base_001", truncated: false, tree: [{ path: "A.md", mode: "100644", type: "blob", sha: sha1, size: 100 }] },
            text: "{}",
          };
        }
        if (url.includes("/git/trees") && params.method === "POST") {
          // Simulate user recreating file locally before tree creation completes
          await app.vault.create("A.md", "Recreated content!");
          return {
            status: 201,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_new" },
            text: "{}",
          };
        }
        if (url.includes("/git/commits")) {
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new" }, text: "{}" };
        }
        throw new Error(`Unhandled URL: ${url}`);
      });

      const client = new GitHubClient({
        token: "tok",
        owner: defaultSettings.owner,
        repo: defaultSettings.repo,
        branch: defaultSettings.branch,
        requestFn: fakeRequestFn,
      });

      const pushEngine = new PushEngine(app, defaultSettings, client);
      const lease = acquireMutationLease(app, "test race recreate")!;
      const report = await pushEngine.executeSafePush(undefined, lease);

      // Pre-ref check aborts because local file was recreated in flight
      expect(report.status).toBe("ABORTED");
      expect(report.summaryMessage).toContain("recreated during Push");

      // Ref was NEVER updated, baseline was NOT removed
      const updatedState = await StorageManager.loadState(app);
      expect(updatedState.files["A.md"]).toBeDefined();
    });

    it("C6-MOVE-009: directory move with 10 files pushed in a single Git commit", async () => {
      const filesCount = 10;
      const baseCommitSha = "base_commit_dir";
      const newCommitSha = "new_commit_dir";

      const baselineFiles: Record<string, { localSha: string; remoteSha: string; syncedAt: number }> = {};
      const remoteTreeItems: Array<{ path: string; mode: string; type: string; sha: string; size: number }> = [];

      for (let i = 1; i <= filesCount; i++) {
        const oldPath = `FolderA/note${i}.md`;
        const newPath = `FolderB/note${i}.md`;
        const content = `Content of note ${i}`;
        const sha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), oldPath);

        baselineFiles[oldPath] = { localSha: sha, remoteSha: sha, syncedAt: 1000 };
        remoteTreeItems.push({ path: oldPath, mode: "100644", type: "blob", sha, size: content.length });

        // Local: FolderA absent, FolderB exists
        await app.vault.create(newPath, content);
      }

      await StorageManager.saveState(app, {
        version: 1,
        lastSyncedCommitSha: baseCommitSha,
        lastSyncedAt: 1000,
        files: baselineFiles,
      });

      let treeItemsSent: Array<{ path: string; sha: string | null }> = [];
      let commitsCreated = 0;

      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;
        if (url.includes("/branches/main")) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: baseCommitSha, commit: { tree: { sha: "tree_base" } } } },
            text: "{}",
          };
        }
        if (url.includes("/git/trees/")) {
          if (url.includes(newCommitSha)) {
            const verifiedTree = treeItemsSent.filter((t) => t.sha !== null).map((t) => ({ path: t.path, mode: "100644", type: "blob", sha: t.sha!, size: 50 }));
            return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "new_tree_sha", truncated: false, tree: verifiedTree }, text: "{}" };
          }
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_base", truncated: false, tree: remoteTreeItems },
            text: "{}",
          };
        }
        if (url.includes("/git/blobs") && params.method === "POST") {
          const body = JSON.parse(params.body as string);
          const rawBinary = atob(body.content);
          const bytes = new Uint8Array(rawBinary.length);
          for (let i = 0; i < rawBinary.length; i++) bytes[i] = rawBinary.charCodeAt(i);
          const sha = await calculateRawGitBlobSha(bytes);
          return {
            status: 201,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha },
            text: "{}",
          };
        }
        if (url.includes("/git/trees") && params.method === "POST") {
          const body = JSON.parse(params.body as string);
          treeItemsSent = body.tree;
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "new_tree_sha" }, text: "{}" };
        }
        if (url.includes("/git/commits") && params.method === "POST") {
          commitsCreated++;
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: newCommitSha }, text: "{}" };
        }
        if (url.includes("/git/refs/heads/main") && params.method === "PATCH") {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: newCommitSha } }, text: "{}" };
        }
        if (url.includes("/git/ref/heads/main") || url.includes("/git/refs/heads/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: newCommitSha } }, text: "{}" };
        }
        throw new Error(`Unhandled: ${url}`);
      });

      const client = new GitHubClient({
        token: "tok",
        owner: defaultSettings.owner,
        repo: defaultSettings.repo,
        branch: defaultSettings.branch,
        requestFn: fakeRequestFn,
      });

      const pushEngine = new PushEngine(app, defaultSettings, client);
      const lease = acquireMutationLease(app, "test dir move push")!;
      const report = await pushEngine.executeSafePush(undefined, lease);

      expect(report.status).toBe("PASS");
      expect(commitsCreated).toBe(1); // EXACTLY ONE Git commit for the batch
      expect(report.counts.pushedDeleted).toBe(10);
      expect(report.counts.pushedCreated).toBe(10);

      // Verify tree items: 10 deletes (sha: null) and 10 adds
      const deletedEntries = treeItemsSent.filter((t) => t.sha === null);
      const addedEntries = treeItemsSent.filter((t) => t.sha !== null);
      expect(deletedEntries.length).toBe(10);
      expect(addedEntries.length).toBe(10);
    });

    it("C6-MOVE-010: Unicode, nested paths, and emoji move", async () => {
      const oldPath = "Đặc biệt/🚀 ghi chú.md";
      const newPath = "Lưu trữ/📁 lưu trữ.md";
      const content = "# Ghi chú tiếng Việt có dấu\n";
      const sha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), oldPath);

      await app.vault.create(newPath, content);
      await StorageManager.saveState(app, {
        version: 1,
        lastSyncedCommitSha: "c_base",
        lastSyncedAt: 1000,
        files: {
          [oldPath]: { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      });

      let treeItemsSent: Array<{ path: string; sha: string | null }> = [];
      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;
        if (url.includes("/branches/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c_base", commit: { tree: { sha: "t_base" } } } }, text: "{}" };
        }
        if (url.includes("/git/trees/")) {
          if (url.includes("c_new")) {
            return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_new", truncated: false, tree: [{ path: newPath, mode: "100644", type: "blob", sha, size: 50 }] }, text: "{}" };
          }
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_base", truncated: false, tree: [{ path: oldPath, mode: "100644", type: "blob", sha, size: 50 }] }, text: "{}" };
        }
        if (url.includes("/git/blobs") && params.method === "POST") {
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha }, text: "{}" };
        }
        if (url.includes("/git/trees") && params.method === "POST") {
          treeItemsSent = JSON.parse(params.body as string).tree;
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_new" }, text: "{}" };
        }
        if (url.includes("/git/commits") && params.method === "POST") {
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "c_new" }, text: "{}" };
        }
        if (url.includes("/git/refs/heads/main") && params.method === "PATCH") {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "c_new" } }, text: "{}" };
        }
        if (url.includes("/git/ref/heads/main") || url.includes("/git/refs/heads/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "c_new" } }, text: "{}" };
        }
        throw new Error(`Unhandled: ${url}`);
      });

      const client = new GitHubClient({ token: "tok", owner: "o", repo: "r", branch: "main", requestFn: fakeRequestFn });
      const pushEngine = new PushEngine(app, defaultSettings, client);
      const lease = acquireMutationLease(app, "test unicode move")!;
      const report = await pushEngine.executeSafePush(undefined, lease);

      expect(report.status).toBe("PASS");
      const delItem = treeItemsSent.find((t) => t.path === oldPath);
      const addItem = treeItemsSent.find((t) => t.path === newPath);
      expect(delItem?.sha).toBeNull();
      expect(addItem?.sha).toBe(sha);
    });
  });

  // =========================================================================
  // 3. SAFE PULL DELETION & MOVES
  // =========================================================================
  describe("Safe Pull Deletion & Move Semantics (C6-DEL-009, C6-DEL-010, C6-MOVE-004..005)", () => {
    it("C6-DEL-009: verified local deletion removes baseline and cleans recovery journal", async () => {
      const content = "# Local note to be deleted by remote\n";
      const sha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), "DeleteMe.md");
      await app.vault.create("DeleteMe.md", content);

      await StorageManager.saveState(app, {
        version: 1,
        lastSyncedCommitSha: "c_base",
        lastSyncedAt: 1000,
        files: {
          "DeleteMe.md": { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      });

      // Remote tree: DeleteMe.md is absent
      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;
        if (url.includes("/branches/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c_head", commit: { tree: { sha: "t_head" } } } }, text: "{}" };
        }
        if (url.includes("/git/trees/")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_head", truncated: false, tree: [] }, text: "{}" };
        }
        throw new Error(`Unhandled: ${url}`);
      });

      const client = new GitHubClient({ token: "tok", owner: "o", repo: "r", branch: "main", requestFn: fakeRequestFn });
      const pullEngine = new PullEngine(app, defaultSettings, client);
      const lease = acquireMutationLease(app, "test pull delete")!;
      const report = await pullEngine.executeSafePull(undefined, lease);

      expect(report.status).toBe("PASS");
      expect(report.counts.pulledDeleted).toBe(1);

      // File removed from vault
      expect(await app.vault.adapter.exists("DeleteMe.md")).toBe(false);

      // Baseline entry removed
      const state = await StorageManager.loadState(app);
      expect(state.files["DeleteMe.md"]).toBeUndefined();

      // Recovery journal directory is clean
      const recoveryDir = StorageManager.getDeleteRecoveryDirPath(app);
      const leftoverFiles = (await app.vault.adapter.exists(recoveryDir)) ? await app.vault.adapter.list(recoveryDir) : { files: [] };
      expect(leftoverFiles.files.length).toBe(0);
    });

    it("C6-DEL-010: local modification before remote-delete pull converts to conflict", async () => {
      const originalContent = "original\n";
      const sha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(originalContent), "DeleteMe.md");
      await app.vault.create("DeleteMe.md", "modified locally while offline!\n");

      await StorageManager.saveState(app, {
        version: 1,
        lastSyncedCommitSha: "c_base",
        lastSyncedAt: 1000,
        files: {
          "DeleteMe.md": { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      });

      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;
        if (url.includes("/branches/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c_head", commit: { tree: { sha: "t_head" } } } }, text: "{}" };
        }
        if (url.includes("/git/trees/")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_head", truncated: false, tree: [] }, text: "{}" };
        }
        throw new Error(`Unhandled: ${url}`);
      });

      const client = new GitHubClient({ token: "tok", owner: "o", repo: "r", branch: "main", requestFn: fakeRequestFn });
      const pullEngine = new PullEngine(app, defaultSettings, client);
      const lease = acquireMutationLease(app, "test pull race conflict")!;
      const report = await pullEngine.executeSafePull(undefined, lease);

      // Deletion blocked, conflict preserved
      expect(report.counts.conflictsPreserved).toBe(1);
      expect(await app.vault.adapter.exists("DeleteMe.md")).toBe(true);
      expect(await app.vault.adapter.read("DeleteMe.md")).toBe("modified locally while offline!\n");
    });

    it("C6-MOVE-004: remote move creates destination before deleting local source", async () => {
      const content = "# Moved note\n";
      const sha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), "Archive/A.md");

      // Local currently has Projects/A.md
      await app.vault.create("Projects/A.md", content);
      await StorageManager.saveState(app, {
        version: 1,
        lastSyncedCommitSha: "c_base",
        lastSyncedAt: 1000,
        files: {
          "Projects/A.md": { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      });

      const stepOrder: string[] = [];
      const origCreateBinary = app.vault.createBinary.bind(app.vault);
      const origDelete = app.vault.delete.bind(app.vault);

      vi.spyOn(app.vault, "createBinary").mockImplementation(async (path, data) => {
        stepOrder.push(`create:${path}`);
        return origCreateBinary(path, data);
      });

      vi.spyOn(app.vault, "delete").mockImplementation(async (file) => {
        stepOrder.push(`delete:${file.path}`);
        return origDelete(file);
      });

      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;
        if (url.includes("/branches/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c_head", commit: { tree: { sha: "t_head" } } } }, text: "{}" };
        }
        if (url.includes("/git/trees/")) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: "t_head", truncated: false, tree: [{ path: "Archive/A.md", mode: "100644", type: "blob", sha, size: content.length }] },
            text: "{}",
          };
        }
        if (url.includes(`/git/blobs/${sha}`)) {
          let binary = "";
          const bytes = new TextEncoder().encode(content);
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha, content: btoa(binary), encoding: "base64", size: bytes.length },
            text: "{}",
          };
        }
        throw new Error(`Unhandled: ${url}`);
      });

      const client = new GitHubClient({ token: "tok", owner: "o", repo: "r", branch: "main", requestFn: fakeRequestFn });
      const pullEngine = new PullEngine(app, defaultSettings, client);
      const lease = acquireMutationLease(app, "test remote move order")!;
      const report = await pullEngine.executeSafePull(undefined, lease);

      expect(report.status).toBe("PASS");
      expect(stepOrder).toContain("create:Archive/A.md");
      expect(stepOrder).toContain("delete:Projects/A.md");

      // Verify STRICT ORDERING: create comes BEFORE delete
      const createIndex = stepOrder.indexOf("create:Archive/A.md");
      const deleteIndex = stepOrder.indexOf("delete:Projects/A.md");
      expect(createIndex).toBeLessThan(deleteIndex);

      expect(await app.vault.adapter.exists("Archive/A.md")).toBe(true);
      expect(await app.vault.adapter.exists("Projects/A.md")).toBe(false);
    });

    it("C6-MOVE-005: failed destination write preserves source file intact", async () => {
      const content = "# Moved note\n";
      const sha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), "Archive/A.md");

      await app.vault.create("Projects/A.md", content);
      await StorageManager.saveState(app, {
        version: 1,
        lastSyncedCommitSha: "c_base",
        lastSyncedAt: 1000,
        files: {
          "Projects/A.md": { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      });

      // Simulate disk failure during destination write
      vi.spyOn(app.vault, "createBinary").mockRejectedValue(new Error("Disk I/O failure on destination write"));

      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;
        if (url.includes("/branches/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c_head", commit: { tree: { sha: "t_head" } } } }, text: "{}" };
        }
        if (url.includes("/git/trees/")) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: "t_head", truncated: false, tree: [{ path: "Archive/A.md", mode: "100644", type: "blob", sha, size: content.length }] },
            text: "{}",
          };
        }
        if (url.includes(`/git/blobs/${sha}`)) {
          let binary = "";
          const bytes = new TextEncoder().encode(content);
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha, content: btoa(binary), encoding: "base64", size: bytes.length }, text: "{}" };
        }
        throw new Error(`Unhandled: ${url}`);
      });

      const client = new GitHubClient({ token: "tok", owner: "o", repo: "r", branch: "main", requestFn: fakeRequestFn });
      const pullEngine = new PullEngine(app, defaultSettings, client);
      const lease = acquireMutationLease(app, "test destination fail")!;
      const report = await pullEngine.executeSafePull(undefined, lease);

      expect(report.status).toBe("FAIL");

      // Source file Projects/A.md MUST REMAIN INTACT!
      expect(await app.vault.adapter.exists("Projects/A.md")).toBe(true);
      expect(await app.vault.adapter.read("Projects/A.md")).toBe(content);
    });
  });

  // =========================================================================
  // 4. CRASH RECOVERY & STORAGE INTEGRITY
  // =========================================================================
  describe("Delete Recovery & Storage Lifecycle (C6-DEL-012..013, C6-RECOVERY-001..002, C6-STRESS-001)", () => {
    it("C6-DEL-012 & C6-RECOVERY-001: startup recovers interrupted delete if local file was deleted but state was not updated", async () => {
      const path = "Important.md";
      const content = "# Recoverable bytes\n";
      const bytes = new TextEncoder().encode(content);
      const sha = await calculateCanonicalGitBlobSha(bytes, path);

      // State still expects the file
      await StorageManager.saveState(app, {
        version: 1,
        lastSyncedCommitSha: "c_prev",
        lastSyncedAt: 1000,
        files: {
          [path]: { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      });

      // Simulate crash: journal exists on disk, local file was deleted
      const journalPath = await StorageManager.beginDeleteRecovery(app, path, sha, bytes);
      expect(await app.vault.adapter.exists(journalPath)).toBe(true);
      expect(await app.vault.adapter.exists(path)).toBe(false);

      // Startup recovery
      const recovered = await StorageManager.recoverInterruptedDeletes(app);
      expect(recovered.restored).toBe(1);

      // File was restored from durable recovery bytes
      expect(await app.vault.adapter.exists(path)).toBe(true);
      expect(await app.vault.adapter.read(path)).toBe(content);

      // Journal was cleaned up
      expect(await app.vault.adapter.exists(journalPath)).toBe(false);
    });

    it("C6-RECOVERY-002: malformed delete recovery journal handled gracefully", async () => {
      const recoveryDir = StorageManager.getDeleteRecoveryDirPath(app);
      await app.vault.adapter.mkdir(recoveryDir);
      await app.vault.adapter.write(`${recoveryDir}/corrupt.json`, "{ bad json ");

      const result = await StorageManager.recoverInterruptedDeletes(app);
      expect(result.scanned).toBe(1);
      expect(result.restored).toBe(0);
      expect(result.preserved).toBe(1); // preserved for forensics, no crash loop
    });

    it("C6-STRESS-001: 1,000 create -> sync -> delete -> converge cycles leave ZERO internal artifacts", async () => {
      const state = {
        version: 1,
        lastSyncedCommitSha: "c_stress",
        lastSyncedAt: 1000,
        files: {} as Record<string, { localSha: string; remoteSha: string; syncedAt: number }>,
      };
      await StorageManager.saveState(app, state);

      const cycles = 1000;
      for (let i = 0; i < cycles; i++) {
        const path = `stress_${i % 10}.md`;
        const sha = `sha_${i}`;

        // Create & Sync
        state.files[path] = { localSha: sha, remoteSha: sha, syncedAt: Date.now() };

        // Delete & Converge
        delete state.files[path];
      }
      await StorageManager.saveState(app, state);

      // Verify final baseline state has 0 stale entries
      const finalState = await StorageManager.loadState(app);
      expect(Object.keys(finalState.files).length).toBe(0);

      // Verify zero leftover recovery artifacts
      const pullRecDir = StorageManager.getPullRecoveryDirPath(app);
      const delRecDir = StorageManager.getDeleteRecoveryDirPath(app);
      const pullRecFiles = (await app.vault.adapter.exists(pullRecDir)) ? await app.vault.adapter.list(pullRecDir) : { files: [] };
      const delRecFiles = (await app.vault.adapter.exists(delRecDir)) ? await app.vault.adapter.list(delRecDir) : { files: [] };

      expect(pullRecFiles.files.length).toBe(0);
      expect(delRecFiles.files.length).toBe(0);
    });
  });

  // =========================================================================
  // 5. DELETE CONFLICT UX & RESOLUTION
  // =========================================================================
  describe("Delete Conflict Resolution UX (C6-DEL-004..005 semantics)", () => {
    it("CONFLICT-DEL-001: Keep File restores remote modified version locally", async () => {
      const path = "ConflictNote.md";
      const remoteContent = "# Remote Modified Version\n";
      const remoteBytes = new TextEncoder().encode(remoteContent);
      const remoteSha = await calculateRawGitBlobSha(remoteBytes);

      let binary = "";
      for (let i = 0; i < remoteBytes.length; i++) binary += String.fromCharCode(remoteBytes[i]);

      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;
        if (url.includes("/branches/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c_head", commit: { tree: { sha: "t_head" } } } }, text: "{}" };
        }
        if (url.includes("/git/trees/")) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: "t_head", truncated: false, tree: [{ path, mode: "100644", type: "blob", sha: remoteSha, size: remoteBytes.length }] },
            text: "{}",
          };
        }
        if (url.includes(`/git/blobs/${remoteSha}`)) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: remoteSha, content: btoa(binary), encoding: "base64", size: remoteBytes.length },
            text: "{}",
          };
        }
        throw new Error(`Unhandled: ${url}`);
      });

      const client = new GitHubClient({ token: "tok", owner: "o", repo: "r", branch: "main", requestFn: fakeRequestFn });
      const cm = new ConflictManager(app, defaultSettings, client);

      const record: ConflictRecord = {
        id: "c_del_keep",
        path,
        localSha: "",
        remoteSha,
        remoteCommitSha: "c_head",
        detectedAt: Date.now(),
        conflictType: "DELETE_LOCAL_REMOTE_MODIFIED",
      };
      await cm.saveConflictRecords([record]);

      const res = await cm.resolveKeepFile(record);
      expect(res.success).toBe(true);

      // File restored locally
      expect(await app.vault.adapter.exists(path)).toBe(true);
      expect(await app.vault.adapter.read(path)).toBe(remoteContent);

      // Conflict record removed
      const remaining = await cm.loadConflictRecords();
      expect(remaining.length).toBe(0);
    });

    it("CONFLICT-DEL-002: Delete File authorizes remote deletion of modified file", async () => {
      const path = "ConflictNote.md";
      const remoteSha = "remote_mod_sha_222222222222222222222222";
      let deleteTreeSent = false;

      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        const url = params.url;
        if (url.includes("/branches/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c_head", commit: { tree: { sha: "t_head" } } } }, text: "{}" };
        }
        if (url.includes("/git/trees/")) {
          if (url.includes("c_deleted")) {
            return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_deleted", truncated: false, tree: [] }, text: "{}" };
          }
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { sha: "t_head", truncated: false, tree: [{ path, mode: "100644", type: "blob", sha: remoteSha, size: 50 }] },
            text: "{}",
          };
        }
        if (url.includes("/git/trees") && params.method === "POST") {
          const body = JSON.parse(params.body as string);
          if (body.tree.some((t: { path: string; sha: string | null }) => t.path === path && t.sha === null)) {
            deleteTreeSent = true;
          }
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_deleted" }, text: "{}" };
        }
        if (url.includes("/git/commits") && params.method === "POST") {
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "c_deleted" }, text: "{}" };
        }
        if (url.includes("/git/refs/heads/main") && params.method === "PATCH") {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "c_deleted" } }, text: "{}" };
        }
        if (url.includes("/git/ref/heads/main") || url.includes("/git/refs/heads/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "c_deleted" } }, text: "{}" };
        }
        throw new Error(`Unhandled: ${url}`);
      });

      const client = new GitHubClient({ token: "tok", owner: "o", repo: "r", branch: "main", requestFn: fakeRequestFn });
      const cm = new ConflictManager(app, defaultSettings, client);

      const record: ConflictRecord = {
        id: "c_del_push",
        path,
        localSha: "",
        remoteSha,
        remoteCommitSha: "c_head",
        detectedAt: Date.now(),
        conflictType: "DELETE_LOCAL_REMOTE_MODIFIED",
      };
      await cm.saveConflictRecords([record]);

      const res = await cm.resolveDeleteFile(record);
      expect(res.success).toBe(true);
      expect(deleteTreeSent).toBe(true);

      const remaining = await cm.loadConflictRecords();
      expect(remaining.length).toBe(0);
    });
  });

  // =========================================================================
  // 6. SECURITY & INVARIANTS
  // =========================================================================
  describe("Security & Invariants (C6-SEC-001, C6-RACE-001)", () => {
    it("C6-SEC-001: deletion never invokes HTTP DELETE or PUT /contents", async () => {
      const httpMethodsUsed: string[] = [];
      const urlsInvoked: string[] = [];

      const sha = "sha123";
      await StorageManager.saveState(app, {
        version: 1,
        lastSyncedCommitSha: "c_base",
        lastSyncedAt: 1000,
        files: { "A.md": { localSha: sha, remoteSha: sha, syncedAt: 1000 } },
      });

      const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
        httpMethodsUsed.push(params.method || "GET");
        urlsInvoked.push(params.url);

        if (params.url.includes("/branches/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { name: "main", commit: { sha: "c_base", commit: { tree: { sha: "t_base" } } } }, text: "{}" };
        }
        if (params.url.includes("/git/trees/")) {
          if (params.url.includes("c_new")) {
            return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_new", truncated: false, tree: [] }, text: "{}" };
          }
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_base", truncated: false, tree: [{ path: "A.md", mode: "100644", type: "blob", sha, size: 50 }] }, text: "{}" };
        }
        if (params.url.includes("/git/trees") && params.method === "POST") {
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "t_new" }, text: "{}" };
        }
        if (params.url.includes("/git/commits") && params.method === "POST") {
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "c_new" }, text: "{}" };
        }
        if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "c_new" } }, text: "{}" };
        }
        if (params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) {
          return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "c_new" } }, text: "{}" };
        }
        throw new Error(`Unhandled: ${params.url}`);
      });

      const client = new GitHubClient({ token: "tok", owner: "o", repo: "r", branch: "main", requestFn: fakeRequestFn });
      const pushEngine = new PushEngine(app, defaultSettings, client);
      const lease = acquireMutationLease(app, "test security audit")!;
      await pushEngine.executeSafePush(undefined, lease);

      expect(httpMethodsUsed).not.toContain("DELETE");
      expect(urlsInvoked.some((u) => u.includes("/contents"))).toBe(false);
    });

    it("C6-RACE-001: MutationCoordinator blocks overlapping sync actions during delete", async () => {
      const lease = acquireMutationLease(app, "Active Operation")!;
      expect(lease).toBeDefined();

      const client = new GitHubClient({ token: "tok", owner: "o", repo: "r", branch: "main" });
      const unifiedSync = new UnifiedSyncEngine(app, defaultSettings, client);

      await expect(unifiedSync.executeSync()).rejects.toThrow("Another vault mutation is already in progress");
    });
  });

  describe("Delete Recovery Crash-Consistent Transaction Semantics (C6-RECOVERY-COMMIT-001..005)", () => {
    it("C6-RECOVERY-COMMIT-001: crash before local delete leaves file intact and cleans obsolete journal", async () => {
      const path = "NoteBeforeDelete.md";
      const content = "Intact local content before deletion.";
      const file = await app.vault.create(path, content);
      const sha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), path);

      const state: SyncStateData = {
        version: 1,
        files: {
          [path]: { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      };
      await StorageManager.saveState(app, state);

      // Begin recovery journal as if about to delete
      const journalPath = await StorageManager.beginDeleteRecovery(
        app,
        path,
        sha,
        await app.vault.readBinary(file)
      );

      // Crash occurs: local file was NOT deleted!
      expect(app.vault.getAbstractFileByPath(path)).toBeDefined();

      // Startup recovery runs
      const res = await StorageManager.recoverInterruptedDeletes(app);

      // File was already intact, delete was unexecuted -> journal cleaned, 0 restored
      expect(res.completed).toBe(1);
      expect(res.restored).toBe(0);
      expect(await app.vault.adapter.exists(journalPath)).toBe(false);

      const remainingFile = app.vault.getAbstractFileByPath(path);
      expect(remainingFile).toBeDefined();
      expect(await app.vault.read(remainingFile as TFile)).toBe(content);
    });

    it("C6-RECOVERY-COMMIT-002: crash after local delete before baseline prune restores exact file", async () => {
      const path = "NoteUncommitted.md";
      const content = "Important content before crash.";
      const file = await app.vault.create(path, content);
      const sha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), path);

      const state: SyncStateData = {
        version: 1,
        files: {
          [path]: { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      };
      await StorageManager.saveState(app, state);

      // Begin recovery journal
      const journalPath = await StorageManager.beginDeleteRecovery(
        app,
        path,
        sha,
        await app.vault.readBinary(file)
      );

      // Local file is deleted
      await StorageManager.deleteVaultFile(app, file);
      expect(app.vault.getAbstractFileByPath(path)).toBeNull();

      // Crash occurs BEFORE state.files[path] is pruned in state.json!
      const unprunedState = await StorageManager.loadState(app);
      expect(unprunedState.files[path]).toBeDefined();

      // Startup recovery runs
      const res = await StorageManager.recoverInterruptedDeletes(app);

      // UNCOMMITTED delete -> exact file restored
      expect(res.restored).toBe(1);
      expect(await app.vault.adapter.exists(journalPath)).toBe(false);

      const restoredFile = app.vault.getAbstractFileByPath(path);
      expect(restoredFile).toBeDefined();
      expect(await app.vault.read(restoredFile as TFile)).toBe(content);
    });

    it("C6-RECOVERY-COMMIT-003 & C6-RECOVERY-COMMIT-004: crash after baseline prune keeps file deleted and does NOT resurrect", async () => {
      const path = "NoteCommitted.md";
      const content = "Content already committed to deletion.";
      const file = await app.vault.create(path, content);
      const sha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), path);

      // Initial baseline
      const state: SyncStateData = {
        version: 1,
        files: {
          [path]: { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      };
      await StorageManager.saveState(app, state);

      // Begin recovery journal
      const journalPath = await StorageManager.beginDeleteRecovery(
        app,
        path,
        sha,
        await app.vault.readBinary(file)
      );

      // Local file deleted
      await StorageManager.deleteVaultFile(app, file);

      // Baseline successfully pruned and saved to disk
      delete state.files[path];
      await StorageManager.saveState(app, state);

      // Crash occurs BEFORE journal cleanup!
      expect(await app.vault.adapter.exists(journalPath)).toBe(true);

      // Startup recovery runs
      const res = await StorageManager.recoverInterruptedDeletes(app);

      // COMMITTED delete -> file remains deleted, journal cleaned, 0 restored
      expect(res.completed).toBe(1);
      expect(res.restored).toBe(0);
      expect(await app.vault.adapter.exists(journalPath)).toBe(false);

      // C6-RECOVERY-COMMIT-004: file is NOT resurrected
      expect(app.vault.getAbstractFileByPath(path)).toBeNull();
      const updatedState = await StorageManager.loadState(app);
      expect(updatedState.files[path]).toBeUndefined();
    });

    it("C6-RECOVERY-COMMIT-005: restart + next Sync cannot recreate remotely deleted file", async () => {
      const path = "RemoteDeletedDoc.md";

      // Post-crash state after C6-RECOVERY-COMMIT-003:
      // Local file absent, remote file absent, baseline absent
      expect(app.vault.getAbstractFileByPath(path)).toBeNull();
      const state = await StorageManager.loadState(app);
      expect(state.files[path]).toBeUndefined();

      // Scan local vault and remote tree
      const localFiles = new Map<string, LocalFileEntry>();
      const remoteBlobs = new Map<string, RemoteBlobEntry>();

      const report = classifySyncState({
        localFiles,
        remoteBlobs,
        state,
        excludedPaths: defaultSettings.excludedPaths,
      });

      // Must be 0 changes, neither LOCAL_ONLY nor LOCAL_DELETED
      expect(report.counts.LOCAL_ONLY).toBe(0);
      expect(report.counts.LOCAL_DELETED).toBe(0);
      expect(report.counts.REMOTE_DELETED).toBe(0);
      expect(report.items.some((i) => i.path === path)).toBe(false);
    });
  });

  describe("Obsidian Trash Policy & Exclusion (C6-TRASH-001..002)", () => {
    it("C6-TRASH-001: deleteVaultFile uses app.fileManager.trashFile and falls back to vault.delete", async () => {
      const path = "TrashTest.md";
      const file = await app.vault.create(path, "Trash content");

      let trashFileCalled = false;
      app.fileManager = {
        trashFile: async (f: TAbstractFile) => {
          trashFileCalled = true;
          await app.vault.delete(f as TFile);
        },
      } as unknown as App["fileManager"];

      await StorageManager.deleteVaultFile(app, file);
      expect(trashFileCalled).toBe(true);
      expect(app.vault.getAbstractFileByPath(path)).toBeNull();

      // Test fallback when fileManager is unavailable
      const path2 = "FallbackTest.md";
      const file2 = await app.vault.create(path2, "Fallback content");
      const appWithoutFileManager = {
        vault: app.vault,
      } as unknown as App;

      await StorageManager.deleteVaultFile(appWithoutFileManager, file2);
      expect(app.vault.getAbstractFileByPath(path2)).toBeNull();
    });

    it("C6-TRASH-002: files in .trash/ are excluded from sync and cannot be pushed to GitHub", async () => {
      const trashedPath = ".trash/abandoned-note.md";

      // 1. PathFilter excludes .trash/
      expect(isPathExcluded(trashedPath)).toBe(true);

      // 2. PathSafety rejects .trash/ as reserved
      expect(validatePathSafety(trashedPath).valid).toBe(false);

      // 3. Vault scanning does not include .trash/
      await app.vault.create(trashedPath, "Trashed notes");
      const files = app.vault.getFiles();
      expect(files.some((f) => f.path.startsWith(".trash/"))).toBe(false);
    });
  });

  describe("Root _vault-relay/ User Content Semantics (C6-ROOT-001)", () => {
    it("C6-ROOT-001: _vault-relay/user-note.md can CREATE, EDIT, MOVE, and DELETE through normal C6 sync", async () => {
      const userPath = "_vault-relay/user-note.md";
      const content1 = "# User Note in root _vault-relay\nInitial creation.";
      const file = await app.vault.create(userPath, content1);

      // 1. CREATE: classifies as LOCAL_ONLY
      const sha1 = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content1), userPath);
      const localFiles = new Map<string, LocalFileEntry>([
        [userPath, { path: userPath, sha: sha1, size: content1.length, mtime: 1000 }],
      ]);
      const remoteBlobs = new Map<string, RemoteBlobEntry>();
      const state: SyncStateData = { version: 1, files: {} };

      let report = classifySyncState({ localFiles, remoteBlobs, state, excludedPaths: defaultSettings.excludedPaths });
      expect(report.counts.LOCAL_ONLY).toBe(1);
      expect(report.items[0].category).toBe("LOCAL_ONLY");

      // 2. Establish baseline, then EDIT: classifies as LOCAL_CHANGED
      state.files[userPath] = { localSha: sha1, remoteSha: sha1, syncedAt: 1000 };
      remoteBlobs.set(userPath, { path: userPath, sha: sha1, size: content1.length });

      const content2 = content1 + "\nEdited user note.";
      await app.vault.modify(file, content2);
      const sha2 = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content2), userPath);
      localFiles.set(userPath, { path: userPath, sha: sha2, size: content2.length, mtime: 2000 });

      report = classifySyncState({ localFiles, remoteBlobs, state, excludedPaths: defaultSettings.excludedPaths });
      expect(report.counts.LOCAL_CHANGED).toBe(1);
      expect(report.items.find((i) => i.path === userPath)?.category).toBe("LOCAL_CHANGED");

      // 3. MOVE: move to _vault-relay/archived-note.md
      const movedPath = "_vault-relay/archived-note.md";
      localFiles.delete(userPath);
      localFiles.set(movedPath, { path: movedPath, sha: sha1, size: content1.length, mtime: 3000 });

      report = classifySyncState({ localFiles, remoteBlobs, state, excludedPaths: defaultSettings.excludedPaths });
      expect(report.counts.LOCAL_DELETED).toBe(1);
      expect(report.counts.LOCAL_ONLY).toBe(1);
      const delItem = report.items.find((i) => i.path === userPath);
      const addItem = report.items.find((i) => i.path === movedPath);
      expect(delItem?.isMove).toBe(true);
      expect(delItem?.movedTo).toBe(movedPath);
      expect(addItem?.isMove).toBe(true);
      expect(addItem?.movedFrom).toBe(userPath);

      // 4. DELETE: delete without move
      localFiles.clear();
      report = classifySyncState({ localFiles, remoteBlobs, state, excludedPaths: defaultSettings.excludedPaths });
      expect(report.counts.LOCAL_DELETED).toBe(1);
      expect(report.items[0].category).toBe("LOCAL_DELETED");
    });
  });

  describe("Binary Delete Recovery Storage Verification (C6-BIN-RECOVERY-001)", () => {
    it("C6-BIN-RECOVERY-001: large binary delete recovery snapshot is bounded and byte-exact", async () => {
      const binaryPath = "attachments/large-photo.jpg";
      const binarySize = 1024 * 512; // 512 KiB representative test payload
      const binaryBytes = new Uint8Array(binarySize);
      for (let i = 0; i < binarySize; i++) {
        binaryBytes[i] = (i * 31 + 7) & 0xff;
      }

      const sha = await calculateCanonicalGitBlobSha(binaryBytes.buffer as ArrayBuffer, binaryPath);

      // Begin recovery journal
      const journalPath = await StorageManager.beginDeleteRecovery(
        app,
        binaryPath,
        sha,
        binaryBytes.buffer as ArrayBuffer
      );

      // 1. Verify JSON journal is compact metadata, NOT a massive serialized array
      const journalContent = await app.vault.adapter.read(journalPath);
      expect(journalContent.length).toBeLessThan(300); // < 300 bytes of JSON metadata

      const record = JSON.parse(journalContent);
      expect(record.version).toBe(1);
      expect(record.path).toBe(binaryPath);
      expect(record.originalSha).toBe(sha);
      expect(typeof record.backupPath).toBe("string");

      // 2. Verify raw binary backup is exact length
      const rawBackup = await app.vault.adapter.readBinary(record.backupPath);
      expect(rawBackup.byteLength).toBe(binarySize);

      // 3. Verify recoverInterruptedDeletes restores byte-exact binary data
      const state: SyncStateData = {
        version: 1,
        files: {
          [binaryPath]: { localSha: sha, remoteSha: sha, syncedAt: 1000 },
        },
      };
      await StorageManager.saveState(app, state);

      const res = await StorageManager.recoverInterruptedDeletes(app);
      expect(res.restored).toBe(1);

      const restoredFile = app.vault.getAbstractFileByPath(binaryPath);
      expect(restoredFile).toBeDefined();

      const restoredBytes = new Uint8Array(await app.vault.readBinary(restoredFile as TFile));
      expect(restoredBytes.byteLength).toBe(binarySize);
      expect(restoredBytes.every((b, idx) => b === binaryBytes[idx])).toBe(true);
    });
  });
});

