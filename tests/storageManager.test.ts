import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import { StorageManager } from "../src/sync/storageManager";
import { SyncStateData } from "../src/sync/syncTypes";

describe("StorageManager & Internal Storage (MIG-001..004)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("MIG-001: Loads empty state when internal storage does not exist", async () => {
    const state = await StorageManager.loadState(app);
    expect(state.version).toBe(1);
    expect(Object.keys(state.files).length).toBe(0);
    expect(state.lastSyncedCommitSha).toBeUndefined();
  });

  it("MIG-002: Saves and loads state from internal hidden storage", async () => {
    const sampleState: SyncStateData = {
      version: 1,
      lastSyncedCommitSha: "commit_internal_123",
      lastSyncedAt: 123456789,
      files: {
        "Note1.md": { localSha: "sha1", remoteSha: "sha1", syncedAt: 123456789 },
      },
    };

    await StorageManager.saveState(app, sampleState);

    const internalPath = StorageManager.getStateFilePath(app);
    expect(await app.vault.adapter.exists(internalPath)).toBe(true);

    const loaded = await StorageManager.loadState(app);
    expect(loaded.lastSyncedCommitSha).toBe("commit_internal_123");
    expect(loaded.files["Note1.md"].localSha).toBe("sha1");
  });

  it("MIG-003: saveConflictPayload writes binary and string payloads to internal conflicts directory", async () => {
    const stringPath = await StorageManager.saveConflictPayload(app, "folder/note.md", "# Conflict Text");
    expect(await app.vault.adapter.exists(stringPath)).toBe(true);
    expect(stringPath).toContain(StorageManager.getConflictsDirPath(app));

    const binaryBuf = new Uint8Array([1, 2, 3, 4]).buffer;
    const binaryPath = await StorageManager.saveConflictPayload(app, "image.png", binaryBuf);
    expect(await app.vault.adapter.exists(binaryPath)).toBe(true);
  });

  it("MIG-004: Internal storage lives in .obsidian/github-vault-relay (safe against BRAT and plugin updates)", () => {
    const dir = StorageManager.getPluginStorageDir(app);
    expect(dir).toBe(".obsidian/github-vault-relay");
    expect(dir.includes("plugins/github-vault-relay")).toBe(false);
  });
});
