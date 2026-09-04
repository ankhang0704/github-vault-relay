/**
 * C5-UPGRADE: Upgrade / Migration Matrix Tests
 *
 * Verifies realistic upgrade paths:
 * A. Clean install → current C5
 * B. 0.3.0 → current (legacy root _vault-relay)
 * C. 0.4.0 → current (intermediate .obsidian/vault-relay/)
 * D. old C2/C3: VaultRoot/_vault-relay/ → .obsidian/github-vault-relay/
 * E. intermediate C4: .obsidian/vault-relay/ → .obsidian/github-vault-relay/
 * F. old PAT keys → github-vault-relay-pat
 * G. old excludedPaths containing _vault-relay/ → settingsVersion migration
 * H. existing conflicts → canonical conflict metadata/payload storage
 */

import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import { StorageManager, LEGACY_STATE_FILE, LEGACY_CONFLICTS_DIR } from "../src/sync/storageManager";
import { serializeState } from "../src/sync/syncState";
import { migrateLegacyExclusions } from "../src/sync/pathFilter";
import { CANONICAL_SECRET_KEY, getStoredPat } from "../src/security/secretStore";
import { SyncStateData } from "../src/sync/syncTypes";

describe("C5-UPGRADE: Migration Matrix (C5-UPGRADE-001..015)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
    // Clear mock localStorage
    if (typeof globalThis.localStorage !== "undefined") {
      globalThis.localStorage.clear();
    }
  });

  // Helper to write state to a path
  async function writeState(path: string, state: SyncStateData): Promise<void> {
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      await app.vault.adapter.mkdir(dir);
    }
    await app.vault.adapter.write(path, serializeState(state));
  }

  // Helper to create a sample valid state
  function makeSampleState(commitSha = "abc123"): SyncStateData {
    return {
      version: 1,
      lastSyncedCommitSha: commitSha,
      lastSyncedAt: Date.now(),
      files: {
        "notes/hello.md": { localSha: "sha_local_1", remoteSha: "sha_remote_1", syncedAt: Date.now() },
        "notes/world.md": { localSha: "sha_local_2", remoteSha: "sha_remote_2", syncedAt: Date.now() },
      },
    };
  }

  it("C5-UPGRADE-001: Clean install → fresh empty state with no errors", async () => {
    const state = await StorageManager.loadState(app);
    expect(state.version).toBe(1);
    expect(state.files).toEqual({});
    expect(state.lastSyncedCommitSha).toBeUndefined();

    // Migration should be a no-op
    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.error).toBeUndefined();
  });

  it("C5-UPGRADE-002: Legacy C2/C3 state (_vault-relay/state.json) migrates to canonical path", async () => {
    const sampleState = makeSampleState("commit_legacy");
    await writeState(LEGACY_STATE_FILE, sampleState);

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);
    expect(result.error).toBeUndefined();

    // Canonical state should exist now
    const canonicalPath = StorageManager.getStateFilePath(app);
    const exists = await app.vault.adapter.exists(canonicalPath);
    expect(exists).toBe(true);

    // State content should be preserved
    const loaded = await StorageManager.loadState(app);
    expect(loaded.lastSyncedCommitSha).toBe("commit_legacy");
    expect(Object.keys(loaded.files)).toHaveLength(2);

    // Legacy file should be removed
    const legacyExists = await app.vault.adapter.exists(LEGACY_STATE_FILE);
    expect(legacyExists).toBe(false);
  });

  it("C5-UPGRADE-003: Intermediate C4 (.obsidian/vault-relay/) migrates to canonical path", async () => {
    const sampleState = makeSampleState("commit_inter_c4");
    const interDir = StorageManager.getIntermediateC4Dir(app);
    await writeState(`${interDir}/state.json`, sampleState);

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);
    expect(result.error).toBeUndefined();

    const loaded = await StorageManager.loadState(app);
    expect(loaded.lastSyncedCommitSha).toBe("commit_inter_c4");
    expect(Object.keys(loaded.files)).toHaveLength(2);
  });

  it("C5-UPGRADE-004: Migration idempotent — running twice does not corrupt state", async () => {
    const sampleState = makeSampleState("commit_idempotent");
    await writeState(LEGACY_STATE_FILE, sampleState);

    await StorageManager.migrateLegacyStorage(app);
    const firstLoad = await StorageManager.loadState(app);

    // Run migration again — should be no-op
    await StorageManager.migrateLegacyStorage(app);
    const secondLoad = await StorageManager.loadState(app);

    expect(secondLoad.lastSyncedCommitSha).toBe(firstLoad.lastSyncedCommitSha);
    expect(Object.keys(secondLoad.files)).toHaveLength(Object.keys(firstLoad.files).length);
  });

  it("C5-UPGRADE-005: Legacy conflict files migrate with byte-exact verification", async () => {
    const conflictContent = new TextEncoder().encode("conflict content here");
    const conflictPath = `${LEGACY_CONFLICTS_DIR}/1234567890/notes/hello.md`;
    await app.vault.adapter.mkdir(LEGACY_CONFLICTS_DIR);
    await app.vault.adapter.mkdir(`${LEGACY_CONFLICTS_DIR}/1234567890`);
    await app.vault.adapter.mkdir(`${LEGACY_CONFLICTS_DIR}/1234567890/notes`);
    await app.vault.adapter.writeBinary(conflictPath, conflictContent.buffer as ArrayBuffer);

    // Write a valid state too
    const sampleState = makeSampleState("commit_conflict_mig");
    await writeState(LEGACY_STATE_FILE, sampleState);

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    // Canonical conflicts dir should have content
    const canonicalConflictsDir = StorageManager.getConflictsDirPath(app);
    const list = await app.vault.adapter.list(canonicalConflictsDir);
    expect(list.files.length).toBeGreaterThanOrEqual(1);
    const migratedBytes = await app.vault.adapter.readBinary(list.files[0]);
    expect(new Uint8Array(migratedBytes)).toEqual(conflictContent);
    const metadata = JSON.parse(await app.vault.adapter.read(StorageManager.getConflictsMetaFilePath(app)));
    expect(metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "notes/hello.md", snapshotPath: list.files[0] }),
      ])
    );
  });

  it("C5-UPGRADE-006: Root _vault-relay user content preserved during migration", async () => {
    // Create user content in _vault-relay/
    const userContent = new TextEncoder().encode("my user notes in _vault-relay");
    await app.vault.adapter.mkdir("_vault-relay");
    await app.vault.adapter.writeBinary("_vault-relay/my-notes.md", userContent.buffer as ArrayBuffer);

    // Also create legacy state
    const sampleState = makeSampleState("commit_user_content");
    await writeState(LEGACY_STATE_FILE, sampleState);

    await StorageManager.migrateLegacyStorage(app);

    // User content should still exist
    const userExists = await app.vault.adapter.exists("_vault-relay/my-notes.md");
    expect(userExists).toBe(true);

    // _vault-relay dir should still exist because user content remains
    const dirExists = await app.vault.adapter.exists("_vault-relay");
    expect(dirExists).toBe(true);
  });

  it("C5-UPGRADE-007: PAT key migration from vault-relay-pat to canonical key", async () => {
    // Simulate legacy PAT in SecretStorage under old key
    await app.secretStorage.setSecret("vault-relay-pat", "github_pat_LEGACY_TOKEN_12345678901234567890");

    const token = await getStoredPat(app, "owner", "repo");
    expect(token).toBe("github_pat_LEGACY_TOKEN_12345678901234567890");

    // Canonical key should now have the token
    const canonical = await app.secretStorage.getSecret(CANONICAL_SECRET_KEY);
    expect(canonical).toBe("github_pat_LEGACY_TOKEN_12345678901234567890");

    // Legacy key should be cleaned up
    const legacyRemaining = await app.secretStorage.getSecret("vault-relay-pat");
    expect(legacyRemaining).toBeNull();
  });

  it("C5-UPGRADE-008: Legacy localStorage PAT migrates to SecretStorage once", async () => {
    globalThis.localStorage.setItem("vault-relay:pat", "github_pat_LOCALSTORAGE_TOKEN_1234567890");

    const token = await getStoredPat(app, "owner", "repo");
    expect(token).toBe("github_pat_LOCALSTORAGE_TOKEN_1234567890");

    // localStorage should be purged
    expect(globalThis.localStorage.getItem("vault-relay:pat")).toBeNull();

    // Should be in SecretStorage now
    const stored = await app.secretStorage.getSecret(CANONICAL_SECRET_KEY);
    expect(stored).toBe("github_pat_LOCALSTORAGE_TOKEN_1234567890");
  });

  it("C5-UPGRADE-009: Legacy exclusion _vault-relay/ removed via settingsVersion migration", () => {
    const oldExclusions = [".obsidian/", ".git/", "_fit/", "_vault-relay/"];
    const migrated = migrateLegacyExclusions(oldExclusions);
    expect(migrated).not.toContain("_vault-relay/");
    expect(migrated).not.toContain("_vault-relay");
    expect(migrated).toContain(".obsidian/");
    expect(migrated).toContain(".git/");
    expect(migrated).toContain("_fit/");
  });

  it("C5-UPGRADE-010: User custom exclusions preserved during legacy exclusion migration", () => {
    const customExclusions = [".obsidian/", ".git/", "_fit/", "_vault-relay/", "private/", "drafts/archive/"];
    const migrated = migrateLegacyExclusions(customExclusions);
    expect(migrated).toContain("private/");
    expect(migrated).toContain("drafts/archive/");
    expect(migrated).not.toContain("_vault-relay/");
  });

  it("C5-UPGRADE-011: Broken legacy state.json does not destroy legacy file or corrupt state", async () => {
    const brokenContent = "{ broken json }}";
    await app.vault.adapter.mkdir("_vault-relay");
    await app.vault.adapter.write(LEGACY_STATE_FILE, brokenContent);

    const result = await StorageManager.migrateLegacyStorage(app);
    // Should fail gracefully
    expect(result.error).toBeDefined();

    // Legacy file should still exist (not deleted on failure)
    const legacyExists = await app.vault.adapter.exists(LEGACY_STATE_FILE);
    expect(legacyExists).toBe(true);

    // Canonical state should be empty (not corrupted)
    const state = await StorageManager.loadState(app);
    expect(state.files).toEqual({});
  });

  it("C5-UPGRADE-012: Intermediate plugin-dir state migrates and cleans up", async () => {
    const sampleState = makeSampleState("commit_plugin_dir");
    const pluginStatePath = StorageManager.getIntermediatePluginStateFilePath(app);
    const dir = pluginStatePath.substring(0, pluginStatePath.lastIndexOf("/"));
    await app.vault.adapter.mkdir(dir);
    await app.vault.adapter.write(pluginStatePath, serializeState(sampleState));

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    const loaded = await StorageManager.loadState(app);
    expect(loaded.lastSyncedCommitSha).toBe("commit_plugin_dir");

    // Plugin-dir state should be cleaned up
    const pluginStateExists = await app.vault.adapter.exists(pluginStatePath);
    expect(pluginStateExists).toBe(false);
  });

  it("C5-UPGRADE-013: malformed intermediate conflict metadata preserves source evidence", async () => {
    const intermediateDir = StorageManager.getIntermediateC4Dir(app);
    const payloadPath = `${intermediateDir}/conflicts/conflict.bin`;
    const metadataPath = `${intermediateDir}/conflicts_meta.json`;
    const payload = new Uint8Array([1, 2, 3, 4]);
    await app.vault.adapter.writeBinary(payloadPath, payload.buffer as ArrayBuffer);
    await app.vault.adapter.write(metadataPath, "{broken metadata");

    const result = await StorageManager.migrateLegacyStorage(app);

    expect(result.migrated).toBe(false);
    expect(result.error).toBeDefined();
    expect(new Uint8Array(await app.vault.adapter.readBinary(payloadPath))).toEqual(payload);
    expect(await app.vault.adapter.read(metadataPath)).toBe("{broken metadata");
    expect(await app.vault.adapter.exists(intermediateDir)).toBe(true);
  });

  it("C5-UPGRADE-014: same-name migration collisions preserve both payloads byte-exact", async () => {
    const intermediateDir = StorageManager.getIntermediateC4Dir(app);
    const firstPath = `${intermediateDir}/conflicts/one/conflict.bin`;
    const secondPath = `${intermediateDir}/conflicts/two/conflict.bin`;
    const firstBytes = new Uint8Array([10, 20, 30]);
    const secondBytes = new Uint8Array([40, 50, 60]);
    await app.vault.adapter.writeBinary(firstPath, firstBytes.buffer as ArrayBuffer);
    await app.vault.adapter.writeBinary(secondPath, secondBytes.buffer as ArrayBuffer);
    await app.vault.adapter.write(`${intermediateDir}/conflicts_meta.json`, JSON.stringify([
      { id: "one", path: "one.bin", localSha: "l1", remoteSha: "r1", detectedAt: 1, snapshotPath: firstPath },
      { id: "two", path: "two.bin", localSha: "l2", remoteSha: "r2", detectedAt: 2, snapshotPath: secondPath },
    ]));

    const result = await StorageManager.migrateLegacyStorage(app);
    const metadata = JSON.parse(
      await app.vault.adapter.read(StorageManager.getConflictsMetaFilePath(app))
    ) as Array<{ snapshotPath: string }>;
    const migrated = await Promise.all(
      metadata.map(async (record) => new Uint8Array(await app.vault.adapter.readBinary(record.snapshotPath)))
    );

    expect(result.error).toBeUndefined();
    expect(metadata).toHaveLength(2);
    expect(new Set(metadata.map((record) => record.snapshotPath)).size).toBe(2);
    expect(migrated).toEqual(expect.arrayContaining([firstBytes, secondBytes]));
    expect(await app.vault.adapter.exists(intermediateDir)).toBe(false);
  });

  it("C5-UPGRADE-015: valid JSON with invalid state schema is never migrated or deleted", async () => {
    const intermediateDir = StorageManager.getIntermediateC4Dir(app);
    const statePath = `${intermediateDir}/state.json`;
    await app.vault.adapter.write(statePath, JSON.stringify({ version: 1, files: null }));

    const result = await StorageManager.migrateLegacyStorage(app);

    expect(result.migrated).toBe(false);
    expect(result.error).toContain("schema is invalid");
    expect(await app.vault.adapter.exists(statePath)).toBe(true);
    expect((await StorageManager.loadState(app)).files).toEqual({});
  });
});
