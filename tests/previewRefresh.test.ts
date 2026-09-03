import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, PluginManifest } from "obsidian";
import VaultRelayPlugin from "../src/main";
import { GitHubClient } from "../src/github/githubClient";
import { SyncEngine } from "../src/sync/syncEngine";
import { PullEngine } from "../src/sync/pullEngine";
import { setStoredPat } from "../src/security/secretStore";
import { calculateCanonicalGitBlobSha } from "../src/sync/hashUtils";

describe("Sync Preview Refresh & UX Flow (tests/previewRefresh.test.ts)", () => {
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
      version: "0.3.0",
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

  it("UX-001: Preview initially reports REMOTE_ONLY -> Safe Pull succeeds -> Fresh preview reports UNCHANGED", async () => {
    const remoteContent = "# Remote Note\nContent from GitHub\n";
    const remoteSha = await calculateCanonicalGitBlobSha(remoteContent, "remote-only.md");

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_sha_123" } },
        };
      }
      if (params.url.includes("/git/trees/commit_sha_123")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_sha_123",
            truncated: false,
            tree: [{ path: "remote-only.md", mode: "100644", type: "blob", sha: remoteSha, size: 30 }],
          },
        };
      }
      if (params.url.includes(`/git/blobs/${remoteSha}`)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: remoteSha,
            size: 30,
            encoding: "base64",
            content: Buffer.from(remoteContent).toString("base64"),
          },
        };
      }
      throw new Error(`Unhandled request URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const syncEngine = new SyncEngine(app, plugin.settings, client);

    // Initial Preview: REMOTE_ONLY
    const initialReport = await syncEngine.generatePreview();
    expect(initialReport.counts.REMOTE_ONLY).toBe(1);
    expect(initialReport.counts.UNCHANGED).toBe(0);
    expect(initialReport.items[0].category).toBe("REMOTE_ONLY");

    // Execute Safe Pull
    const pullEngine = new PullEngine(app, plugin.settings, client);
    const pullReport = await pullEngine.executeSafePull();
    expect(pullReport.status).toBe("PASS");
    expect(pullReport.counts.pulledCreated).toBe(1);

    // Fresh Preview without recreating modal/engine: reflects UNCHANGED
    const refreshedReport = await syncEngine.generatePreview();
    expect(refreshedReport.counts.REMOTE_ONLY).toBe(0);
    expect(refreshedReport.counts.UNCHANGED).toBe(1);
    expect(refreshedReport.items[0].category).toBe("UNCHANGED");
  });

  it("UX-002: Preview initially reports REMOTE_CHANGED -> Safe Pull succeeds -> Fresh preview reports UNCHANGED", async () => {
    const v1Content = "# Note Title\nVersion 1 Content\n";
    const v2Content = "# Note Title\nVersion 2 Updated Content\n";
    const v1Sha = await calculateCanonicalGitBlobSha(v1Content, "doc.md");
    const v2Sha = await calculateCanonicalGitBlobSha(v2Content, "doc.md");

    // Create baseline with v1
    await app.vault.create("doc.md", v1Content);
    const initialBaseline = {
      version: 1,
      lastSyncedCommitSha: "commit_v1",
      files: {
        "doc.md": { localSha: v1Sha, remoteSha: v1Sha, syncedAt: "2026-09-01T12:00:00.000Z" },
      },
    };
    await app.vault.adapter.write("_vault-relay/state.json", JSON.stringify(initialBaseline));

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_v2" } },
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
            tree: [{ path: "doc.md", mode: "100644", type: "blob", sha: v2Sha, size: 40 }],
          },
        };
      }
      if (params.url.includes(`/git/blobs/${v2Sha}`)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: v2Sha,
            size: 40,
            encoding: "base64",
            content: Buffer.from(v2Content).toString("base64"),
          },
        };
      }
      throw new Error(`Unhandled request URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const syncEngine = new SyncEngine(app, plugin.settings, client);

    // Initial Preview: REMOTE_CHANGED
    const initialReport = await syncEngine.generatePreview();
    expect(initialReport.counts.REMOTE_CHANGED).toBe(1);
    expect(initialReport.items[0].category).toBe("REMOTE_CHANGED");

    // Execute Safe Pull
    const pullEngine = new PullEngine(app, plugin.settings, client);
    const pullReport = await pullEngine.executeSafePull();
    expect(pullReport.status).toBe("PASS");
    expect(pullReport.counts.pulledUpdated).toBe(1);

    // Refreshed Preview: UNCHANGED
    const refreshedReport = await syncEngine.generatePreview();
    expect(refreshedReport.counts.REMOTE_CHANGED).toBe(0);
    expect(refreshedReport.counts.UNCHANGED).toBe(1);
    expect(refreshedReport.items[0].category).toBe("UNCHANGED");
  });

  it("UX-003: Conflict is preserved -> Fresh preview continues reporting conflict if local note remains divergent", async () => {
    const localContent = "# Note\nLocal Unique Edit\n";
    const remoteContent = "# Note\nRemote Unique Edit\n";
    const baseContent = "# Note\nBase Content\n";
    const baseSha = await calculateCanonicalGitBlobSha(baseContent, "conflict.md");
    const remoteSha = await calculateCanonicalGitBlobSha(remoteContent, "conflict.md");

    await app.vault.create("conflict.md", localContent);
    const baseline = {
      version: 1,
      lastSyncedCommitSha: "commit_base",
      files: {
        "conflict.md": { localSha: baseSha, remoteSha: baseSha, syncedAt: "2026-09-01T12:00:00.000Z" },
      },
    };
    await app.vault.adapter.write("_vault-relay/state.json", JSON.stringify(baseline));

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
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
            tree: [{ path: "conflict.md", mode: "100644", type: "blob", sha: remoteSha, size: 30 }],
          },
        };
      }
      if (params.url.includes(`/git/blobs/${remoteSha}`)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: remoteSha,
            size: 30,
            encoding: "base64",
            content: Buffer.from(remoteContent).toString("base64"),
          },
        };
      }
      throw new Error(`Unhandled request URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const syncEngine = new SyncEngine(app, plugin.settings, client);

    // Initial Preview: POTENTIAL_CONFLICT
    const initialReport = await syncEngine.generatePreview();
    expect(initialReport.counts.POTENTIAL_CONFLICT).toBe(1);

    // Pull preserves conflict to _vault-relay/conflicts/
    const pullEngine = new PullEngine(app, plugin.settings, client);
    const pullReport = await pullEngine.executeSafePull();
    expect(pullReport.status).toBe("PASS_WITH_WARNINGS");
    expect(pullReport.counts.conflictsPreserved).toBe(1);

    // Local file was kept untouched, so refreshed preview accurately shows conflict
    const refreshedReport = await syncEngine.generatePreview();
    expect(refreshedReport.counts.POTENTIAL_CONFLICT).toBe(1);
    expect(refreshedReport.items.find((i) => i.path === "conflict.md")?.category).toBe("POTENTIAL_CONFLICT");
  });

  it("UX-004: PASS_WITH_WARNINGS (e.g. skipped oversized file) refreshes actual state while preserving warning result", async () => {
    const normalContent = "# Normal Note\n";
    const normalSha = await calculateCanonicalGitBlobSha(normalContent, "normal.md");

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_large" } },
        };
      }
      if (params.url.includes("/git/trees/commit_large")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_large",
            truncated: false,
            tree: [
              { path: "normal.md", mode: "100644", type: "blob", sha: normalSha, size: 20 },
              { path: "huge.mp4", mode: "100644", type: "blob", sha: "huge_sha", size: 30 * 1024 * 1024 },
            ],
          },
        };
      }
      if (params.url.includes(`/git/blobs/${normalSha}`)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: normalSha,
            size: 20,
            encoding: "base64",
            content: Buffer.from(normalContent).toString("base64"),
          },
        };
      }
      throw new Error(`Unhandled request URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const syncEngine = new SyncEngine(app, plugin.settings, client);

    const pullEngine = new PullEngine(app, plugin.settings, client);
    const pullReport = await pullEngine.executeSafePull();
    expect(pullReport.status).toBe("PASS_WITH_WARNINGS");
    expect(pullReport.counts.pulledCreated).toBe(1);
    expect(pullReport.counts.skippedOversized).toBe(1);

    const refreshedReport = await syncEngine.generatePreview();
    expect(refreshedReport.counts.UNCHANGED).toBe(1); // normal.md is now UNCHANGED
    expect(refreshedReport.counts.REMOTE_ONLY).toBe(1); // huge.mp4 is still remote only
    expect(refreshedReport.items.find((i) => i.path === "huge.mp4")?.isOversized).toBe(true);
  });

  it("UX-005: ABORTED (truncated tree) does not modify files and preview retains exact categories", async () => {
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_trunc" } },
        };
      }
      if (params.url.includes("/git/trees/commit_trunc")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_trunc",
            truncated: true,
            tree: [{ path: "note.md", mode: "100644", type: "blob", sha: "sha1", size: 10 }],
          },
        };
      }
      throw new Error(`Unhandled request URL: ${params.url}`);
    });

    const client = new GitHubClient({ token, owner, repo, branch, requestFn: fakeRequestFn });
    const syncEngine = new SyncEngine(app, plugin.settings, client);

    const pullEngine = new PullEngine(app, plugin.settings, client);
    const pullReport = await pullEngine.executeSafePull();
    expect(pullReport.status).toBe("ABORTED");

    const preview = await syncEngine.generatePreview();
    expect(preview.truncatedRemoteTree).toBe(true);
    expect(await app.vault.adapter.exists("note.md")).toBe(false);
  });
});
