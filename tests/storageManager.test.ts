import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import { StorageManager, LEGACY_STATE_FILE, LEGACY_ROOT_DIR } from "../src/sync/storageManager";
import { SyncStateData } from "../src/sync/syncTypes";

describe("StorageManager & Legacy Migration (MIG-001..008)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("MIG-001: Loads empty state when neither internal nor legacy exists", async () => {
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

  it("MIG-003 & MIG-004: Legacy migration moves _vault-relay/state.json to internal storage and cleans up legacy", async () => {
    // Setup legacy state file in vault
    const legacyState = JSON.stringify({
      version: 1,
      lastSyncedCommitSha: "commit_legacy_999",
      lastSyncedAt: 111222333,
      files: {
        "OldNote.md": { localSha: "oldsha", remoteSha: "oldsha", syncedAt: 111222333 },
      },
    });

    await app.vault.adapter.write(LEGACY_STATE_FILE, legacyState);
    expect(await app.vault.adapter.exists(LEGACY_STATE_FILE)).toBe(true);

    // Execute migration
    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    // Internal state now exists and has migrated data
    const internalPath = StorageManager.getStateFilePath(app);
    expect(await app.vault.adapter.exists(internalPath)).toBe(true);

    const loaded = await StorageManager.loadState(app);
    expect(loaded.lastSyncedCommitSha).toBe("commit_legacy_999");
    expect(loaded.files["OldNote.md"].localSha).toBe("oldsha");

    // Legacy file removed
    expect(await app.vault.adapter.exists(LEGACY_STATE_FILE)).toBe(false);
  });

  it("MIG-005: Migration is idempotent (subsequent runs do not fail or corrupt)", async () => {
    const res1 = await StorageManager.migrateLegacyStorage(app);
    expect(res1.migrated).toBe(false);

    const sampleState: SyncStateData = {
      version: 1,
      lastSyncedCommitSha: "commit_already_migrated",
      lastSyncedAt: 200,
      files: {},
    };
    await StorageManager.saveState(app, sampleState);

    const res2 = await StorageManager.migrateLegacyStorage(app);
    expect(res2.migrated).toBe(false);

    const loaded = await StorageManager.loadState(app);
    expect(loaded.lastSyncedCommitSha).toBe("commit_already_migrated");
  });

  it("MIG-006: Migration preserves legacy conflict files into internal conflicts directory", async () => {
    await app.vault.adapter.write(LEGACY_STATE_FILE, JSON.stringify({ version: 1, files: {} }));
    await app.vault.adapter.write(`${LEGACY_ROOT_DIR}/conflicts/conflict1.md`, "conflict content");

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    const internalConflicts = StorageManager.getConflictsDirPath(app);
    expect(await app.vault.adapter.exists(`${internalConflicts}/conflict1.md`)).toBe(true);
  });

  it("MIG-007: Broken legacy state does not destroy legacy file", async () => {
    await app.vault.adapter.write(LEGACY_STATE_FILE, "{ corrupt json");

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(false);
    expect(result.error).toBeDefined();

    // Legacy file is kept intact
    expect(await app.vault.adapter.exists(LEGACY_STATE_FILE)).toBe(true);
  });

  it("MIG-008: saveConflictPayload writes binary and string payloads to internal conflicts directory", async () => {
    const stringPath = await StorageManager.saveConflictPayload(app, "folder/note.md", "# Conflict Text");
    expect(await app.vault.adapter.exists(stringPath)).toBe(true);
    expect(stringPath).toContain(StorageManager.getConflictsDirPath(app));

    const binaryBuf = new Uint8Array([1, 2, 3, 4]).buffer;
    const binaryPath = await StorageManager.saveConflictPayload(app, "image.png", binaryBuf);
    expect(await app.vault.adapter.exists(binaryPath)).toBe(true);
  });
});
