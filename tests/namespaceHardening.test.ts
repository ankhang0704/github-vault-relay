import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import { StorageManager, LEGACY_ROOT_DIR, LEGACY_STATE_FILE, LEGACY_CONFLICTS_DIR } from "../src/sync/storageManager";
import { isPathExcluded } from "../src/sync/pathFilter";
import { validatePathSafety } from "../src/sync/pathSafety";
import { classifySyncState } from "../src/sync/syncClassifier";
import { PushEngine } from "../src/sync/pushEngine";
import { PullEngine } from "../src/sync/pullEngine";
import { GitHubClient } from "../src/github/githubClient";
import { ConflictManager } from "../src/sync/conflictManager";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";

describe("C4 Final Internal Namespace Hardening (NS-001..012)", () => {
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

  it("NS-003: Safe Push / Unified Sync pushes user _vault-relay/file.md to GitHub", async () => {
    const filePath = "_vault-relay/document.md";
    const content = "# Important Document\n";
    await app.vault.create(filePath, content);

    const localSha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(content), filePath);

    const postCalls: Array<{ type: string; body: unknown }> = [];
    const patchCalls: unknown[] = [];

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
        postCalls.push({ type: "blob", body: typeof params.body === "string" ? JSON.parse(params.body) : params.body });
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/trees") && method === "POST") {
        postCalls.push({ type: "tree", body: typeof params.body === "string" ? JSON.parse(params.body) : params.body });
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "new_tree_sha" } };
      }
      if (params.url.includes("/git/commits") && method === "POST") {
        postCalls.push({ type: "commit", body: typeof params.body === "string" ? JSON.parse(params.body) : params.body });
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "new_commit_sha" } };
      }
      if (params.url.includes("/git/ref/heads/main") && method === "GET") {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: currentBranchSha, type: "commit" } },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && method === "PATCH") {
        patchCalls.push(params.body);
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

    // Verify tree call included the user path
    const treeCall = postCalls.find((c) => c.type === "tree");
    expect((treeCall?.body as { tree?: unknown[] })?.tree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: filePath }),
      ])
    );

    // Verify baseline was stored in canonical internal storage
    const canonicalState = await StorageManager.loadState(app);
    expect(canonicalState.files[filePath]).toBeDefined();
    expect(canonicalState.files[filePath].localSha).toBe(localSha);
  }, 15000);

  it("NS-004: Genuine C2/C3 legacy state migrates to .obsidian/github-vault-relay", async () => {
    const legacyState = JSON.stringify({
      version: 1,
      lastSyncedCommitSha: "c3_legacy_commit_sha",
      lastSyncedAt: 1788400000000,
      files: {
        "Note.md": { localSha: "s1", remoteSha: "s1", syncedAt: 1788400000000 },
      },
    });

    await app.vault.adapter.write(LEGACY_STATE_FILE, legacyState);
    const result = await StorageManager.migrateLegacyStorage(app);

    expect(result.migrated).toBe(true);

    const canonicalPath = StorageManager.getStateFilePath(app);
    expect(canonicalPath).toBe(".obsidian/github-vault-relay/state.json");
    expect(await app.vault.adapter.exists(canonicalPath)).toBe(true);

    const loaded = await StorageManager.loadState(app);
    expect(loaded.lastSyncedCommitSha).toBe("c3_legacy_commit_sha");
    expect(loaded.files["Note.md"]).toBeDefined();

    // Legacy file removed
    expect(await app.vault.adapter.exists(LEGACY_STATE_FILE)).toBe(false);
  });

  it("NS-005: Legacy conflicts migrate to .obsidian/github-vault-relay/conflicts and metadata", async () => {
    const conflictContent = "REMOTE VERSION OF CONFLICT NOTE";
    const ts = 1788438999027;
    const legacyConflictPath = `${LEGACY_ROOT_DIR}/conflicts/${ts}/c3-note.md`;

    await app.vault.adapter.write(LEGACY_STATE_FILE, JSON.stringify({ version: 1, files: {} }));
    await app.vault.adapter.write(legacyConflictPath, conflictContent);
    await app.vault.create("c3-note.md", "LOCAL DIFFERENT NOTE");

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    const canonicalConflicts = StorageManager.getConflictsDirPath(app);
    expect(canonicalConflicts).toBe(".obsidian/github-vault-relay/conflicts");

    const expectedDest = `${canonicalConflicts}/${ts}_c3-note.md`;
    expect(await app.vault.adapter.exists(expectedDest)).toBe(true);

    // Verify metadata created in canonical storage
    const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main" });
    const cm = new ConflictManager(app, { owner: "owner", repo: "repo", branch: "main", excludedPaths: [] }, client);
    const records = await cm.loadConflictRecords();

    expect(records.length).toBe(1);
    expect(records[0].path).toBe("c3-note.md");
    expect(records[0].snapshotPath).toBe(expectedDest);
  });

  it("NS-006: Mixed legacy + user content preserves user files and folder", async () => {
    // Legacy plugin artifacts
    await app.vault.adapter.write(LEGACY_STATE_FILE, JSON.stringify({ version: 1, files: {} }));
    await app.vault.adapter.write(`${LEGACY_CONFLICTS_DIR}/123/conflict.md`, "remote conflict");

    // User content in _vault-relay/
    await app.vault.adapter.write(`${LEGACY_ROOT_DIR}/personal-note.md`, "# User Note In Folder");
    await app.vault.adapter.write(`${LEGACY_ROOT_DIR}/nested/doc.md`, "Nested user doc");

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    // Recognized legacy artifacts removed
    expect(await app.vault.adapter.exists(LEGACY_STATE_FILE)).toBe(false);
    expect(await app.vault.adapter.exists(LEGACY_CONFLICTS_DIR)).toBe(false);

    // User files and folder PRESERVED
    expect(await app.vault.adapter.exists(`${LEGACY_ROOT_DIR}/personal-note.md`)).toBe(true);
    expect(await app.vault.adapter.exists(`${LEGACY_ROOT_DIR}/nested/doc.md`)).toBe(true);
    expect(await app.vault.adapter.exists(LEGACY_ROOT_DIR)).toBe(true);
  });

  it("NS-007: Cleanup removes ONLY recognized plugin artifacts", async () => {
    await app.vault.adapter.write(LEGACY_STATE_FILE, JSON.stringify({ version: 1, files: {} }));
    await app.vault.adapter.write(`${LEGACY_ROOT_DIR}/unrelated_file.txt`, "Random data");

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    // state.json removed
    expect(await app.vault.adapter.exists(LEGACY_STATE_FILE)).toBe(false);

    // unrelated_file.txt preserved
    expect(await app.vault.adapter.exists(`${LEGACY_ROOT_DIR}/unrelated_file.txt`)).toBe(true);
    expect(await app.vault.adapter.exists(LEGACY_ROOT_DIR)).toBe(true);
  });

  it("NS-008: Ambiguous _vault-relay is never deleted", async () => {
    // Only user files in _vault-relay, no valid state.json or conflicts
    await app.vault.adapter.write(`${LEGACY_ROOT_DIR}/my-notes.md`, "User content");

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(false);

    // Remains untouched
    expect(await app.vault.adapter.exists(`${LEGACY_ROOT_DIR}/my-notes.md`)).toBe(true);
    expect(await app.vault.adapter.exists(LEGACY_ROOT_DIR)).toBe(true);
  });

  it("NS-009: Plugin never recreates root _vault-relay or .obsidian/vault-relay", async () => {
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
    expect(await app.vault.adapter.exists(LEGACY_ROOT_DIR)).toBe(false);
    expect(await app.vault.adapter.exists(".obsidian/vault-relay")).toBe(false);

    // Canonical storage was used
    expect(await app.vault.adapter.exists(".obsidian/github-vault-relay/conflicts")).toBe(true);
  });

  it("NS-010: Intermediate .obsidian/vault-relay migrates to .obsidian/github-vault-relay", async () => {
    const interDir = ".obsidian/vault-relay";
    const interState = `${interDir}/state.json`;
    const interConflict = `${interDir}/conflicts/photo.png`;
    const interMeta = `${interDir}/conflicts_meta.json`;

    const binaryData = new Uint8Array([10, 20, 30, 40]);

    await app.vault.adapter.write(interState, JSON.stringify({ version: 1, lastSyncedCommitSha: "inter_sha", files: {} }));
    await app.vault.adapter.writeBinary(interConflict, binaryData.buffer as ArrayBuffer);
    await app.vault.adapter.write(interMeta, JSON.stringify([{ id: "rec1", path: "photo.png", localSha: "l1", remoteSha: "r1", detectedAt: 1000 }]));

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    // Canonical destination has all artifacts
    const canonicalState = StorageManager.getStateFilePath(app);
    expect(canonicalState).toBe(".obsidian/github-vault-relay/state.json");
    expect(await app.vault.adapter.exists(canonicalState)).toBe(true);

    const loaded = await StorageManager.loadState(app);
    expect(loaded.lastSyncedCommitSha).toBe("inter_sha");

    const canonicalConflict = ".obsidian/github-vault-relay/conflicts/photo.png";
    expect(await app.vault.adapter.exists(canonicalConflict)).toBe(true);
    const readBinary = await app.vault.adapter.readBinary(canonicalConflict);
    expect(new Uint8Array(readBinary)).toEqual(binaryData);

    const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main" });
    const cm = new ConflictManager(app, { owner: "owner", repo: "repo", branch: "main", excludedPaths: [] }, client);
    const meta = await cm.loadConflictRecords();
    expect(meta.length).toBe(1);
    expect(meta[0].path).toBe("photo.png");

    // Old intermediate directory removed
    expect(await app.vault.adapter.exists(interDir)).toBe(false);
  });

  it("NS-011: Final state survives restart", async () => {
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

  it("NS-012: Only .obsidian/github-vault-relay remains as canonical storage", async () => {
    const dir = StorageManager.getPluginStorageDir(app);
    expect(dir).toBe(".obsidian/github-vault-relay");
    expect(dir.includes(".obsidian/vault-relay")).toBe(false);

    // Migrate any leftovers
    await StorageManager.migrateLegacyStorage(app);

    // Verify neither legacy nor intermediate exist
    expect(await app.vault.adapter.exists(LEGACY_ROOT_DIR)).toBe(false);
    expect(await app.vault.adapter.exists(".obsidian/vault-relay")).toBe(false);
  });
});
