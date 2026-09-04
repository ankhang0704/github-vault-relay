/**
 * C5-RACE: Race Condition / Concurrency Matrix Tests
 *
 * Tests:
 * - double Sync lock
 * - double Keep Local
 * - double Use Remote
 * - double Keep Both
 * - Sync during conflict resolution
 * - reentrancy guards
 *
 * Required:
 * - no overlapping destructive mutations
 * - no duplicate commits
 * - no duplicate local writes
 * - stale reviewed state blocks safely
 */

import { describe, it, expect, beforeEach } from "vitest";
import { App, TFile } from "obsidian";
import { UnifiedSyncEngine } from "../src/sync/unifiedSyncEngine";
import { PushEngine } from "../src/sync/pushEngine";
import { ConflictManager, ConflictRecord } from "../src/sync/conflictManager";
import { GitHubClient } from "../src/github/githubClient";
import { VaultRelaySettings, DEFAULT_SETTINGS } from "../src/settings";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";

function makeSettings(): VaultRelaySettings {
  return { ...DEFAULT_SETTINGS, owner: "owner", repo: "repo", branch: "main" };
}

function makeNoopClient(): GitHubClient {
  return new GitHubClient({
    token: "github_pat_test_race",
    owner: "owner", repo: "repo", branch: "main",
    requestFn: async (params) => {
      const url = params.url;
      if (url.includes("/branches/")) {
        return {
          status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_race", commit: { tree: { sha: "tree_race" } } } },
          text: "",
        };
      }
      if (url.includes("/git/trees/")) {
        return {
          status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_race", tree: [], truncated: false },
          text: "",
        };
      }
      return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
    },
  });
}

describe("C5-RACE: Race / Concurrency Matrix (C5-RACE-001..012)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("C5-RACE-001: Double Sync invocation throws on second call", async () => {
    const settings = makeSettings();
    const client = makeNoopClient();
    const engine = new UnifiedSyncEngine(app, settings, client);

    // Start first sync (it will complete quickly with empty vault)
    const p1 = engine.executeSync();

    // Try to start second sync while first is running — should throw
    if (engine.isRunning) {
      await expect(engine.executeSync()).rejects.toThrow(/already in progress/);
    }

    // First sync should complete
    const result = await p1;
    expect(["PASS", "PASS_WITH_WARNINGS"]).toContain(result.status);
  });

  it("C5-RACE-002: Unified sync isSyncing flag resets after completion", async () => {
    const settings = makeSettings();
    const client = makeNoopClient();
    const engine = new UnifiedSyncEngine(app, settings, client);

    expect(engine.isRunning).toBe(false);
    await engine.executeSync();
    expect(engine.isRunning).toBe(false);
  });

  it("C5-RACE-003: Unified sync isSyncing resets even after failure", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => ({
        status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0),
        json: { message: "fail" }, text: "",
      }),
    });
    const engine = new UnifiedSyncEngine(app, settings, client);

    try {
      await engine.executeSync();
    } catch {
      // expected
    }
    expect(engine.isRunning).toBe(false);
  });

  it("C5-RACE-004: ConflictManager double Keep Local on same path blocks second call", async () => {
    const settings = makeSettings();
    const client = makeNoopClient();
    const cm = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "conflict_001",
      path: "notes/race.md",
      localSha: "sha_local",
      remoteSha: "sha_remote",
      detectedAt: Date.now(),
    };

    // Create the local file
    const content = new TextEncoder().encode("local content");
    await app.vault.createBinary("notes/race.md", content.buffer as ArrayBuffer);

    // Simulate in-flight resolution
    const result1Promise = cm.resolveKeepLocal(record);

    // Second call should detect in-flight and return failure
    const result2 = await cm.resolveKeepLocal(record);
    expect(result2.success).toBe(false);
    expect(result2.message).toContain("already in progress");

    await result1Promise;
  });

  it("C5-RACE-005: ConflictManager reentrancy guard prevents double Use Remote", async () => {
    const settings = makeSettings();
    const path = "notes/reentrant.md";
    const localContent = new TextEncoder().encode("local content");
    const remoteContent = new TextEncoder().encode("remote content");
    const localSha = await calculateCanonicalGitBlobSha(localContent, path);
    const remoteSha = await calculateRawGitBlobSha(remoteContent);
    await app.vault.createBinary(path, localContent.buffer as ArrayBuffer);

    let releaseBlob!: () => void;
    let markBlobStarted!: () => void;
    const blobGate = new Promise<void>((resolve) => { releaseBlob = resolve; });
    const blobStarted = new Promise<void>((resolve) => { markBlobStarted = resolve; });
    const client = new GitHubClient({
      token: "github_pat_test_reentrant",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_reviewed" } }, text: "",
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_reviewed", tree: [{ path, type: "blob", sha: remoteSha, mode: "100644" }], truncated: false }, text: "",
          };
        }
        if (params.url.includes("/git/blobs/")) {
          markBlobStarted();
          await blobGate;
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: remoteSha, content: Buffer.from(remoteContent).toString("base64"), encoding: "base64", size: remoteContent.length }, text: "",
          };
        }
        throw new Error(`Unhandled URL: ${params.url}`);
      },
    });
    const cm = new ConflictManager(app, settings, client);
    const record: ConflictRecord = {
      id: "conflict_reentrant",
      path,
      localSha,
      remoteSha,
      remoteCommitSha: "commit_reviewed",
      detectedAt: Date.now(),
    };

    const first = cm.resolveUseRemote(record);
    await blobStarted;
    expect(cm.isResolving(path)).toBe(true);
    const second = await cm.resolveUseRemote(record);
    expect(second.success).toBe(false);
    expect(second.message).toContain("already in progress");
    releaseBlob();
    expect((await first).success).toBe(true);
  });

  it("C5-RACE-006: ConflictManager resolvedRecordIds prevents re-resolution of same conflict", async () => {
    const settings = makeSettings();
    // Create a client that simulates blob fetch for Use Remote
    const remoteContent = new TextEncoder().encode("remote content");
    const remoteSha = await calculateRawGitBlobSha(remoteContent);
    const base64Content = btoa(String.fromCharCode(...remoteContent));

    const client = new GitHubClient({
      token: "github_pat_test_resolved",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_reviewed" } }, text: "",
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_reviewed", tree: [{ path: "notes/resolved.md", type: "blob", sha: remoteSha, mode: "100644" }], truncated: false }, text: "",
          };
        }
        if (params.url.includes("/git/blobs/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: remoteSha, content: base64Content, encoding: "base64", size: remoteContent.length, url: "" },
            text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
    const cm = new ConflictManager(app, settings, client);

    // Create local file
    const localContent = new TextEncoder().encode("local content");
    const localSha = await calculateCanonicalGitBlobSha(localContent, "notes/resolved.md");
    await app.vault.createBinary("notes/resolved.md", localContent.buffer as ArrayBuffer);

    // Save conflict record
    await cm.recordConflict("notes/resolved.md", localSha, remoteSha);

    const record: ConflictRecord = {
      id: "conflict_resolved_001",
      path: "notes/resolved.md",
      localSha,
      remoteSha,
      remoteCommitSha: "commit_reviewed",
      detectedAt: Date.now(),
    };

    // First resolution
    const result1 = await cm.resolveUseRemote(record);
    expect(result1.success).toBe(true);

    // Re-create local file for second attempt
    await app.vault.modifyBinary(
      app.vault.getAbstractFileByPath("notes/resolved.md") as TFile,
      localContent.buffer as ArrayBuffer
    );

    // Second resolution of SAME record ID should be blocked
    const result2 = await cm.resolveUseRemote(record);
    expect(result2.success).toBe(false);
    expect(result2.message).toContain("already been resolved");
  });

  it("C5-RACE-007: Local file changed after conflict review → Keep Local blocks stale push", async () => {
    const settings = makeSettings();
    const originalContent = new TextEncoder().encode("original local");
    const originalSha = await calculateCanonicalGitBlobSha(originalContent, "notes/stale.md");
    await app.vault.createBinary("notes/stale.md", originalContent.buffer as ArrayBuffer);

    // Modify the file after review (simulating race condition)
    const modifiedContent = new TextEncoder().encode("MODIFIED local");
    await app.vault.modifyBinary(
      app.vault.getAbstractFileByPath("notes/stale.md") as TFile,
      modifiedContent.buffer as ArrayBuffer
    );

    const record: ConflictRecord = {
      id: "conflict_stale",
      path: "notes/stale.md",
      localSha: originalSha, // Stale SHA from review time
      remoteSha: "remote_sha",
      detectedAt: Date.now(),
    };

    const client = new GitHubClient({
      token: "github_pat_test_stale",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_stale", commit: { tree: { sha: "tree_stale" } } } },
            text: "",
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_stale", tree: [{ path: "notes/stale.md", type: "blob", sha: "remote_sha", mode: "100644" }], truncated: false },
            text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });

    const cm = new ConflictManager(app, settings, client);
    const result = await cm.resolveKeepLocal(record);

    // Should fail because local SHA doesn't match reviewed SHA
    expect(result.success).toBe(false);
    expect(result.message).toContain("changed concurrently");
  });

  it("C5-RACE-008: Local file changed after conflict review → Use Remote blocks stale overwrite", async () => {
    const settings = makeSettings();
    const originalContent = new TextEncoder().encode("original local for use remote");
    const originalSha = await calculateCanonicalGitBlobSha(originalContent, "notes/stale-remote.md");
    await app.vault.createBinary("notes/stale-remote.md", originalContent.buffer as ArrayBuffer);

    // Modify after review
    const modifiedContent = new TextEncoder().encode("MODIFIED after review");
    await app.vault.modifyBinary(
      app.vault.getAbstractFileByPath("notes/stale-remote.md") as TFile,
      modifiedContent.buffer as ArrayBuffer
    );

    const record: ConflictRecord = {
      id: "conflict_stale_remote",
      path: "notes/stale-remote.md",
      localSha: originalSha,
      remoteSha: "remote_sha",
      detectedAt: Date.now(),
    };

    const client = makeNoopClient();
    const cm = new ConflictManager(app, settings, client);
    const result = await cm.resolveUseRemote(record);

    expect(result.success).toBe(false);
    expect(result.message).toContain("modified since conflict was reviewed");
  });

  it("C5-RACE-009: Unified Sync blocks a separate Safe Push instance", async () => {
    const settings = makeSettings();
    let releaseBranch!: () => void;
    let markBranchStarted!: () => void;
    const branchGate = new Promise<void>((resolve) => { releaseBranch = resolve; });
    const branchStarted = new Promise<void>((resolve) => { markBranchStarted = resolve; });
    let firstBranch = true;
    const client = new GitHubClient({
      token: "github_pat_test_cross_engine",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          if (firstBranch) {
            firstBranch = false;
            markBranchStarted();
            await branchGate;
          }
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_cross" } },
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_cross", tree: [], truncated: false },
          };
        }
        throw new Error(`Unhandled URL: ${params.url}`);
      },
    });

    const sync = new UnifiedSyncEngine(app, settings, client).executeSync();
    await branchStarted;
    const push = await new PushEngine(app, settings, client).executeSafePush();

    expect(push.status).toBe("ABORTED");
    expect(push.summaryMessage).toContain("another vault mutation");
    releaseBranch();
    expect((await sync).status).toBe("PASS");
  });

  it("C5-RACE-010: Unified Sync blocks conflict resolution from another manager", async () => {
    const settings = makeSettings();
    let releaseBranch!: () => void;
    let markBranchStarted!: () => void;
    const branchGate = new Promise<void>((resolve) => { releaseBranch = resolve; });
    const branchStarted = new Promise<void>((resolve) => { markBranchStarted = resolve; });
    let firstBranch = true;
    const client = new GitHubClient({
      token: "github_pat_test_sync_conflict",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          if (firstBranch) {
            firstBranch = false;
            markBranchStarted();
            await branchGate;
          }
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_cross" } },
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_cross", tree: [], truncated: false },
          };
        }
        throw new Error(`Unhandled URL: ${params.url}`);
      },
    });
    const sync = new UnifiedSyncEngine(app, settings, client).executeSync();
    await branchStarted;
    const manager = new ConflictManager(app, settings, client);
    const blocked = await manager.resolveKeepBoth({
      id: "blocked_conflict",
      path: "blocked.md",
      localSha: "local",
      remoteSha: "remote",
      detectedAt: Date.now(),
    });

    expect(blocked.success).toBe(false);
    expect(blocked.message).toContain("Another vault mutation");
    releaseBranch();
    expect((await sync).status).toBe("PASS");
  });

  it("C5-RACE-011: two ConflictManager instances create only one Keep Both copy", async () => {
    const settings = makeSettings();
    const path = "notes/two-managers.md";
    const localBytes = new TextEncoder().encode("local reviewed\n");
    const remoteBytes = new TextEncoder().encode("remote reviewed\n");
    const localSha = await calculateCanonicalGitBlobSha(localBytes, path);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);
    await app.vault.createBinary(path, localBytes.buffer as ArrayBuffer);
    let releaseBlob!: () => void;
    let markBlobStarted!: () => void;
    const blobGate = new Promise<void>((resolve) => { releaseBlob = resolve; });
    const blobStarted = new Promise<void>((resolve) => { markBlobStarted = resolve; });
    const client = new GitHubClient({
      token: "github_pat_test_two_managers",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_reviewed" } },
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_reviewed", tree: [{ path, type: "blob", mode: "100644", sha: remoteSha }], truncated: false },
          };
        }
        if (params.url.includes("/git/blobs/")) {
          markBlobStarted();
          await blobGate;
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: remoteSha, content: Buffer.from(remoteBytes).toString("base64"), encoding: "base64", size: remoteBytes.byteLength },
          };
        }
        throw new Error(`Unhandled URL: ${params.url}`);
      },
    });
    const record: ConflictRecord = {
      id: "two_managers",
      path,
      localSha,
      remoteSha,
      remoteCommitSha: "commit_reviewed",
      detectedAt: Date.now(),
    };
    const first = new ConflictManager(app, settings, client).resolveKeepBoth(record);
    await blobStarted;
    const second = await new ConflictManager(app, settings, client).resolveKeepBoth(record);

    expect(second.success).toBe(false);
    expect(second.message).toContain("Another vault mutation");
    releaseBlob();
    expect((await first).success).toBe(true);
    expect(app.vault.getFiles().filter((file) => file.path.includes("remote conflict"))).toHaveLength(1);
  });

  it("C5-RACE-012: remote edit after review blocks Keep Local before PATCH", async () => {
    const settings = makeSettings();
    const path = "notes/remote-race.md";
    const localBytes = new TextEncoder().encode("local reviewed\n");
    const localSha = await calculateCanonicalGitBlobSha(localBytes, path);
    await app.vault.createBinary(path, localBytes.buffer as ArrayBuffer);
    let patchCount = 0;
    const client = new GitHubClient({
      token: "github_pat_test_remote_race",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_advanced" } },
          };
        }
        if (params.method === "PATCH") patchCount++;
        throw new Error(`Unexpected URL: ${params.url}`);
      },
    });
    const result = await new ConflictManager(app, settings, client).resolveKeepLocal({
      id: "remote_race",
      path,
      localSha,
      remoteSha: "remote_reviewed",
      remoteCommitSha: "commit_reviewed",
      detectedAt: Date.now(),
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Remote branch changed concurrently");
    expect(patchCount).toBe(0);
  });
});
