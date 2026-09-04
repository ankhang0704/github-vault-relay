import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import { ConflictManager, ConflictRecord } from "../src/sync/conflictManager";
import { GitHubClient } from "../src/github/githubClient";
import { StorageManager } from "../src/sync/storageManager";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";

describe("Conflict Resolution Engine (CONFLICT-001..008)", () => {
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

  it("CONFLICT-001: recordConflict stores and persists conflict record", async () => {
    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main" });
    const manager = new ConflictManager(app, settings, client);

    const record = await manager.recordConflict("Conflicted.md", "local1", "remote1", "commit1", "base1");
    expect(record.path).toBe("Conflicted.md");
    expect(record.remoteCommitSha).toBe("commit1");

    const loaded = await manager.loadConflictRecords();
    expect(loaded.length).toBe(1);
    expect(loaded[0].path).toBe("Conflicted.md");
  });

  it("CONFLICT-002: resolveKeepLocal pushes local version when remote unchanged", async () => {
    const fileContent = "# Local Authority\n";
    await app.vault.create("Note.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    let pushAttempted = false;
    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_expected", commit: { tree: { sha: "tree_expected" } } } },
        };
      }
      if (params.url.includes("/git/trees/commit_new")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new", truncated: false, tree: [{ path: "Note.md", mode: "100644", type: "blob", sha: localSha, size: fileContent.length }] },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new" } };
      }
      if (params.url.includes("/git/trees/")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_expected", truncated: false, tree: [{ path: "Note.md", mode: "100644", type: "blob", sha: "some_old_remote", size: 20 }] } };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localSha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        pushAttempted = true;
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new" } } };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new" } } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_keep_local",
      path: "Note.md",
      localSha,
      remoteSha: "some_old_remote",
      remoteCommitSha: "commit_expected",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const result = await manager.resolveKeepLocal(record);
    expect(result.success).toBe(true);
    expect(pushAttempted).toBe(true);

    // Record is removed
    const remaining = await manager.loadConflictRecords();
    expect(remaining.length).toBe(0);
  });

  it("CONFLICT-003: resolveKeepLocal aborts when remote HEAD changed since review", async () => {
    await app.vault.create("Note.md", "# Local Text");

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_advanced_ahead" } },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_stale_remote",
      path: "Note.md",
      localSha: "sha1",
      remoteSha: "sha2",
      remoteCommitSha: "commit_expected_old",
      detectedAt: Date.now(),
    };

    const result = await manager.resolveKeepLocal(record);
    expect(result.success).toBe(false);
    expect(result.message).toContain("Remote branch changed concurrently");
  });

  it("CONFLICT-004 & CONFLICT-005: resolveUseRemote overwrites local note when local SHA is unchanged; aborts if changed", async () => {
    const file = await app.vault.create("Note.md", "local unmodified text");
    const localBytes = await app.vault.readBinary(file);
    const localSha = await calculateCanonicalGitBlobSha(localBytes, "Note.md");

    const remoteContent = "remote authoritative text";
    const remoteSha = await calculateRawGitBlobSha(new TextEncoder().encode(remoteContent));

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
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
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c1",
      path: "Note.md",
      localSha,
      remoteSha,
      detectedAt: Date.now(),
    };

    // Successful Use Remote
    const res = await manager.resolveUseRemote(record);
    expect(res.success).toBe(true);

    const updatedText = await app.vault.read(file);
    expect(updatedText).toBe(remoteContent);

    // State baseline updated
    const state = await StorageManager.loadState(app);
    expect(state.files["Note.md"].remoteSha).toBe(remoteSha);

    // If local was modified concurrently: abort
    await app.vault.modify(file, "modified concurrently!");
    const abortRecord: ConflictRecord = {
      id: "c2",
      path: "Note.md",
      localSha, // old localSha
      remoteSha,
      detectedAt: Date.now(),
    };

    const abortRes = await manager.resolveUseRemote(abortRecord);
    expect(abortRes.success).toBe(false);
    expect(abortRes.message).toContain("Aborted to prevent data loss");
  });

  it("CONFLICT-006 & CONFLICT-007: resolveKeepBoth preserves local note and creates remote conflict copy with suffix", async () => {
    const localOriginal = "my local draft";
    const file = await app.vault.create("Essay.md", localOriginal);

    const remoteContent = "someone else updated essay";
    const remoteSha = await calculateRawGitBlobSha(new TextEncoder().encode(remoteContent));

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
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
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_essay",
      path: "Essay.md",
      localSha: "local_sha",
      remoteSha,
      detectedAt: Date.now(),
    };

    const result = await manager.resolveKeepBoth(record);
    expect(result.success).toBe(true);
    expect(result.copyPath).toBeDefined();

    // Local file was untouched
    expect(await app.vault.read(file)).toBe(localOriginal);

    // Conflict copy was created with remote content
    const copyContent = await app.vault.adapter.read(result.copyPath!);
    expect(copyContent).toBe(remoteContent);
  });

  it("CONFLICT-008: Binary conflict resolution preserves byte fidelity for images/PDFs", async () => {
    const localBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const remoteBytes = new Uint8Array([137, 80, 78, 71, 99, 98, 97, 96]);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);

    const file = await app.vault.createBinary("photo.png", localBytes.buffer as ArrayBuffer);

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/git/blobs/" + remoteSha)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: remoteSha,
            size: remoteBytes.length,
            encoding: "base64",
            content: Buffer.from(remoteBytes).toString("base64"),
          },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c_binary",
      path: "photo.png",
      localSha: "local_png_sha",
      remoteSha,
      detectedAt: Date.now(),
    };

    // Test Keep Both with binary
    const keepBothRes = await manager.resolveKeepBoth(record);
    expect(keepBothRes.success).toBe(true);
    const createdBinary = await app.vault.adapter.readBinary(keepBothRes.copyPath!);
    expect(new Uint8Array(createdBinary)).toEqual(remoteBytes);
    expect(new Uint8Array(await app.vault.readBinary(file))).toEqual(localBytes);
  });
});
