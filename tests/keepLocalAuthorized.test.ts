import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, PluginManifest } from "obsidian";
import VaultRelayPlugin from "../src/main";
import { GitHubClient } from "../src/github/githubClient";
import { ConflictManager, ConflictRecord } from "../src/sync/conflictManager";
import { PushEngine } from "../src/sync/pushEngine";
import { SyncEngine } from "../src/sync/syncEngine";
import { StorageManager } from "../src/sync/storageManager";
import { calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { VaultRelaySettings } from "../src/settings";

describe("C4 W5-A Authorized Keep Local Resolution (W5-KL-001..010)", () => {
  let app: App;
  let plugin: VaultRelayPlugin;
  const settings: VaultRelaySettings = {
    owner: "octocat",
    repo: "notes",
    branch: "main",
    excludedPaths: [".obsidian/", ".git/", "_fit/"],
  };

  beforeEach(async () => {
    app = new App();
    const manifest: PluginManifest = {
      id: "github-vault-relay",
      name: "GitHub Vault Relay",
      version: "0.4.0",
      minAppVersion: "1.0.0",
      author: "Test",
      description: "Test",
    };
    plugin = new VaultRelayPlugin(app, manifest);
    plugin.settings = { ...settings };
  });

  // W5-KL-001: reviewed conflict + Keep Local succeeds
  it("W5-KL-001: reviewed conflict + Keep Local succeeds", async () => {
    const fileContent = "# Local Resolution Text\n";
    await app.vault.create("Conflict.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    let createdCommitParent: string[] = [];
    let updatedRefSha = "";
    let uploadedBlobContent = "";

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string; body?: unknown }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: { sha: "commit_base_001", commit: { tree: { sha: "tree_base_001" } } },
          },
        };
      }
      if (params.url.includes("/git/trees/commit_new_001")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new_001",
            truncated: false,
            tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: localSha, size: fileContent.length }],
          },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_001" } };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_base_001",
            truncated: false,
            tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: "old_remote_blob_001", size: 20 }],
          },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        const bodyObj = typeof params.body === "string" ? JSON.parse(params.body) : params.body;
        uploadedBlobContent = (bodyObj as { content: string }).content;
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        const bodyObj = typeof params.body === "string" ? JSON.parse(params.body) : params.body;
        createdCommitParent = (bodyObj as { parents: string[] }).parents;
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new_001" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        const bodyObj = typeof params.body === "string" ? JSON.parse(params.body) : params.body;
        updatedRefSha = (bodyObj as { sha: string }).sha;
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new_001" } } };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new_001" } } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_kl_001",
      path: "Conflict.md",
      localSha,
      remoteSha: "old_remote_blob_001",
      remoteCommitSha: "commit_base_001",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const result = await manager.resolveKeepLocal(record);
    expect(result.success).toBe(true);
    expect(result.message).toContain("Successfully pushed local version");

    // Commit and ref checks
    expect(createdCommitParent).toEqual(["commit_base_001"]);
    expect(updatedRefSha).toBe("commit_new_001");
    expect(uploadedBlobContent.length).toBeGreaterThan(0);

    // Conflict metadata is cleared
    const remaining = await manager.loadConflictRecords();
    expect(remaining.length).toBe(0);

    // Baseline updated
    const state = await StorageManager.loadState(app);
    expect(state.lastSyncedCommitSha).toBe("commit_new_001");
    expect(state.files["Conflict.md"]).toBeDefined();
    expect(state.files["Conflict.md"].localSha).toBe(localSha);
    expect(state.files["Conflict.md"].remoteSha).toBe(localSha);
  });

  // W5-KL-002: POTENTIAL_CONFLICT normal Safe Push remains blocked
  it("W5-KL-002: POTENTIAL_CONFLICT normal Safe Push remains blocked", async () => {
    const fileContent = "# Conflicted Note\n";
    await app.vault.create("Conflicted.md", fileContent);

    // Baseline has base_sha, remote has remote_sha -> POTENTIAL_CONFLICT
    await StorageManager.saveState(app, {
      version: 1,
      lastSyncedCommitSha: "base_commit",
      lastSyncedAt: Date.now() - 10000,
      files: {
        "Conflicted.md": {
          localSha: "old_base_sha",
          remoteSha: "old_base_sha",
          syncedAt: Date.now() - 10000,
        },
      },
    });

    let commitCreated = false;
    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: { sha: "remote_head_commit", commit: { tree: { sha: "remote_tree" } } },
          },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "remote_tree",
            truncated: false,
            tree: [{ path: "Conflicted.md", mode: "100644", type: "blob", sha: "different_remote_sha", size: 20 }],
          },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        commitCreated = true;
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "new_commit" } };
      }
      throw new Error("Unhandled URL: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, settings, client);

    const report = await pushEngine.executeSafePush();

    // Invariant: POTENTIAL_CONFLICT was blocked and NOT pushed
    expect(report.counts.skippedConflicts).toBe(1);
    expect(commitCreated).toBe(false);
    const conflictedResult = report.results.find((r) => r.path === "Conflicted.md");
    expect(conflictedResult?.action).toBe("SKIP_CONFLICT");
    expect(conflictedResult?.status).toBe("BLOCKED_CONFLICT");

    // Baseline remains untouched
    const stateAfter = await StorageManager.loadState(app);
    expect(stateAfter.lastSyncedCommitSha).toBe("base_commit");
    expect(stateAfter.files["Conflicted.md"].localSha).toBe("old_base_sha");
  });

  // W5-KL-003: explicit Keep Local authorization affects only reviewed path
  it("W5-KL-003: explicit Keep Local authorization affects only reviewed path", async () => {
    await app.vault.create("Conflict1.md", "# Resolved One\n");
    await app.vault.create("Conflict2.md", "# Unresolved Two\n");
    await app.vault.create("UnpushedLocal.md", "# Not in conflict\n");

    const localSha1 = await calculateRawGitBlobSha(new TextEncoder().encode("# Resolved One\n"));

    let pushedTreePaths: string[] = [];
    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string; body?: unknown }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_head", commit: { tree: { sha: "tree_head" } } } },
        };
      }
      if (params.url.includes("/git/trees/commit_new")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new", truncated: false, tree: [{ path: "Conflict1.md", mode: "100644", type: "blob", sha: localSha1, size: 10 }] },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        const bodyObj = typeof params.body === "string" ? JSON.parse(params.body) : params.body;
        pushedTreePaths = ((bodyObj as { tree: Array<{ path: string }> }).tree || []).map((t) => t.path);
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new" } };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_head",
            truncated: false,
            tree: [
              { path: "Conflict1.md", mode: "100644", type: "blob", sha: "remote_sha_1", size: 10 },
              { path: "Conflict2.md", mode: "100644", type: "blob", sha: "remote_sha_2", size: 10 },
            ],
          },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha1 } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new" } } };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new" } } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record1: ConflictRecord = {
      id: "c1",
      path: "Conflict1.md",
      localSha: localSha1,
      remoteSha: "remote_sha_1",
      remoteCommitSha: "commit_head",
      detectedAt: Date.now(),
    };
    const record2: ConflictRecord = {
      id: "c2",
      path: "Conflict2.md",
      localSha: "sha_local_2",
      remoteSha: "remote_sha_2",
      remoteCommitSha: "commit_head",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record1, record2]);

    const res = await manager.resolveKeepLocal(record1);
    expect(res.success).toBe(true);

    // Invariant: ONLY Conflict1.md was pushed in the tree
    expect(pushedTreePaths).toEqual(["Conflict1.md"]);

    // Conflict2.md record remains untouched
    const remaining = await manager.loadConflictRecords();
    expect(remaining.length).toBe(1);
    expect(remaining[0].path).toBe("Conflict2.md");
  });

  // W5-KL-004: remote changes after review → Keep Local blocks
  it("W5-KL-004: remote changes after review → Keep Local blocks", async () => {
    await app.vault.create("Conflict.md", "# Content\n");
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode("# Content\n"));

    let commitCalled = false;
    let refPatchCalled = false;

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_raced_ahead" } },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        commitCalled = true;
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        refPatchCalled = true;
      }
      throw new Error("Unhandled URL: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_stale_remote",
      path: "Conflict.md",
      localSha,
      remoteSha: "remote_sha_old",
      remoteCommitSha: "commit_reviewed_old",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const res = await manager.resolveKeepLocal(record);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Remote branch changed concurrently/i);

    // Zero mutations occurred
    expect(commitCalled).toBe(false);
    expect(refPatchCalled).toBe(false);

    // Record preserved
    const records = await manager.loadConflictRecords();
    expect(records.length).toBe(1);
  });

  // W5-KL-005: local changes after review → Keep Local blocks
  it("W5-KL-005: local changes after review → Keep Local blocks", async () => {
    const originalContent = "# Reviewed Local Content\n";
    const file = await app.vault.create("Conflict.md", originalContent);
    const reviewedSha = await calculateRawGitBlobSha(new TextEncoder().encode(originalContent));

    // User or external app edits file locally after review
    await app.vault.modify(file, "# Unreviewed Modifications\n");

    let blobCreated = false;
    let commitCreated = false;

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_same", commit: { tree: { sha: "tree_same" } } } },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_same", truncated: false, tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: "remote_sha", size: 10 }] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        blobCreated = true;
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        commitCreated = true;
      }
      throw new Error("Unhandled URL: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_local_race",
      path: "Conflict.md",
      localSha: reviewedSha,
      remoteSha: "remote_sha",
      remoteCommitSha: "commit_same",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const res = await manager.resolveKeepLocal(record);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Local file changed concurrently/i);

    // Invariant: Unreviewed bytes were never sent to GitHub
    expect(blobCreated).toBe(false);
    expect(commitCreated).toBe(false);

    // Conflict record preserved
    const records = await manager.loadConflictRecords();
    expect(records.length).toBe(1);
  });

  // W5-KL-006: successful Keep Local creates exactly one commit
  it("W5-KL-006: successful Keep Local creates exactly one commit", async () => {
    const fileContent = "# Exactly One Commit\n";
    await app.vault.create("Conflict.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    let commitCallCount = 0;
    let refPatchCallCount = 0;

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "base_commit_006", commit: { tree: { sha: "base_tree_006" } } } },
        };
      }
      if (params.url.includes("/git/trees/commit_new_006")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new_006", truncated: false, tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: localSha, size: 20 }] },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_006" } };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "base_tree_006", truncated: false, tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: "old_remote_006", size: 20 }] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        commitCallCount++;
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new_006" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        refPatchCallCount++;
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new_006" } } };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new_006" } } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_one_commit",
      path: "Conflict.md",
      localSha,
      remoteSha: "old_remote_006",
      remoteCommitSha: "base_commit_006",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const res = await manager.resolveKeepLocal(record);
    expect(res.success).toBe(true);

    // Exactly one commit and one ref update
    expect(commitCallCount).toBe(1);
    expect(refPatchCallCount).toBe(1);
  });

  // W5-KL-007: force:false remains mandatory
  it("W5-KL-007: force:false remains mandatory", async () => {
    const fileContent = "# Force False Invariant\n";
    await app.vault.create("Conflict.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    let passedForceFlag: boolean | undefined = undefined;

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string; body?: unknown }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "base_commit_007", commit: { tree: { sha: "base_tree_007" } } } },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_007" } };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "base_tree_007", truncated: false, tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: "old_remote_007", size: 20 }] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new_007" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        const bodyObj = typeof params.body === "string" ? JSON.parse(params.body) : params.body;
        passedForceFlag = (bodyObj as { force: boolean }).force;
        // Simulate GitHub refusing non-fast-forward push
        return { status: 422, headers: {}, text: "Update is not a fast forward", arrayBuffer: new ArrayBuffer(0), json: { message: "Update is not a fast forward" } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_force_check",
      path: "Conflict.md",
      localSha,
      remoteSha: "old_remote_007",
      remoteCommitSha: "base_commit_007",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const res = await manager.resolveKeepLocal(record);
    expect(res.success).toBe(false);

    // Invariant: force was explicitly false
    expect(passedForceFlag).toBe(false);
    expect(res.message).toMatch(/aborted ref update/i);

    // Baseline was not updated
    const state = await StorageManager.loadState(app);
    expect(state.lastSyncedCommitSha).toBeUndefined();
  });

  // W5-KL-008: baseline only updates after verified remote success
  it("W5-KL-008: baseline only updates after verified remote success", async () => {
    const fileContent = "# Verification Failure Guard\n";
    await app.vault.create("Conflict.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "base_commit_008", commit: { tree: { sha: "base_tree_008" } } } },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_008" } };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "base_tree_008", truncated: false, tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: "old_remote_008", size: 20 }] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new_008" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new_008" } } };
      }
      // Post-push verification returns an UNEXPECTED sha
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "unexpected_stale_sha" } } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_verify_fail",
      path: "Conflict.md",
      localSha,
      remoteSha: "old_remote_008",
      remoteCommitSha: "base_commit_008",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const res = await manager.resolveKeepLocal(record);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Post-push verification failed/i);

    // Invariant: Baseline NOT updated
    const state = await StorageManager.loadState(app);
    expect(state.lastSyncedCommitSha).not.toBe("commit_new_008");
    expect(state.files["Conflict.md"]).toBeUndefined();

    // Conflict record retained
    const records = await manager.loadConflictRecords();
    expect(records.length).toBe(1);
  });

  // W5-KL-009: conflict record removed only after success
  it("W5-KL-009: conflict record removed only after success", async () => {
    const fileContent = "# Metadata Removal Test\n";
    await app.vault.create("Conflict.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    let shouldSucceed = false;

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        if (!shouldSucceed) {
          return { status: 500, headers: {}, text: "Server Error", arrayBuffer: new ArrayBuffer(0), json: { message: "Server Error" } };
        }
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "base_commit_009", commit: { tree: { sha: "base_tree_009" } } } },
        };
      }
      if (params.url.includes("/git/trees/commit_new_009")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new_009", truncated: false, tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: localSha, size: 20 }] },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_009" } };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "base_tree_009", truncated: false, tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: "old_remote_009", size: 20 }] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new_009" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new_009" } } };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new_009" } } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_removal_test",
      path: "Conflict.md",
      localSha,
      remoteSha: "old_remote_009",
      remoteCommitSha: "base_commit_009",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    // 1. Attempt while server fails
    shouldSucceed = false;
    const failRes = await manager.resolveKeepLocal(record);
    expect(failRes.success).toBe(false);

    // Record remains
    let records = await manager.loadConflictRecords();
    expect(records.length).toBe(1);

    // 2. Attempt while server succeeds
    shouldSucceed = true;
    const successRes = await manager.resolveKeepLocal(record);
    expect(successRes.success).toBe(true);

    // Record is removed
    records = await manager.loadConflictRecords();
    expect(records.length).toBe(0);
  });

  // W5-KL-010: final Preview = UNCHANGED
  it("W5-KL-010: final Preview = UNCHANGED", async () => {
    const fileContent = "# Converged Final Note\n";
    await app.vault.create("Conflict.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    let remoteHeadSha = "base_commit_010";

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: remoteHeadSha,
              commit: { tree: { sha: remoteHeadSha === "base_commit_010" ? "tree_base_010" : "tree_new_010" } },
            },
          },
        };
      }
      if (params.url.includes("/git/trees/tree_new_010") || params.url.includes("/git/trees/commit_new_010")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new_010",
            truncated: false,
            tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: localSha, size: fileContent.length }],
          },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_010" } };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_base_010",
            truncated: false,
            tree: [{ path: "Conflict.md", mode: "100644", type: "blob", sha: "old_remote_sha_010", size: 20 }],
          },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new_010" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        remoteHeadSha = "commit_new_010";
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new_010" } } };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new_010" } } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_preview_unchanged",
      path: "Conflict.md",
      localSha,
      remoteSha: "old_remote_sha_010",
      remoteCommitSha: "base_commit_010",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    // Execute Keep Local
    const res = await manager.resolveKeepLocal(record);
    expect(res.success).toBe(true);

    // Run SyncEngine Preview
    const syncEngine = new SyncEngine(app, settings, client);
    const preview = await syncEngine.generatePreview();

    // Verify classification is UNCHANGED and zero conflicts remain
    expect(preview.counts.POTENTIAL_CONFLICT).toBe(0);
    expect(preview.counts.UNCHANGED).toBe(1);
    const conflictItem = preview.items.find((i) => i.path === "Conflict.md");
    expect(conflictItem?.category).toBe("UNCHANGED");
  });
});
