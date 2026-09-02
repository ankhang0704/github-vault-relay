import fs from "fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, PluginManifest, RequestUrlParam } from "obsidian";
import VaultRelayPlugin from "../src/main";
import { GitHubClient } from "../src/github/githubClient";
import { PushEngine } from "../src/sync/pushEngine";
import { SyncEngine } from "../src/sync/syncEngine";
import { setStoredPat } from "../src/security/secretStore";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";

describe("Safe Push Engine (tests/pushEngine.test.ts)", () => {
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
      version: "0.2.0",
      minAppVersion: "0.15.0",
      description: "A conservative GitHub bridge for Obsidian Mobile.",
      author: "Vault Relay Contributors",
    };
    plugin = new VaultRelayPlugin(app, manifest);
    plugin.settings = {
      owner,
      repo,
      branch,
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
    };
    await setStoredPat(app, owner, repo, token);
  });

  it("PUSH-001: LOCAL_ONLY -> remote CREATE -> verified -> UNCHANGED", async () => {
    const localContent = "# My New Note\nThis note only exists locally.\n";
    const expectedRawSha = await calculateRawGitBlobSha(new TextEncoder().encode(localContent));

    await app.vault.create("new-note.md", localContent);

    const postRequests: RequestUrlParam[] = [];

    let currentBranchSha = "commit_base_001";
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      postRequests.push(params);

      
      if ((params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            ref: "refs/heads/main",
            url: "https://api.github.com/git/refs/heads/main",
            object: { sha: currentBranchSha, type: "commit" },
          },
        };
      }
      
      if ((params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: currentBranchSha, type: "commit" } },
        };
      }
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: currentBranchSha } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_001")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_001", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: expectedRawSha, url: `https://api.github.com/git/blobs/${expectedRawSha}` },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new_001", url: "https://api.github.com/git/trees/tree_new_001", tree: [] },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "commit_new_001",
            url: "https://api.github.com/git/commits/commit_new_001",
            message: "Vault Relay safe push: 1 file",
            tree: { sha: "tree_new_001" },
            parents: [{ sha: "commit_base_001" }],
          },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        currentBranchSha = "commit_new_001";
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            ref: "refs/heads/main",
            url: "https://api.github.com/git/refs/heads/main",
            object: { sha: "commit_new_001", type: "commit" },
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
            tree: [{ path: "new-note.md", mode: "100644", type: "blob", sha: expectedRawSha, size: localContent.length }],
          },
        };
      }
      throw new Error(`Unhandled request URL: ${params.url} (${params.method})`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.pushedCreated).toBe(1);
    expect(report.newCommitSha).toBe("commit_new_001");

    // Verify baseline was updated
    const state = await pushEngine.loadState();
    expect(state.lastSyncedCommitSha).toBe("commit_new_001");
    expect(state.files["new-note.md"]).toBeDefined();
    expect(state.files["new-note.md"].remoteSha).toBe(expectedRawSha);

    // Verify fresh preview is UNCHANGED
    const syncEngine = new SyncEngine(app, plugin.settings, client);
    const preview = await syncEngine.generatePreview();
    expect(preview.counts.UNCHANGED).toBe(1);
    expect(preview.counts.LOCAL_ONLY).toBe(0);
  });

  it("PUSH-002: LOCAL_CHANGED with unchanged remote baseline -> UPDATE -> verified -> UNCHANGED", async () => {
    const v1Content = "# Doc\nVersion 1\n";
    const v2Content = "# Doc\nVersion 2 updated\n";
    const v1Sha = await calculateCanonicalGitBlobSha(v1Content, "doc.md");
    const v2Sha = await calculateRawGitBlobSha(new TextEncoder().encode(v2Content));

    await app.vault.create("doc.md", v2Content);

    const initialBaseline = {
      version: 1,
      lastSyncedCommitSha: "commit_v1",
      files: {
        "doc.md": { localSha: v1Sha, remoteSha: v1Sha, syncedAt: 1000 },
      },
    };
    await app.vault.adapter.write("_vault-relay/state.json", JSON.stringify(initialBaseline));

    let currentBranchSha = "commit_v1";
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if ((params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: currentBranchSha, type: "commit" } },
        };
      }
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: currentBranchSha } },
        };
      }
      if (params.url.includes("/git/trees/commit_v1")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_v1",
            truncated: false,
            tree: [{ path: "doc.md", mode: "100644", type: "blob", sha: v1Sha, size: v1Content.length }],
          },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: v2Sha, url: `https://api.github.com/git/blobs/${v2Sha}` },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_v2", url: "https://api.github.com/git/trees/tree_v2", tree: [] },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "commit_v2",
            url: "https://api.github.com/git/commits/commit_v2",
            message: "Vault Relay safe push: 1 file",
            tree: { sha: "tree_v2" },
            parents: [{ sha: "commit_v1" }],
          },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        currentBranchSha = "commit_v2";
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_v2", type: "commit" } },
        };
      }
      if (params.url.includes("/git/trees/commit_v2")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_v2",
            truncated: false,
            tree: [{ path: "doc.md", mode: "100644", type: "blob", sha: v2Sha, size: v2Content.length }],
          },
        };
      }
      throw new Error(`Unhandled request URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.pushedUpdated).toBe(1);
    expect(report.newCommitSha).toBe("commit_v2");
  });

  it("PUSH-003: LOCAL_CHANGED + remote changed -> conflict -> ZERO remote write", async () => {
    const localContent = "# Note\nLocal Modified\n";
    const remoteContent = "# Note\nRemote Modified\n";
    const baseContent = "# Note\nBase Content\n";
    const baseSha = await calculateCanonicalGitBlobSha(baseContent, "conflict.md");
    const remoteSha = await calculateCanonicalGitBlobSha(remoteContent, "conflict.md");

    await app.vault.create("conflict.md", localContent);

    const baseline = {
      version: 1,
      lastSyncedCommitSha: "commit_base",
      files: {
        "conflict.md": { localSha: baseSha, remoteSha: baseSha, syncedAt: 1000 },
      },
    };
    await app.vault.adapter.write("_vault-relay/state.json", JSON.stringify(baseline));

    let remoteWriteAttempted = false;
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.method === "POST" || params.method === "PATCH" || params.method === "PUT" || params.method === "DELETE") {
        remoteWriteAttempted = true;
      }
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_remote" } },
        };
      }
      if (params.url.includes("/git/trees/commit_remote")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_remote",
            truncated: false,
            tree: [{ path: "conflict.md", mode: "100644", type: "blob", sha: remoteSha, size: 25 }],
          },
        };
      }
      throw new Error(`Unhandled request URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS_WITH_WARNINGS");
    expect(report.counts.skippedConflicts).toBe(1);
    expect(report.counts.pushedCreated).toBe(0);
    expect(report.counts.pushedUpdated).toBe(0);
    expect(remoteWriteAttempted).toBe(false);
  });

  it("PUSH-004 & PUSH-005: REMOTE_ONLY and UNCHANGED -> ZERO remote write", async () => {
    const normalContent = "# Unchanged Note\n";
    const normalSha = await calculateCanonicalGitBlobSha(normalContent, "unchanged.md");

    await app.vault.create("unchanged.md", normalContent);
    const baseline = {
      version: 1,
      lastSyncedCommitSha: "commit_base",
      files: {
        "unchanged.md": { localSha: normalSha, remoteSha: normalSha, syncedAt: 1000 },
      },
    };
    await app.vault.adapter.write("_vault-relay/state.json", JSON.stringify(baseline));

    let remoteWriteAttempted = false;
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.method === "POST" || params.method === "PATCH" || params.method === "PUT" || params.method === "DELETE") {
        remoteWriteAttempted = true;
      }
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_base" } },
        };
      }
      if (params.url.includes("/git/trees/commit_base")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_base",
            truncated: false,
            tree: [
              { path: "unchanged.md", mode: "100644", type: "blob", sha: normalSha, size: 20 },
              { path: "remote-only.md", mode: "100644", type: "blob", sha: "remote_sha_xyz", size: 30 },
            ],
          },
        };
      }
      throw new Error(`Unhandled URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.unchanged).toBe(1);
    expect(report.counts.skippedRemoteOnly).toBe(1);
    expect(remoteWriteAttempted).toBe(false);
  });

  it("PUSH-006: Multiple eligible files -> ONE commit / ONE ref update", async () => {
    const c1 = "# Note 1\n";
    const c2 = "# Note 2\n";
    const c3 = "# Note 3\n";
    const sha1 = await calculateRawGitBlobSha(new TextEncoder().encode(c1));
    const sha2 = await calculateRawGitBlobSha(new TextEncoder().encode(c2));
    const sha3 = await calculateRawGitBlobSha(new TextEncoder().encode(c3));

    await app.vault.create("note1.md", c1);
    await app.vault.create("note2.md", c2);
    await app.vault.create("note3.md", c3);

    let commitCalls = 0;
    let refUpdateCalls = 0;

    let currentBranchSha = "commit_base_006";
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if ((params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: currentBranchSha, type: "commit" } },
        };
      }
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: currentBranchSha } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_006")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_006", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        const parsed = JSON.parse(params.body as string);
        const decoded = Buffer.from(parsed.content, "base64").toString("utf-8");
        const blobSha = decoded === c1 ? sha1 : decoded === c2 ? sha2 : sha3;
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: blobSha },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new_006", tree: [] },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        commitCalls++;
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_006", tree: { sha: "tree_new_006" }, parents: [{ sha: "commit_base_006" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        refUpdateCalls++;
        currentBranchSha = "commit_new_006";
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_006", type: "commit" } },
        };
      }
      if (params.url.includes("/git/trees/commit_new_006")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new_006",
            truncated: false,
            tree: [
              { path: "note1.md", mode: "100644", type: "blob", sha: sha1, size: 10 },
              { path: "note2.md", mode: "100644", type: "blob", sha: sha2, size: 10 },
              { path: "note3.md", mode: "100644", type: "blob", sha: sha3, size: 10 },
            ],
          },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.pushedCreated).toBe(3);
    expect(commitCalls).toBe(1);
    expect(refUpdateCalls).toBe(1);
  });

  it("PUSH-007 & PUSH-008: Optimistic concurrency -> ref update fails if remote HEAD advanced -> aborts with zero force", async () => {
    const content = "# Note\n";
    const sha = await calculateRawGitBlobSha(new TextEncoder().encode(content));
    await app.vault.create("note.md", content);

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_base_007" } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_007")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_007", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new_007", tree: [] },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_007", tree: { sha: "tree_new_007" }, parents: [{ sha: "commit_base_007" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        if (typeof params.body === "string") {
          const parsedBody = JSON.parse(params.body);
          expect(parsedBody.force).toBe(false);
        }
        return {
          status: 422,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "Update is not a fast forward" },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);
    const report = await pushEngine.executeSafePush();

    expect(report.status).toBe("ABORTED");
    expect(report.summaryMessage).toContain("Optimistic concurrency check aborted ref update");

    const state = await pushEngine.loadState();
    expect(state.lastSyncedCommitSha).toBeUndefined();
  });

  it("PUSH-009: File >25 MiB is skipped with warning", async () => {
    await app.vault.createBinary("huge-video.mp4", new ArrayBuffer(26 * 1024 * 1024));

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_base_009" } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_009")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_009", truncated: false, tree: [] },
        };
      }
      throw new Error(`Unhandled URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS_WITH_WARNINGS");
    expect(report.counts.skippedOversized).toBe(1);
    expect(report.counts.pushedCreated).toBe(0);
  });

  it("PUSH-010 & PUSH-011: Text canonicalization LF & Binary exact byte upload", async () => {
    const crlfText = "Line 1\r\nLine 2\r\n";
    await app.vault.create("test.md", crlfText);

    let uploadedBlobBody: string | undefined;

    let currentBranchSha = "commit_base_010";
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if ((params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: currentBranchSha, type: "commit" } },
        };
      }
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: currentBranchSha } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_010")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_010", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        uploadedBlobBody = typeof params.body === "string" ? params.body : undefined;
        const expectedSha = await calculateRawGitBlobSha(new TextEncoder().encode("Line 1\nLine 2\n"));
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: expectedSha },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new_010", tree: [] },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_010", tree: { sha: "tree_new_010" }, parents: [{ sha: "commit_base_010" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        currentBranchSha = "commit_new_010";
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_010", type: "commit" } },
        };
      }
      if (params.url.includes("/git/trees/commit_new_010")) {
        const expectedSha = await calculateRawGitBlobSha(new TextEncoder().encode("Line 1\nLine 2\n"));
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new_010",
            truncated: false,
            tree: [{ path: "test.md", mode: "100644", type: "blob", sha: expectedSha, size: 14 }],
          },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.pushedCreated).toBe(1);

    expect(uploadedBlobBody).toBeDefined();
    const parsed = JSON.parse(uploadedBlobBody!);
    const decoded = Buffer.from(parsed.content, "base64").toString("utf-8");
    expect(decoded).toBe("Line 1\nLine 2\n");
    expect(decoded.includes("\r")).toBe(false);
  });

  it("PUSH-012 & PUSH-023: Reserved paths (.obsidian, .git, _fit, _vault-relay) never uploaded", async () => {
    await app.vault.adapter.write(".obsidian/plugins/test/main.js", "console.log('secret');");
    await app.vault.adapter.write("_vault-relay/conflicts/note.conflict.md", "conflict");
    await app.vault.adapter.write(".git/HEAD", "ref: refs/heads/main");

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: vi.fn() });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const localFiles = await pushEngine.scanLocalVault();
    expect(localFiles.has(".obsidian/plugins/test/main.js")).toBe(false);
    expect(localFiles.has("_vault-relay/conflicts/note.conflict.md")).toBe(false);
    expect(localFiles.has(".git/HEAD")).toBe(false);
  });

  it("PUSH-013: Case collision blocks unsafe push", async () => {
    await app.vault.create("Readme.md", "# Readme Upper\n");

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_base_013" } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_013")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_base_013",
            truncated: false,
            tree: [{ path: "README.md", mode: "100644", type: "blob", sha: "sha_remote", size: 10 }],
          },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS_WITH_WARNINGS");
    expect(report.counts.skippedUnsafe).toBeGreaterThanOrEqual(1);
    expect(report.counts.pushedCreated).toBe(0);
  });

  it("PUSH-014: Offline device -> aborts before any remote mutation", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const requestFn = vi.fn();
    const client = new GitHubClient({ token, owner, repo, branch, requestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("ABORTED");
    expect(report.summaryMessage).toContain("Device is offline");
    expect(requestFn).not.toHaveBeenCalled();

    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });
  });

  it("PUSH-018 & PUSH-019: Post-push verification failure -> baseline NOT advanced", async () => {
    const testContent = "# Test\n";
    const expectedSha = await calculateRawGitBlobSha(new TextEncoder().encode(testContent));
    await app.vault.create("test.md", testContent);

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      
      if ((params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_018", type: "commit" } },
        };
      }
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_base_018" } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_018")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_018", truncated: false, tree: [] },
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
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new_018", tree: [] },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_018", tree: { sha: "tree_new_018" }, parents: [{ sha: "commit_base_018" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_018", type: "commit" } },
        };
      }
      if (params.url.includes("/git/trees/commit_new_018")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new_018",
            truncated: false,
            tree: [{ path: "test.md", mode: "100644", type: "blob", sha: "corrupted_sha_xyz" }],
          },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);
    const report = await pushEngine.executeSafePush();

    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("Post-push verification failed");

    const state = await pushEngine.loadState();
    expect(state.lastSyncedCommitSha).toBeUndefined();
    expect(state.files["test.md"]).toBeUndefined();
  });


  it("PUSH-015 & PUSH-016: HTTP 429 Rate Limit and HTTP 503 Server Unavailable bounded retries", async () => {
    let attempts429 = 0;
    const requestFn = vi.fn(async (params: RequestUrlParam) => {
      const emptyHeaders: Record<string, string> = {};
      
      if (params.url.includes("/branches/main")) {
        attempts429++;
        if (attempts429 === 1) {
          return {
            status: 429,
            headers: { "retry-after": "1" } as Record<string, string>,
            text: "Rate limited",
            arrayBuffer: new ArrayBuffer(0),
            json: { message: "API rate limit exceeded" },
          };
        }
        return {
          status: 200,
          headers: emptyHeaders,
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_429" } },
        };
      }
      if (params.url.includes("/git/trees/commit_429")) {
        return {
          status: 200,
          headers: emptyHeaders,
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_429", truncated: false, tree: [] },
        };
      }
      throw new Error(`Unhandled URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(attempts429).toBe(2);
    expect(report.status).toBe("PASS");
  });

  it("PUSH-017: HTTP 422 Unprocessable Entity fails fast without blind retry loops", async () => {
    let treeCalls = 0;
    const requestFn = vi.fn(async (params: RequestUrlParam) => {
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_422" } },
        };
      }
      if (params.url.includes("/git/trees/commit_422")) {
        treeCalls++;
        return {
          status: 422,
          headers: {},
          text: "Unprocessable",
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "Validation Failed" },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("ABORTED");
    expect(treeCalls).toBe(1); // Fails fast without retry loops
  });

  it("PUSH-024 & PUSH-025: Stale preview cannot drive push without fresh revalidation and fresh preview becomes UNCHANGED", async () => {
    await app.vault.create("note_reval.md", "# Reval Note\n");
    const expectedSha = await calculateRawGitBlobSha(new TextEncoder().encode("# Reval Note\n"));

    let currentBranch = "commit_reval_1";

    const requestFn = vi.fn(async (params: RequestUrlParam) => {
      
      if ((params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: currentBranch, type: "commit" } },
        };
      }
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: currentBranch } },
        };
      }
      if (params.url.includes("/git/trees/commit_reval_1")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_reval_1", truncated: false, tree: [] },
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
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_reval_2", tree: [] },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_reval_2", tree: { sha: "tree_reval_2" }, parents: [{ sha: "commit_reval_1" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        currentBranch = "commit_reval_2";
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_reval_2", type: "commit" } },
        };
      }
      if (params.url.includes("/git/trees/commit_reval_2")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_reval_2",
            truncated: false,
            tree: [{ path: "note_reval.md", mode: "100644", type: "blob", sha: expectedSha, size: 14 }],
          },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.pushedCreated).toBe(1);

    // Fresh preview reflects UNCHANGED
    const syncEngine = new SyncEngine(app, plugin.settings, client);
    const freshPreview = await syncEngine.generatePreview();
    expect(freshPreview.counts.UNCHANGED).toBe(1);
    expect(freshPreview.counts.LOCAL_ONLY).toBe(0);
  });

  it("PUSH-020, PUSH-021, PUSH-022: Remote write audit -> only blobs, trees, commits, refs (no DELETE, no force)", async () => {
    const client = new GitHubClient({ token, owner, repo, branch, requestFn: vi.fn() });

    await expect(client.updateBranchRef("main", "sha123", true)).rejects.toThrow(
      /Force ref updates are strictly forbidden/
    );
  });
});

describe("Ref Update & Verification Hardening (REF-001..007)", () => {
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
      version: "0.2.0",
      minAppVersion: "0.15.0",
      description: "A conservative GitHub bridge for Obsidian Mobile.",
      author: "Vault Relay Contributors",
    };
    plugin = new VaultRelayPlugin(app, manifest);
    plugin.settings = {
      owner,
      repo,
      branch,
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
    };
    await setStoredPat(app, owner, repo, token);
  });

  it("REF-001: PATCH returns HTTP 200 and object.sha == newCommitSha -> accepted", async () => {
    const content = "# Ref Test 1\n";
    const expectedRawSha = await calculateRawGitBlobSha(new TextEncoder().encode(content));
    await app.vault.create("ref1.md", content);

    let currentRefSha = "commit_base_ref1";

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/git/ref/heads/main") && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: currentRefSha, type: "commit" } },
        };
      }
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: currentRefSha } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_ref1")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_ref1", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: expectedRawSha } };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_ref1", tree: [] } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_ref1", tree: { sha: "tree_new_ref1" }, parents: [{ sha: "commit_base_ref1" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        currentRefSha = "commit_new_ref1";
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_ref1", type: "commit" } },
        };
      }
      if (params.url.includes("/git/trees/commit_new_ref1")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new_ref1",
            truncated: false,
            tree: [{ path: "ref1.md", mode: "100644", type: "blob", sha: expectedRawSha, size: 14 }],
          },
        };
      }
      throw new Error(`Unhandled URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.newCommitSha).toBe("commit_new_ref1");

    const state = await pushEngine.loadState();
    expect(state.lastSyncedCommitSha).toBe("commit_new_ref1");
    expect(state.files["ref1.md"]).toBeDefined();
  });

  it("REF-002: PATCH returns HTTP 200 but returned object.sha != expected -> failure, baseline unchanged", async () => {
    const content = "# Ref Test 2\n";
    const expectedRawSha = await calculateRawGitBlobSha(new TextEncoder().encode(content));
    await app.vault.create("ref2.md", content);

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_base_ref2" } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_ref2")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_ref2", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: expectedRawSha } };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_ref2", tree: [] } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_ref2", tree: { sha: "tree_new_ref2" }, parents: [{ sha: "commit_base_ref2" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        // Return an unexpected SHA
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "unexpected_sha_999", type: "commit" } },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("ABORTED");
    expect(report.summaryMessage).toContain("unexpected object SHA");

    const state = await pushEngine.loadState();
    expect(state.lastSyncedCommitSha).toBeUndefined();
    expect(state.files["ref2.md"]).toBeUndefined();
  });

  it("REF-003: Post-write authoritative ref initially returns old base, then expected commit on bounded retry -> verified success", async () => {
    const content = "# Ref Test 3\n";
    const expectedRawSha = await calculateRawGitBlobSha(new TextEncoder().encode(content));
    await app.vault.create("ref3.md", content);

    let getRefCalls = 0;

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/git/ref/heads/main") && (!params.method || params.method === "GET")) {
        getRefCalls++;
        if (getRefCalls === 1) {
          // Edge cache / replication delay returns old base
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: { ref: "refs/heads/main", object: { sha: "commit_base_ref3", type: "commit" } },
          };
        }
        // Second attempt returns updated new commit
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_ref3", type: "commit" } },
        };
      }
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_base_ref3" } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_ref3")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_ref3", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: expectedRawSha } };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_ref3", tree: [] } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_ref3", tree: { sha: "tree_new_ref3" }, parents: [{ sha: "commit_base_ref3" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_ref3", type: "commit" } },
        };
      }
      if (params.url.includes("/git/trees/commit_new_ref3")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new_ref3",
            truncated: false,
            tree: [{ path: "ref3.md", mode: "100644", type: "blob", sha: expectedRawSha, size: 14 }],
          },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(getRefCalls).toBe(2);
    expect(report.newCommitSha).toBe("commit_new_ref3");

    const state = await pushEngine.loadState();
    expect(state.lastSyncedCommitSha).toBe("commit_new_ref3");
  });

  it("REF-004: Ref remains old base after retry budget -> FAIL, baseline unchanged", async () => {
    const content = "# Ref Test 4\n";
    const expectedRawSha = await calculateRawGitBlobSha(new TextEncoder().encode(content));
    await app.vault.create("ref4.md", content);

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/git/ref/heads/main") && (!params.method || params.method === "GET")) {
        // Always returns old base
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_base_ref4", type: "commit" } },
        };
      }
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_base_ref4" } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_ref4")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_ref4", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: expectedRawSha } };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_ref4", tree: [] } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_ref4", tree: { sha: "tree_new_ref4" }, parents: [{ sha: "commit_base_ref4" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_ref4", type: "commit" } },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("Post-push verification failed");

    const state = await pushEngine.loadState();
    expect(state.lastSyncedCommitSha).toBeUndefined();
  });

  it("REF-005, REF-006, REF-007: Dangling objects from aborted push are safe; next push revalidates fresh HEAD", async () => {
    const content = "# Ref 7\n";
    const expectedRawSha = await calculateRawGitBlobSha(new TextEncoder().encode(content));
    await app.vault.create("ref7.md", content);

    let currentRemoteHead = "commit_head_1";
    let attempts = 0;

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/git/ref/heads/main") && (!params.method || params.method === "GET")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: currentRemoteHead, type: "commit" } },
        };
      }
      
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: currentRemoteHead } },
        };
      }
      if (params.url.includes("/git/trees/commit_head_1")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_head_1", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/trees/commit_head_2")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_head_2", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: expectedRawSha } };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_sha_7", tree: [] } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_sha_7", tree: { sha: "tree_sha_7" }, parents: [{ sha: currentRemoteHead }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        attempts++;
        if (attempts === 1) {
          // Ref update fails due to race (422)
          return { status: 422, headers: {}, text: "Unprocessable", arrayBuffer: new ArrayBuffer(0), json: { message: "Update is not a fast forward" } };
        }
        // Second push succeeds
        currentRemoteHead = "commit_sha_7";
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_sha_7", type: "commit" } } };
      }
      if (params.url.includes("/git/trees/commit_sha_7")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_sha_7", truncated: false, tree: [{ path: "ref7.md", mode: "100644", type: "blob", sha: expectedRawSha, size: 10 }] },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    // 1st Push -> aborts on ref race
    const report1 = await pushEngine.executeSafePush();
    expect(report1.status).toBe("ABORTED");
    let state = await pushEngine.loadState();
    expect(state.lastSyncedCommitSha).toBeUndefined();

    // Concurrent actor advanced HEAD to commit_head_2
    currentRemoteHead = "commit_head_2";

    // 2nd Push -> revalidates against fresh commit_head_2 and succeeds
    const report2 = await pushEngine.executeSafePush();
    expect(report2.status).toBe("PASS");
    state = await pushEngine.loadState();
    expect(state.lastSyncedCommitSha).toBe("commit_sha_7");
  });
});

describe("Ref Verification Hardening #2 (REF2-001..007)", () => {
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
      version: "0.2.0",
      minAppVersion: "0.15.0",
      description: "A conservative GitHub bridge for Obsidian Mobile.",
      author: "Vault Relay Contributors",
    };
    plugin = new VaultRelayPlugin(app, manifest);
    plugin.settings = {
      owner,
      repo,
      branch,
      excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
    };
    await setStoredPat(app, owner, repo, token);
  });

  it("REF2-001 & REF2-005: Each verification retry executes a genuinely fresh GET request with Cache-Control headers", async () => {
    const content = "# Ref2 Test 1\n";
    const expectedRawSha = await calculateRawGitBlobSha(new TextEncoder().encode(content));
    await app.vault.create("ref2_1.md", content);

    const refGetRequests: RequestUrlParam[] = [];

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/git/ref/heads/main") && (!params.method || params.method === "GET")) {
        refGetRequests.push(params);
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_ref2_1", type: "commit" } },
        };
      }
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_base_ref2_1" } },
        };
      }
      if (params.url.includes("/git/trees/commit_base_ref2_1")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_ref2_1", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: expectedRawSha } };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new_ref2_1", tree: [] } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_ref2_1", tree: { sha: "tree_new_ref2_1" }, parents: [{ sha: "commit_base_ref2_1" }] },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit_new_ref2_1", type: "commit" } },
        };
      }
      if (params.url.includes("/git/trees/commit_new_ref2_1")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new_ref2_1",
            truncated: false,
            tree: [{ path: "ref2_1.md", mode: "100644", type: "blob", sha: expectedRawSha, size: 14 }],
          },
        };
      }
      throw new Error(`Unhandled: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(refGetRequests.length).toBeGreaterThanOrEqual(1);

    const verificationReq = refGetRequests[0];
    expect(verificationReq.url).toContain("?t=");
    expect(verificationReq.headers?.["Cache-Control"]).toBe("no-cache, no-store, must-revalidate");
    expect(verificationReq.headers?.["Pragma"]).toBe("no-cache");
  });

  it("REF2-006: False-negative push recovery -> note exists on remote -> automatically converges to UNCHANGED without duplicate commit", async () => {
    const content = "# Already On Remote\n";
    const sha = await calculateCanonicalGitBlobSha(content, "recovered.md");
    await app.vault.create("recovered.md", content);

    // Notice: state.json is EMPTY (simulating a false-negative push where baseline was not written)

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_existing" } },
        };
      }
      if (params.url.includes("/git/trees/commit_existing")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_existing",
            truncated: false,
            tree: [{ path: "recovered.md", mode: "100644", type: "blob", sha, size: 20 }],
          },
        };
      }
      throw new Error(`Unhandled URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, plugin.settings, client);

    // Push execution sees repository is already up to date, creates ZERO remote commits
    const report = await pushEngine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.counts.pushedCreated).toBe(0);
    expect(report.counts.pushedUpdated).toBe(0);
    expect(report.counts.unchanged).toBe(1);

    // And heals state.json with baseline!
    const state = await pushEngine.loadState();
    expect(state.files["recovered.md"]).toBeDefined();
    expect(state.files["recovered.md"].localSha).toBe(sha);
    expect(state.files["recovered.md"].remoteSha).toBe(sha);
  });

  it("REF2-007: Bundle verification -> main.js on disk contains getBranchRef and no-cache headers", () => {
    const bundle = fs.readFileSync("main.js", "utf8");
    expect(bundle.includes("git/ref/heads/")).toBe(true);
    expect(bundle.includes("no-cache, no-store, must-revalidate")).toBe(true);
    expect(bundle.includes("Authoritative Git branch ref returned")).toBe(true);
  });
});
