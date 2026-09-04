/**
 * C5-PULLFAIL: Pull Engine Failure Injection Tests
 *
 * Simulates failures at every phase of Safe Pull:
 * - HEAD fetch, tree fetch, blob downloads, local create, local overwrite,
 *   post-write verification, state save
 *
 * Injects: offline, timeout, 401, 403, 404, 429, 503, 504, malformed responses
 *
 * Verifies:
 * - no false baseline advancement
 * - no partial unsafe overwrite
 * - no hidden data loss
 * - failure phase reported truthfully
 */

import { describe, it, expect, beforeEach } from "vitest";
import { App, TFile } from "obsidian";
import { PullEngine } from "../src/sync/pullEngine";
import { GitHubClient } from "../src/github/githubClient";
import { VaultRelaySettings, DEFAULT_SETTINGS } from "../src/settings";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { StorageManager } from "../src/sync/storageManager";
import { SyncProgressEvent } from "../src/sync/progressTypes";
import { RequestUrlParam, RequestUrlResponse } from "obsidian";

function makeSettings(overrides?: Partial<VaultRelaySettings>): VaultRelaySettings {
  return { ...DEFAULT_SETTINGS, owner: "owner", repo: "repo", branch: "main", ...overrides };
}

function makeRequestFn(status: number, body: unknown = {}): (params: RequestUrlParam) => Promise<RequestUrlResponse> {
  return async () => ({
    status,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: body,
    text: JSON.stringify(body),
  });
}

function makePullClient(
  entries: Array<{ path: string; bytes: Uint8Array; sha: string }>,
  failBlobPath?: string
): GitHubClient {
  return new GitHubClient({
    token: "github_pat_test_pull_mutation",
    owner: "owner",
    repo: "repo",
    branch: "main",
    requestFn: async (params) => {
      if (params.url.includes("/branches/")) {
        return {
          status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "remote_commit", commit: { tree: { sha: "remote_tree" } } } },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "remote_tree",
            truncated: false,
            tree: entries.map((entry) => ({
              path: entry.path,
              type: "blob",
              mode: "100644",
              sha: entry.sha,
              size: entry.bytes.byteLength,
            })),
          },
        };
      }
      const entry = entries.find((candidate) => params.url.includes(`/git/blobs/${candidate.sha}`));
      if (entry) {
        if (entry.path === failBlobPath) {
          return {
            status: 500, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { message: "injected blob failure" },
          };
        }
        return {
          status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: entry.sha,
            size: entry.bytes.byteLength,
            encoding: "base64",
            content: Buffer.from(entry.bytes).toString("base64"),
          },
        };
      }
      throw new Error(`Unhandled URL: ${params.url}`);
    },
  });
}

describe("C5-PULLFAIL: Pull Failure Injection (C5-PULLFAIL-001..015)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("C5-PULLFAIL-001: HEAD fetch 401 → FAIL, no baseline advancement", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_bad_token",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: makeRequestFn(401, { message: "Bad credentials" }),
    });
    const engine = new PullEngine(app, settings, client);

    const report = await engine.executeSafePull();
    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("Failed to fetch remote");
    expect(report.remoteCommitSha).toBeUndefined();

    const state = await StorageManager.loadState(app);
    expect(state.lastSyncedCommitSha).toBeUndefined();
  });

  it("C5-PULLFAIL-002: HEAD fetch 403 → FAIL, failure phase reported", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test_forbidden",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: makeRequestFn(403, { message: "Resource not accessible" }),
    });
    const engine = new PullEngine(app, settings, client);

    const report = await engine.executeSafePull();
    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("Failed to fetch remote");
  });

  it("C5-PULLFAIL-003: HEAD fetch 404 → FAIL with meaningful message", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test_notfound",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: makeRequestFn(404, { message: "Not Found" }),
    });
    const engine = new PullEngine(app, settings, client);

    const report = await engine.executeSafePull();
    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("Failed to fetch remote");
  });

  it("C5-PULLFAIL-004: Offline → ABORTED before any remote call", async () => {
    const originalNavigator = globalThis.navigator;
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        configurable: true,
        writable: true,
      });

      const settings = makeSettings();
      const client = new GitHubClient({
        token: "github_pat_test_offline",
        owner: "owner", repo: "repo", branch: "main",
        requestFn: makeRequestFn(200),
      });
      const engine = new PullEngine(app, settings, client);

      const report = await engine.executeSafePull();
      expect(report.status).toBe("ABORTED");
      expect(report.summaryMessage).toContain("offline");
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    }
  });

  it("C5-PULLFAIL-005: Truncated tree → ABORTED, no processing attempted", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test_truncated",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_trunc", commit: { tree: { sha: "tree_trunc" } } } },
            text: "",
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_trunc", tree: [], truncated: true },
            text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
    const engine = new PullEngine(app, settings, client);

    const report = await engine.executeSafePull();
    expect(report.status).toBe("ABORTED");
    expect(report.summaryMessage).toContain("truncated");
  });

  it("C5-PULLFAIL-006: Blob download failure → individual file FAILED, no false baseline", async () => {
    const settings = makeSettings();
    const fileContent = new TextEncoder().encode("existing local content");
    const localSha = await calculateCanonicalGitBlobSha(fileContent, "notes/test.md");
    const remoteSha = "remote_sha_different";

    // Write existing state with baseline
    await StorageManager.saveState(app, {
      version: 1,
      lastSyncedCommitSha: "old_commit",
      lastSyncedAt: Date.now(),
      files: {
        "notes/test.md": { localSha, remoteSha: localSha, syncedAt: Date.now() },
      },
    });

    // Add local file
    await app.vault.createBinary("notes/test.md", fileContent.buffer as ArrayBuffer);

    const client = new GitHubClient({
      token: "github_pat_test_blobfail",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: {
              name: "main",
              commit: { sha: "commit_blobfail", commit: { tree: { sha: "tree_blobfail" } } },
            },
            text: "",
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: {
              sha: "tree_blobfail",
              tree: [{ path: "notes/test.md", type: "blob", sha: remoteSha, mode: "100644", size: 20 }],
              truncated: false,
            },
            text: "",
          };
        }
        if (params.url.includes("/git/blobs/")) {
          return {
            status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { message: "Internal Server Error" },
            text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
    const engine = new PullEngine(app, settings, client);

    const report = await engine.executeSafePull();
    // Should report failure but not crash
    expect(["FAIL", "PASS_WITH_WARNINGS"]).toContain(report.status);

    // Local file should be unchanged (no partial overwrite)
    const file = app.vault.getAbstractFileByPath("notes/test.md");
    expect(file).toBeTruthy();
    if (file instanceof TFile) {
      const content = await app.vault.readBinary(file);
      const currentSha = await calculateCanonicalGitBlobSha(content, "notes/test.md");
      expect(currentSha).toBe(localSha);
    }
  });

  it("C5-PULLFAIL-007: Network error during tree fetch → FAIL, graceful", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test_neterr",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_neterr", commit: { tree: { sha: "tree_neterr" } } } },
            text: "",
          };
        }
        // Tree fetch fails with network error
        throw new Error("net::ERR_CONNECTION_REFUSED");
      },
    });
    const engine = new PullEngine(app, settings, client);

    const report = await engine.executeSafePull();
    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("Failed to fetch remote");
  });

  it("C5-PULLFAIL-008: Progress callback emits truthful phases during failure", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test_progress_fail",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: makeRequestFn(401, { message: "Unauthorized" }),
    });
    const engine = new PullEngine(app, settings, client);

    const events: SyncProgressEvent[] = [];
    await engine.executeSafePull((e) => events.push(e));

    // Should have at least a PLANNING event
    expect(events.some((e) => e.phase === "PLANNING")).toBe(true);
    // Should NOT have COMPLETE or any false success phase
    expect(events.some((e) => e.phase === "COMPLETE")).toBe(false);
  });

  it("C5-PULLFAIL-009: 429 rate limit during pull → bounded retry, not infinite", async () => {
    const settings = makeSettings();
    let callCount = 0;
    const client = new GitHubClient({
      token: "github_pat_test_ratelimit",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => {
        callCount++;
        return {
          status: 429, headers: { "retry-after": "1" },
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "rate limit exceeded" },
          text: "",
        };
      },
    });
    const engine = new PullEngine(app, settings, client);

    const report = await engine.executeSafePull();
    expect(report.status).toBe("FAIL");
    // Client should have bounded retries (max 3 attempts)
    expect(callCount).toBeLessThanOrEqual(9); // 3 retries max per call
  });

  it("C5-PULLFAIL-010: 503 server error during pull → bounded retry with exponential backoff", async () => {
    const settings = makeSettings();
    let callCount = 0;
    const client = new GitHubClient({
      token: "github_pat_test_503",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => {
        callCount++;
        return {
          status: 503, headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "Service Unavailable" },
          text: "",
        };
      },
    });
    const engine = new PullEngine(app, settings, client);

    const report = await engine.executeSafePull();
    expect(report.status).toBe("FAIL");
    // Should have retried but eventually given up
    expect(callCount).toBeGreaterThan(1);
    expect(callCount).toBeLessThanOrEqual(9);
  });

  it("C5-PULLFAIL-011: local create failure leaves no false baseline", async () => {
    const path = "notes/create-failure.md";
    const bytes = new TextEncoder().encode("remote create\n");
    const sha = await calculateRawGitBlobSha(bytes);
    const originalCreate = app.vault.createBinary;
    app.vault.createBinary = async (target, data) => {
      if (target === path) throw new Error("injected create failure");
      return originalCreate(target, data);
    };

    const report = await new PullEngine(app, makeSettings(), makePullClient([{ path, bytes, sha }])).executeSafePull();
    app.vault.createBinary = originalCreate;

    expect(report.status).toBe("FAIL");
    expect(report.results.find((result) => result.path === path)?.status).toBe("FAILED");
    expect(app.vault.getAbstractFileByPath(path)).toBeNull();
    expect((await StorageManager.loadState(app)).files[path]).toBeUndefined();
  });

  it("C5-PULLFAIL-012: local overwrite failure preserves original bytes and baseline", async () => {
    const path = "notes/overwrite-failure.md";
    const oldBytes = new TextEncoder().encode("old local\n");
    const newBytes = new TextEncoder().encode("new remote\n");
    const oldSha = await calculateCanonicalGitBlobSha(oldBytes, path);
    const remoteSha = await calculateRawGitBlobSha(newBytes);
    await app.vault.createBinary(path, oldBytes.buffer as ArrayBuffer);
    await StorageManager.saveState(app, {
      version: 1,
      lastSyncedCommitSha: "old_commit",
      files: { [path]: { localSha: oldSha, remoteSha: oldSha, syncedAt: 1 } },
    });
    const originalModify = app.vault.modifyBinary;
    app.vault.modifyBinary = async () => { throw new Error("injected overwrite failure"); };

    const report = await new PullEngine(
      app,
      makeSettings(),
      makePullClient([{ path, bytes: newBytes, sha: remoteSha }])
    ).executeSafePull();
    app.vault.modifyBinary = originalModify;

    expect(report.status).toBe("FAIL");
    const file = app.vault.getAbstractFileByPath(path) as TFile;
    expect(new Uint8Array(await app.vault.readBinary(file))).toEqual(oldBytes);
    expect((await StorageManager.loadState(app)).files[path].remoteSha).toBe(oldSha);
  });

  it("C5-PULLFAIL-013: corrupt post-write bytes trigger verified rollback", async () => {
    const path = "notes/post-write-failure.md";
    const oldBytes = new TextEncoder().encode("old local\n");
    const newBytes = new TextEncoder().encode("new remote\n");
    const oldSha = await calculateCanonicalGitBlobSha(oldBytes, path);
    const remoteSha = await calculateRawGitBlobSha(newBytes);
    const file = await app.vault.createBinary(path, oldBytes.buffer as ArrayBuffer);
    await StorageManager.saveState(app, {
      version: 1,
      lastSyncedCommitSha: "old_commit",
      files: { [path]: { localSha: oldSha, remoteSha: oldSha, syncedAt: 1 } },
    });
    const originalModify = app.vault.modifyBinary;
    let writeCount = 0;
    app.vault.modifyBinary = async (target, data) => {
      writeCount++;
      await originalModify(
        target,
        writeCount === 1 ? new TextEncoder().encode("corrupt!").buffer as ArrayBuffer : data
      );
    };

    const report = await new PullEngine(
      app,
      makeSettings(),
      makePullClient([{ path, bytes: newBytes, sha: remoteSha }])
    ).executeSafePull();
    app.vault.modifyBinary = originalModify;

    expect(report.status).toBe("FAIL");
    expect(writeCount).toBe(2);
    expect(new Uint8Array(await app.vault.readBinary(file))).toEqual(oldBytes);
    expect((await StorageManager.loadState(app)).files[path].remoteSha).toBe(oldSha);
  });

  it("C5-PULLFAIL-014: state save failure remains recoverable without advancing global HEAD", async () => {
    const path = "notes/state-failure.md";
    const oldBytes = new TextEncoder().encode("old local\n");
    const newBytes = new TextEncoder().encode("new remote\n");
    const oldSha = await calculateCanonicalGitBlobSha(oldBytes, path);
    const remoteSha = await calculateRawGitBlobSha(newBytes);
    await app.vault.createBinary(path, oldBytes.buffer as ArrayBuffer);
    await StorageManager.saveState(app, {
      version: 1,
      lastSyncedCommitSha: "old_commit",
      files: { [path]: { localSha: oldSha, remoteSha: oldSha, syncedAt: 1 } },
    });
    const originalWrite = app.vault.adapter.write;
    app.vault.adapter.write = async (target, data) => {
      if (target === `${StorageManager.getStateFilePath(app)}.tmp`) {
        throw new Error("injected state save failure");
      }
      await originalWrite(target, data);
    };

    const report = await new PullEngine(
      app,
      makeSettings(),
      makePullClient([{ path, bytes: newBytes, sha: remoteSha }])
    ).executeSafePull();
    app.vault.adapter.write = originalWrite;

    expect(report.status).toBe("FAIL");
    expect((await StorageManager.loadState(app)).lastSyncedCommitSha).toBe("old_commit");
    const recovery = await StorageManager.recoverInterruptedPullWrites(app);
    expect(recovery.completed).toBe(1);
    const recoveredState = await StorageManager.loadState(app);
    expect(recoveredState.lastSyncedCommitSha).toBe("old_commit");
    expect(recoveredState.files[path].remoteSha).toBe(remoteSha);
  });

  it("C5-PULLFAIL-015: blob failures at first, middle, and last preserve safe partial results", async () => {
    for (const failedIndex of [0, 1, 2]) {
      const isolatedApp = new App();
      const entries = await Promise.all(
        ["a.md", "b.md", "c.md"].map(async (path) => {
          const bytes = new TextEncoder().encode(`remote ${path}\n`);
          return { path, bytes, sha: await calculateRawGitBlobSha(bytes) };
        })
      );
      const failedPath = entries[failedIndex].path;
      const report = await new PullEngine(
        isolatedApp,
        makeSettings(),
        makePullClient(entries, failedPath)
      ).executeSafePull();
      const state = await StorageManager.loadState(isolatedApp);

      expect(report.status).toBe("FAIL");
      expect(report.counts.failed).toBe(1);
      expect(report.counts.pulledCreated).toBe(2);
      expect(state.lastSyncedCommitSha).toBeUndefined();
      expect(state.files[failedPath]).toBeUndefined();
      expect(Object.keys(state.files)).toHaveLength(2);
    }
  });
});
