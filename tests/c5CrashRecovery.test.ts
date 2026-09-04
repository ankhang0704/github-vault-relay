import { beforeEach, describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import { ConflictManager, ConflictRecord } from "../src/sync/conflictManager";
import { GitHubClient } from "../src/github/githubClient";
import { DEFAULT_SETTINGS, VaultRelaySettings } from "../src/settings";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { StorageManager } from "../src/sync/storageManager";

function makeSettings(): VaultRelaySettings {
  return { ...DEFAULT_SETTINGS, owner: "owner", repo: "repo", branch: "main" };
}

function makeConflictClient(path: string, bytes: Uint8Array, remoteSha: string): GitHubClient {
  return new GitHubClient({
    token: "github_pat_test_crash",
    owner: "owner",
    repo: "repo",
    branch: "main",
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
          json: {
            sha: "tree_reviewed",
            truncated: false,
            tree: [{ path, mode: "100644", type: "blob", sha: remoteSha, size: bytes.byteLength }],
          },
        };
      }
      if (params.url.includes(`/git/blobs/${remoteSha}`)) {
        return {
          status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: remoteSha,
            size: bytes.byteLength,
            encoding: "base64",
            content: Buffer.from(bytes).toString("base64"),
          },
        };
      }
      throw new Error(`Unhandled URL: ${params.url}`);
    },
  });
}

describe("C5-CRASH: interruption and crash recovery", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("C5-CRASH-001: interrupted atomic state replacement restores the last valid backup", async () => {
    const oldState = {
      version: 1,
      lastSyncedCommitSha: "old_commit",
      files: { "old.md": { localSha: "old", remoteSha: "old", syncedAt: 1 } },
    };
    await StorageManager.saveState(app, oldState);
    const path = StorageManager.getStateFilePath(app);
    const stagedState = JSON.stringify({
      version: 1,
      lastSyncedCommitSha: "staged_commit",
      files: { "new.md": { localSha: "new", remoteSha: "new", syncedAt: 2 } },
    });

    await app.vault.adapter.rename(path, `${path}.bak`);
    await app.vault.adapter.write(`${path}.tmp`, stagedState);
    await StorageManager.recoverAtomicStorage(app);

    expect((await StorageManager.loadState(app)).lastSyncedCommitSha).toBe("old_commit");
    expect(await app.vault.adapter.exists(`${path}.tmp`)).toBe(false);
    expect(await app.vault.adapter.exists(`${path}.bak`)).toBe(false);
  });

  it("C5-CRASH-002: a valid installed state wins over stale atomic artifacts", async () => {
    const path = StorageManager.getStateFilePath(app);
    await StorageManager.saveState(app, {
      version: 1,
      lastSyncedCommitSha: "new_commit",
      files: {},
    });
    await app.vault.adapter.write(`${path}.bak`, JSON.stringify({
      version: 1,
      lastSyncedCommitSha: "old_commit",
      files: {},
    }));
    await app.vault.adapter.write(`${path}.tmp`, "{malformed");

    await StorageManager.recoverAtomicStorage(app);

    expect((await StorageManager.loadState(app)).lastSyncedCommitSha).toBe("new_commit");
    expect(await app.vault.adapter.exists(`${path}.tmp`)).toBe(false);
    expect(await app.vault.adapter.exists(`${path}.bak`)).toBe(false);
  });

  it("C5-CRASH-003: restart completes a verified Pull whose state save was interrupted", async () => {
    const path = "Notes/recovered.md";
    const oldBytes = new TextEncoder().encode("old local\n");
    const newBytes = new TextEncoder().encode("new remote\n");
    const expectedLocalSha = await calculateCanonicalGitBlobSha(newBytes, path);
    const remoteSha = await calculateRawGitBlobSha(newBytes);
    const file = await app.vault.createBinary(path, oldBytes.buffer as ArrayBuffer);
    const journal = await StorageManager.beginPullWriteRecovery(
      app,
      path,
      expectedLocalSha,
      remoteSha,
      oldBytes.buffer as ArrayBuffer
    );
    await app.vault.modifyBinary(file, newBytes.buffer as ArrayBuffer);

    const result = await StorageManager.recoverInterruptedPullWrites(app);

    expect(result).toMatchObject({ scanned: 1, completed: 1, rolledBack: 0 });
    expect((await StorageManager.loadState(app)).files[path]).toMatchObject({
      localSha: expectedLocalSha,
      remoteSha,
    });
    expect(await app.vault.adapter.exists(journal)).toBe(false);
  });

  it("C5-CRASH-004: restart rolls back an interrupted corrupt overwrite byte-for-byte", async () => {
    const path = "Notes/rollback.bin";
    const oldBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const expectedBytes = new Uint8Array([9, 8, 7, 6, 5]);
    const expectedLocalSha = await calculateCanonicalGitBlobSha(expectedBytes, path);
    const remoteSha = await calculateRawGitBlobSha(expectedBytes);
    const file = await app.vault.createBinary(path, oldBytes.buffer as ArrayBuffer);
    const journal = await StorageManager.beginPullWriteRecovery(
      app,
      path,
      expectedLocalSha,
      remoteSha,
      oldBytes.buffer as ArrayBuffer
    );
    await app.vault.modifyBinary(file, new Uint8Array([99, 98]).buffer as ArrayBuffer);

    const result = await StorageManager.recoverInterruptedPullWrites(app);

    expect(result).toMatchObject({ scanned: 1, completed: 0, rolledBack: 1 });
    const restored = app.vault.getAbstractFileByPath(path) as TFile;
    expect(new Uint8Array(await app.vault.readBinary(restored))).toEqual(oldBytes);
    expect((await StorageManager.loadState(app)).files[path]).toBeUndefined();
    expect(await app.vault.adapter.exists(journal)).toBe(false);
  });

  it("C5-CRASH-005: malformed recovery evidence is preserved without a startup loop", async () => {
    const recoveryDir = StorageManager.getPullRecoveryDirPath(app);
    const journal = `${recoveryDir}/bad.json`;
    await app.vault.adapter.write(journal, JSON.stringify({ version: 1, path: "../escape.md" }));

    const first = await StorageManager.recoverInterruptedPullWrites(app);
    const second = await StorageManager.recoverInterruptedPullWrites(app);

    expect(first.preserved).toBe(1);
    expect(second.preserved).toBe(1);
    expect(await app.vault.adapter.exists(journal)).toBe(true);
  });

  it("C5-CRASH-006: Use Remote rolls back local bytes when state cannot become durable", async () => {
    const path = "Notes/use-remote.md";
    const localBytes = new TextEncoder().encode("local reviewed\n");
    const remoteBytes = new TextEncoder().encode("remote reviewed\n");
    const localSha = await calculateCanonicalGitBlobSha(localBytes, path);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);
    await app.vault.createBinary(path, localBytes.buffer as ArrayBuffer);
    const manager = new ConflictManager(app, makeSettings(), makeConflictClient(path, remoteBytes, remoteSha));
    const record: ConflictRecord = {
      id: "use_remote_state_failure",
      path,
      localSha,
      remoteSha,
      remoteCommitSha: "commit_reviewed",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const originalWrite = app.vault.adapter.write;
    app.vault.adapter.write = async (target, data) => {
      if (target === `${StorageManager.getStateFilePath(app)}.tmp`) {
        throw new Error("simulated state write interruption");
      }
      await originalWrite(target, data);
    };
    await expect(manager.resolveUseRemote(record)).rejects.toThrow("state write interruption");
    app.vault.adapter.write = originalWrite;

    const localFile = app.vault.getAbstractFileByPath(path) as TFile;
    expect(new Uint8Array(await app.vault.readBinary(localFile))).toEqual(localBytes);
    expect(await manager.loadConflictRecords()).toHaveLength(1);
    expect((await app.vault.adapter.list(StorageManager.getPullRecoveryDirPath(app))).files).toHaveLength(0);
  });

  it("C5-CRASH-007: Keep Both retry reuses a verified copy after metadata interruption", async () => {
    const path = "Notes/keep-both.md";
    const localBytes = new TextEncoder().encode("local reviewed\n");
    const remoteBytes = new TextEncoder().encode("remote reviewed\n");
    const localSha = await calculateCanonicalGitBlobSha(localBytes, path);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);
    await app.vault.createBinary(path, localBytes.buffer as ArrayBuffer);
    const manager = new ConflictManager(app, makeSettings(), makeConflictClient(path, remoteBytes, remoteSha));
    const record: ConflictRecord = {
      id: "keep_both_state_failure",
      path,
      localSha,
      remoteSha,
      remoteCommitSha: "commit_reviewed",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const originalWrite = app.vault.adapter.write;
    app.vault.adapter.write = async (target, data) => {
      if (target === `${StorageManager.getStateFilePath(app)}.tmp`) {
        throw new Error("simulated state write interruption");
      }
      await originalWrite(target, data);
    };
    await expect(manager.resolveKeepBoth(record)).rejects.toThrow("state write interruption");
    app.vault.adapter.write = originalWrite;

    const retry = await manager.resolveKeepBoth(record);
    expect(retry.success).toBe(true);
    expect(app.vault.getFiles().filter((file) => file.path.includes("remote conflict"))).toHaveLength(1);
    expect((await StorageManager.loadState(app)).files[path]).toMatchObject({ localSha, remoteSha });
  });
});
