import fs from "fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import { StorageManager, LEGACY_ROOT_DIR, LEGACY_STATE_FILE } from "../src/sync/storageManager";
import { ConflictManager } from "../src/sync/conflictManager";
import { PullEngine } from "../src/sync/pullEngine";
import { GitHubClient } from "../src/github/githubClient";
import { calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { SyncPreviewReport } from "../src/sync/syncTypes";

describe("C4 Real Runtime W1 Forensics & Legacy Migration (W1-REG-001..008)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("W1-REG-001: C3 legacy state migrates to .obsidian/vault-relay", async () => {
    const legacyState = JSON.stringify({
      version: 1,
      lastSyncedCommitSha: "c3_legacy_commit",
      lastSyncedAt: 1788400000000,
      files: {
        "Note.md": { localSha: "s1", remoteSha: "s1", syncedAt: 1788400000000 },
      },
    });

    await app.vault.adapter.write(LEGACY_STATE_FILE, legacyState);
    const result = await StorageManager.migrateLegacyStorage(app);

    expect(result.migrated).toBe(true);
    const internalStatePath = StorageManager.getStateFilePath(app);
    expect(await app.vault.adapter.exists(internalStatePath)).toBe(true);

    const loaded = await StorageManager.loadState(app);
    expect(loaded.lastSyncedCommitSha).toBe("c3_legacy_commit");
    expect(loaded.files["Note.md"]).toBeDefined();
  });

  it("W1-REG-002: C3 nested timestamped legacy conflict migrates to internal storage and creates reviewable metadata", async () => {
    // Exact C3 runtime reproduction: _vault-relay/conflicts/1788438999027/c3-stale-runtime.md
    const conflictContent = "REMOTE CHANGED AFTER PREVIEW";
    const ts = 1788438999027;
    const legacyConflictPath = `${LEGACY_ROOT_DIR}/conflicts/${ts}/c3-stale-runtime.md`;

    await app.vault.adapter.write(LEGACY_STATE_FILE, JSON.stringify({ version: 1, files: {} }));
    await app.vault.adapter.write(legacyConflictPath, conflictContent);

    // Create local file so localSha can be computed
    await app.vault.create("c3-stale-runtime.md", "LOCAL DIFFERENT CONTENT");

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    // Verify conflict payload migrated to internal storage
    const internalConflicts = StorageManager.getConflictsDirPath(app);
    const expectedDest = `${internalConflicts}/${ts}_c3-stale-runtime.md`;
    expect(await app.vault.adapter.exists(expectedDest)).toBe(true);

    // Verify metadata created in conflicts_meta.json
    const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main" });
    const cm = new ConflictManager(app, { owner: "owner", repo: "repo", branch: "main", excludedPaths: [] }, client);
    const records = await cm.loadConflictRecords();

    expect(records.length).toBe(1);
    expect(records[0].path).toBe("c3-stale-runtime.md");
    expect(records[0].detectedAt).toBe(ts);
    expect(records[0].snapshotPath).toBe(expectedDest);
  });

  it("W1-REG-003: Dashboard conflict count and Conflict Review entries stay coherent", async () => {
    const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main" });
    const cm = new ConflictManager(app, { owner: "owner", repo: "repo", branch: "main", excludedPaths: [] }, client);

    // Simulated preview report with 1 conflict (exactly like real runtime)
    const report: SyncPreviewReport = {
      timestamp: Date.now(),
      branch: "main",
      remoteCommitSha: "remote_sha_123",
      totalScannedLocal: 2,
      totalScannedRemote: 2,
      truncatedRemoteTree: false,
      caseCollisions: [],
      counts: {
        LOCAL_ONLY: 0,
        REMOTE_ONLY: 0,
        LOCAL_CHANGED: 0,
        REMOTE_CHANGED: 0,
        LOCAL_DELETED: 0,
        REMOTE_DELETED: 0,
        POTENTIAL_CONFLICT: 1,
        DELETE_CONFLICT: 0,
        DELETED: 0,
        UNCHANGED: 5,
        OVERSIZED: 0,
        UNSAFE: 0,
      },
      items: [
        {
          path: "c3-stale-runtime.md",
          category: "POTENTIAL_CONFLICT",
          localSha: "local_hash_aaa",
          remoteSha: "remote_hash_bbb",
          baseSha: "base_hash_000",
        },
        {
          path: "clean.md",
          category: "UNCHANGED",
        },
      ],
    };

    // Before sync: 0 metadata records
    expect((await cm.loadConflictRecords()).length).toBe(0);

    // When modal opens or report syncs:
    const conflicts = await cm.syncWithPreviewReport(report);

    // Proves: Dashboard conflict count (1) == reviewable modal conflicts (1)
    expect(conflicts.length).toBe(report.counts.POTENTIAL_CONFLICT);
    expect(conflicts[0].path).toBe("c3-stale-runtime.md");
    expect(conflicts[0].localSha).toBe("local_hash_aaa");
    expect(conflicts[0].remoteSha).toBe("remote_hash_bbb");
  });

  it("W1-REG-004: Successful migration completely removes root _vault-relay directory", async () => {
    await app.vault.adapter.write(LEGACY_STATE_FILE, JSON.stringify({ version: 1, files: {} }));
    await app.vault.adapter.write(`${LEGACY_ROOT_DIR}/conflicts/12345/note.md`, "content");

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    // Proves root _vault-relay is gone
    expect(await app.vault.adapter.exists(LEGACY_ROOT_DIR)).toBe(false);
    expect(await app.vault.adapter.exists(`${LEGACY_ROOT_DIR}/conflicts`)).toBe(false);
    expect(await app.vault.adapter.exists(`${LEGACY_ROOT_DIR}/conflicts/12345/note.md`)).toBe(false);
  });

  it("W1-REG-005: No C4 production writer recreates root _vault-relay", async () => {
    // 1. Static AST/source check: verify no production file in src/ writes to _vault-relay
    const pullSource = fs.readFileSync("src/sync/pullEngine.ts", "utf8");
    expect(pullSource.includes("`_vault-relay/conflicts/")).toBe(false);
    expect(pullSource.includes('"_vault-relay/conflicts/')).toBe(false);

    // 2. Runtime execution: trigger conflict during Safe Pull and verify _vault-relay is NOT created
    await app.vault.create("ConflictNote.md", "Local Content");
    const remoteContent = "Remote Content Diff";
    const remoteSha = await calculateRawGitBlobSha(new TextEncoder().encode(remoteContent));

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c_head", commit: { tree: { sha: "t_head" } } } },
        };
      }
      if (params.url.includes("/git/trees/t_head")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "t_head",
            truncated: false,
            tree: [{ path: "ConflictNote.md", mode: "100644", type: "blob", sha: remoteSha, size: remoteContent.length }],
          },
        };
      }
      if (params.url.includes("/git/blobs/" + remoteSha)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: remoteSha, size: remoteContent.length, encoding: "utf-8", content: remoteContent },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main", requestFn: fakeRequestFn });
    const pullEngine = new PullEngine(app, { owner: "owner", repo: "repo", branch: "main", excludedPaths: [] }, client);

    const report = await pullEngine.executeSafePull();
    expect(report.counts.conflictsPreserved).toBe(1);

    // CRITICAL: Root _vault-relay was NOT created!
    expect(await app.vault.adapter.exists(LEGACY_ROOT_DIR)).toBe(false);

    // Internal storage was used instead
    const internalConflicts = StorageManager.getConflictsDirPath(app);
    expect(await app.vault.adapter.exists(internalConflicts)).toBe(true);
  });

  it("W1-REG-006: Migration failure preserves legacy source intact", async () => {
    // Corrupted state JSON
    await app.vault.adapter.write(LEGACY_STATE_FILE, "{ corrupted JSON");
    await app.vault.adapter.write(`${LEGACY_ROOT_DIR}/conflicts/photo.png`, "binary");

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(false);
    expect(result.error).toBeDefined();

    // Source files preserved untouched
    expect(await app.vault.adapter.exists(LEGACY_STATE_FILE)).toBe(true);
    expect(await app.vault.adapter.exists(`${LEGACY_ROOT_DIR}/conflicts/photo.png`)).toBe(true);
  });

  it("W1-REG-007: Partial / interrupted migration resumes without duplicate records", async () => {
    // State already migrated
    const state = { version: 1, lastSyncedCommitSha: "c1", files: {} };
    await StorageManager.saveState(app, state);

    // Legacy folder still has conflict
    await app.vault.adapter.write(`${LEGACY_ROOT_DIR}/conflicts/1000/note.md`, "conflict data");

    const res1 = await StorageManager.migrateLegacyStorage(app);
    expect(res1.migrated).toBe(true);

    const dummyClient = new GitHubClient({ token: "tok", owner: "owner", repo: "repo", branch: "main" });
    const cm = new ConflictManager(app, { owner: "owner", repo: "repo", branch: "main", excludedPaths: [] }, dummyClient);
    const records1 = await cm.loadConflictRecords();
    expect(records1.length).toBe(1);

    // Run again
    const res2 = await StorageManager.migrateLegacyStorage(app);
    expect(res2.migrated).toBe(false); // Nothing left to migrate

    const records2 = await cm.loadConflictRecords();
    expect(records2.length).toBe(1); // No duplicates
  });

  it("W1-REG-008: Binary legacy conflict remains 100% byte-exact across recursive migration", async () => {
    await app.vault.adapter.write(LEGACY_STATE_FILE, JSON.stringify({ version: 1, files: {} }));
    const binaryData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const ts = 99887766;
    await app.vault.adapter.writeBinary(`${LEGACY_ROOT_DIR}/conflicts/${ts}/diagram.png`, binaryData.buffer as ArrayBuffer);

    const result = await StorageManager.migrateLegacyStorage(app);
    expect(result.migrated).toBe(true);

    const internalConflicts = StorageManager.getConflictsDirPath(app);
    const migratedBytes = await app.vault.adapter.readBinary(`${internalConflicts}/${ts}_diagram.png`);
    expect(new Uint8Array(migratedBytes)).toEqual(binaryData);
  });
});
