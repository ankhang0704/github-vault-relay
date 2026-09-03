import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, TFile } from "obsidian";
import { ConflictManager, ConflictRecord } from "../src/sync/conflictManager";
import { GitHubClient } from "../src/github/githubClient";
import { StorageManager } from "../src/sync/storageManager";

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

    const rec = await manager.recordConflict("Conflicted.md", "localsha123", "remotesha456", "commit1", "basesha");
    expect(rec.path).toBe("Conflicted.md");
    expect(rec.localSha).toBe("localsha123");
    expect(rec.remoteSha).toBe("remotesha456");

    const loaded = await manager.loadConflictRecords();
    expect(loaded.length).toBe(1);
    expect(loaded[0].path).toBe("Conflicted.md");
  });

  it("CONFLICT-004 & CONFLICT-005: resolveUseRemote overwrites local note when local SHA is unchanged; aborts if changed", async () => {
    const file = await app.vault.create("Note.md", "local unmodified text");
    const localBytes = await app.vault.readBinary(file);
    const { calculateCanonicalGitBlobSha } = await import("../src/sync/hashUtils");
    const localSha = await calculateCanonicalGitBlobSha(localBytes, "Note.md");

    const remoteContent = "remote authoritative text";
    const remoteSha = "remotesha_xyz";

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
    expect(abortRes.message).toContain("modified since conflict was reviewed");
  });

  it("CONFLICT-006 & CONFLICT-007: resolveKeepBoth preserves local note and creates remote conflict copy with suffix", async () => {
    const file = await app.vault.create("Essay.md", "local original text");
    const remoteContent = "remote divergent text";
    const remoteSha = "sha_remote_essay";

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
      id: "c_both",
      path: "Essay.md",
      localSha: "localsha",
      remoteSha,
      detectedAt: Date.now(),
    };

    const res = await manager.resolveKeepBoth(record);
    expect(res.success).toBe(true);
    expect(res.copyPath).toBeDefined();

    // Local file untouched
    expect(await app.vault.read(file)).toBe("local original text");

    // Copy file exists with remote content
    const copyFile = app.vault.getAbstractFileByPath(res.copyPath!);
    expect(copyFile).toBeInstanceOf(TFile);
    expect(await app.vault.read(copyFile as TFile)).toBe(remoteContent);
  });
});
