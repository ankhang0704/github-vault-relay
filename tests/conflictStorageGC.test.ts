import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import { ConflictManager, ConflictRecord } from "../src/sync/conflictManager";
import { StorageManager } from "../src/sync/storageManager";
import { GitHubClient } from "../src/github/githubClient";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";

describe("C4 Conflict Internal Storage Lifecycle & Garbage Collection (GC-001..012)", () => {
  let app: App;
  const settings = {
    owner: "octocat",
    repo: "notes",
    branch: "main",
    excludedPaths: [],
  };

  const createMockClient = (options?: {
    remoteBlobBytes?: Uint8Array;
    remoteBlobSha?: string;
    pushSuccess?: boolean;
    remoteBranchSha?: string;
    localFilePath?: string;
    localFileSha?: string;
  }) => {
    const remoteBytes = options?.remoteBlobBytes || new TextEncoder().encode("Remote Conflict Content\n");
    const remoteSha = options?.remoteBlobSha || "remote_sha_old";
    const pushSuccess = options?.pushSuccess ?? true;
    const remoteBranchSha = options?.remoteBranchSha || "commit_expected";
    const localFilePath = options?.localFilePath || "Notes/Target.md";
    const localFileSha = options?.localFileSha || "local_sha_mock";

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string; body?: unknown }) => {
      // Branch ref
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: remoteBranchSha, commit: { tree: { sha: "tree_expected" } } } },
        };
      }
      if (params.url.includes("/git/trees/commit_new")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new",
            truncated: false,
            tree: [{ path: localFilePath, mode: "100644", type: "blob", sha: localFileSha, size: 50 }],
          },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new" } };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_expected",
            truncated: false,
            tree: [{ path: localFilePath, mode: "100644", type: "blob", sha: remoteSha, size: 50 }],
          },
        };
      }
      if (params.url.includes("/git/blobs/") && (!params.method || params.method === "GET")) {
        const b64 = Buffer.from(remoteBytes).toString("base64");
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: remoteSha,
            size: remoteBytes.byteLength,
            content: b64,
            encoding: "base64",
          },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: localFileSha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        if (!pushSuccess) {
          throw new Error("Simulated push rejection");
        }
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new" } } };
      }
      if (params.url.includes("/git/ref/heads/main") || params.url.includes("/git/refs/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new" } } };
      }
      throw new Error("Unhandled mock route: " + params.url);
    });

    return new GitHubClient({
      token: "mock-token",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: fakeRequestFn,
    });
  };

  beforeEach(() => {
    app = new App();
  });

  // GC-001: new conflict creates expected internal evidence
  it("GC-001: new conflict creates expected internal evidence", async () => {
    const client = createMockClient();
    const manager = new ConflictManager(app, settings, client);

    const remoteContent = "Remote conflict payload version 1\n";
    const payloadPath = await StorageManager.saveConflictPayload(app, "Notes/Doc.md", remoteContent);

    expect(await app.vault.adapter.exists(payloadPath)).toBe(true);
    expect(payloadPath).toContain(".obsidian/github-vault-relay/conflicts/");

    const record = await manager.recordConflict(
      "Notes/Doc.md",
      "local_sha_1",
      "remote_sha_1",
      "commit_1",
      "base_sha_1",
      payloadPath
    );

    expect(record.snapshotPath).toBe(payloadPath);

    const savedRecords = await manager.loadConflictRecords();
    expect(savedRecords.length).toBe(1);
    expect(savedRecords[0].snapshotPath).toBe(payloadPath);
    expect(await app.vault.adapter.read(payloadPath)).toBe(remoteContent);
  });

  // GC-002: unresolved conflict retains evidence
  it("GC-002: unresolved conflict retains evidence", async () => {
    const client = createMockClient();
    const manager = new ConflictManager(app, settings, client);

    const payloadPath = await StorageManager.saveConflictPayload(app, "Active.md", "Active payload");
    await manager.recordConflict("Active.md", "l1", "r1", "c1", "b1", payloadPath);

    // Run orphan GC reconciliation
    const gcResult = await manager.reconcileOrphanPayloads();
    expect(gcResult.removed).toBe(0);

    // Verify evidence remains untouched
    expect(await app.vault.adapter.exists(payloadPath)).toBe(true);
    const records = await manager.loadConflictRecords();
    expect(records.length).toBe(1);
    expect(records[0].path).toBe("Active.md");
  });

  // GC-003: Keep Local success removes obsolete payload
  it("GC-003: Keep Local success removes obsolete payload", async () => {
    const localContent = "# Local Authoritative Version\n";
    await app.vault.create("Notes/Target.md", localContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(localContent));

    const client = createMockClient({ localFilePath: "Notes/Target.md", localFileSha: localSha });
    const manager = new ConflictManager(app, settings, client);

    const payloadPath = await StorageManager.saveConflictPayload(app, "Notes/Target.md", "Remote to discard");
    expect(await app.vault.adapter.exists(payloadPath)).toBe(true);

    const record: ConflictRecord = {
      id: "c_keep_local_gc",
      path: "Notes/Target.md",
      localSha,
      remoteSha: "remote_sha_old",
      remoteCommitSha: "commit_expected",
      detectedAt: Date.now(),
      snapshotPath: payloadPath,
    };
    await manager.saveConflictRecords([record]);

    const res = await manager.resolveKeepLocal(record);
    expect(res.success).toBe(true);

    // Invariant: metadata removed
    const remainingRecords = await manager.loadConflictRecords();
    expect(remainingRecords.length).toBe(0);

    // Invariant: obsolete payload removed from disk
    expect(await app.vault.adapter.exists(payloadPath)).toBe(false);

    // User file remains untouched
    expect(await app.vault.adapter.exists("Notes/Target.md")).toBe(true);
  });

  // GC-004: Use Remote success removes obsolete payload
  it("GC-004: Use Remote success removes obsolete payload", async () => {
    const localContent = "# Old Local Version\n";
    await app.vault.create("Notes/RemoteWins.md", localContent);
    const localSha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(localContent), "Notes/RemoteWins.md");

    const remoteContent = "# New Remote Content Wins\n";
    const remoteBytes = new TextEncoder().encode(remoteContent);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);

    const client = createMockClient({
      remoteBlobBytes: remoteBytes,
      remoteBlobSha: remoteSha,
      localFilePath: "Notes/RemoteWins.md",
    });
    const manager = new ConflictManager(app, settings, client);

    const payloadPath = await StorageManager.saveConflictPayload(app, "Notes/RemoteWins.md", remoteContent);
    expect(await app.vault.adapter.exists(payloadPath)).toBe(true);

    const record: ConflictRecord = {
      id: "c_use_remote_gc",
      path: "Notes/RemoteWins.md",
      localSha,
      remoteSha: remoteSha,
      remoteCommitSha: "commit_expected",
      detectedAt: Date.now(),
      snapshotPath: payloadPath,
    };
    await manager.saveConflictRecords([record]);

    const res = await manager.resolveUseRemote(record);
    expect(res.success).toBe(true);

    // Metadata removed
    const remaining = await manager.loadConflictRecords();
    expect(remaining.length).toBe(0);

    // Payload deleted
    expect(await app.vault.adapter.exists(payloadPath)).toBe(false);

    // Local file updated to remote content
    const updated = await app.vault.adapter.read("Notes/RemoteWins.md");
    expect(updated).toBe(remoteContent);
  });

  // GC-005: Keep Both success preserves user copy then removes internal payload
  it("GC-005: Keep Both success preserves user copy then removes internal payload", async () => {
    const localContent = "# Local Document\n";
    await app.vault.create("Notes/Both.md", localContent);
    const localSha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(localContent), "Notes/Both.md");

    const remoteContent = "# Remote Incoming Copy\n";
    const remoteBytes = new TextEncoder().encode(remoteContent);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);

    const client = createMockClient({
      remoteBlobBytes: remoteBytes,
      remoteBlobSha: remoteSha,
      localFilePath: "Notes/Both.md",
    });
    const manager = new ConflictManager(app, settings, client);

    const payloadPath = await StorageManager.saveConflictPayload(app, "Notes/Both.md", remoteContent);
    expect(await app.vault.adapter.exists(payloadPath)).toBe(true);

    const record: ConflictRecord = {
      id: "c_keep_both_gc",
      path: "Notes/Both.md",
      localSha,
      remoteSha,
      remoteCommitSha: "commit_expected",
      detectedAt: Date.now(),
      snapshotPath: payloadPath,
    };
    await manager.saveConflictRecords([record]);

    const res = await manager.resolveKeepBoth(record);
    expect(res.success).toBe(true);
    expect(res.copyPath).toBeDefined();

    // User copy exists and has exact remote content
    expect(await app.vault.adapter.exists(res.copyPath!)).toBe(true);
    expect(await app.vault.adapter.read(res.copyPath!)).toBe(remoteContent);

    // User copy is NOT in internal directory
    expect(res.copyPath!).not.toContain(".obsidian");

    // Metadata removed
    const remaining = await manager.loadConflictRecords();
    expect(remaining.length).toBe(0);

    // Internal payload removed
    expect(await app.vault.adapter.exists(payloadPath)).toBe(false);
  });

  // GC-006: failed resolution retains evidence
  it("GC-006: failed resolution retains evidence", async () => {
    const localContent = "# Local Content\n";
    await app.vault.create("Notes/Fail.md", localContent);
    const localSha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(localContent), "Notes/Fail.md");

    // Client configured to reject push
    const client = createMockClient({ pushSuccess: false });
    const manager = new ConflictManager(app, settings, client);

    const payloadPath = await StorageManager.saveConflictPayload(app, "Notes/Fail.md", "Remote data");
    const record: ConflictRecord = {
      id: "c_fail_gc",
      path: "Notes/Fail.md",
      localSha,
      remoteSha: "rem_1",
      remoteCommitSha: "commit_expected",
      detectedAt: Date.now(),
      snapshotPath: payloadPath,
    };
    await manager.saveConflictRecords([record]);

    const res = await manager.resolveKeepLocal(record);
    expect(res.success).toBe(false);

    // Invariant: evidence preserved
    expect(await app.vault.adapter.exists(payloadPath)).toBe(true);
    const records = await manager.loadConflictRecords();
    expect(records.length).toBe(1);
    expect(records[0].snapshotPath).toBe(payloadPath);
  });

  // GC-007: app interruption can leave orphan safely
  it("GC-007: app interruption can leave orphan safely", async () => {
    const client = createMockClient();
    const manager = new ConflictManager(app, settings, client);

    // Simulate crash after metadata removal before payload cleanup:
    // Payload exists on disk, but conflicts_meta.json has 0 records.
    const orphanPath = await StorageManager.saveConflictPayload(app, "Orphan.md", "Orphaned remote bytes");
    expect(await app.vault.adapter.exists(orphanPath)).toBe(true);

    // Metadata is empty
    await manager.saveConflictRecords([]);
    const loaded = await manager.loadConflictRecords();
    expect(loaded.length).toBe(0);

    // Safe operation without crashes
    const active = await manager.loadConflictRecords();
    expect(active.length).toBe(0);
  });

  // GC-008: startup reconciliation removes proven orphan
  it("GC-008: startup reconciliation removes proven orphan", async () => {
    const client = createMockClient();
    const manager = new ConflictManager(app, settings, client);

    const orphan1 = await StorageManager.saveConflictPayload(app, "Orphan1.md", "Orphan 1 bytes");
    const orphan2 = await StorageManager.saveConflictPayload(app, "Orphan2.md", "Orphan 2 bytes");
    expect(await app.vault.adapter.exists(orphan1)).toBe(true);
    expect(await app.vault.adapter.exists(orphan2)).toBe(true);

    // No active metadata references
    await manager.saveConflictRecords([]);

    // Run startup GC
    const report = await StorageManager.cleanOrphanConflictPayloads(app);
    expect(report.scanned).toBe(2);
    expect(report.removed).toBe(2);
    expect(report.bytesReclaimed).toBeGreaterThan(0);

    // Orphans deleted
    expect(await app.vault.adapter.exists(orphan1)).toBe(false);
    expect(await app.vault.adapter.exists(orphan2)).toBe(false);
  });

  // GC-009: startup reconciliation never deletes active conflict payload
  it("GC-009: startup reconciliation never deletes active conflict payload", async () => {
    const client = createMockClient();
    const manager = new ConflictManager(app, settings, client);

    // 1 active payload, 1 orphan payload
    const activePayload = await StorageManager.saveConflictPayload(app, "Active.md", "Active bytes");
    const orphanPayload = await StorageManager.saveConflictPayload(app, "Orphan.md", "Orphan bytes");

    await manager.recordConflict("Active.md", "loc1", "rem1", "com1", "base1", activePayload);

    // Run reconciliation
    const report = await StorageManager.cleanOrphanConflictPayloads(app);
    expect(report.scanned).toBe(2);
    expect(report.removed).toBe(1);

    // Orphan deleted, active preserved
    expect(await app.vault.adapter.exists(orphanPayload)).toBe(false);
    expect(await app.vault.adapter.exists(activePayload)).toBe(true);

    const records = await manager.loadConflictRecords();
    expect(records.length).toBe(1);
    expect(records[0].snapshotPath).toBe(activePayload);
  });

  // GC-010: 1,000 create+resolve lifecycle leaves zero obsolete payloads
  it("GC-010: 1,000 create+resolve lifecycle leaves zero obsolete payloads", async () => {
    const client = createMockClient();
    const manager = new ConflictManager(app, settings, client);

    const conflictsDir = StorageManager.getConflictsDirPath(app);

    // Execute 1,000 sequential create + resolve cycles
    // Using removeConflict (which is the verified final step of Keep Local / Use Remote / Keep Both)
    for (let i = 0; i < 1000; i++) {
      const path = `Note_${i}.md`;
      const payloadPath = await StorageManager.saveConflictPayload(app, path, `Payload content for ${i}\n`);
      await manager.recordConflict(path, `loc_${i}`, `rem_${i}`, "commit_1", "base_1", payloadPath);

      // Resolve and remove
      await manager.removeConflict(path);
    }

    // Verify 0 active records
    const records = await manager.loadConflictRecords();
    expect(records.length).toBe(0);

    // Check conflicts directory files on adapter
    const list = await app.vault.adapter.list(conflictsDir);
    expect(list.files.length).toBe(0);

    // Extra check: run orphan GC to confirm 0 files scanned and 0 removed
    const gc = await StorageManager.cleanOrphanConflictPayloads(app);
    expect(gc.scanned).toBe(0);
    expect(gc.removed).toBe(0);
  }, 30000);

  // GC-011: duplicate/shared payload strategy does not corrupt references if used
  it("GC-011: duplicate/shared payload strategy does not corrupt references if used", async () => {
    const client = createMockClient();
    const manager = new ConflictManager(app, settings, client);

    // Two conflicts referencing the exact same payload file
    const sharedPayload = await StorageManager.saveConflictPayload(app, "Shared.md", "Shared remote payload");

    await manager.recordConflict("FileA.md", "locA", "remA", "c1", "b1", sharedPayload);
    await manager.recordConflict("FileB.md", "locB", "remB", "c1", "b1", sharedPayload);

    const initial = await manager.loadConflictRecords();
    expect(initial.length).toBe(2);

    // Resolve FileA: payload should NOT be deleted because FileB still references it
    await manager.removeConflict("FileA.md");
    expect(await app.vault.adapter.exists(sharedPayload)).toBe(true);

    const mid = await manager.loadConflictRecords();
    expect(mid.length).toBe(1);
    expect(mid[0].path).toBe("FileB.md");

    // Resolve FileB: now payload should be deleted
    await manager.removeConflict("FileB.md");
    expect(await app.vault.adapter.exists(sharedPayload)).toBe(false);

    const end = await manager.loadConflictRecords();
    expect(end.length).toBe(0);
  });

  // GC-012: internal cleanup never touches normal vault content
  it("GC-012: internal cleanup never touches normal vault content", async () => {
    // Setup normal vault files
    await app.vault.create("Notes/ImportantNote.md", "# Important Note\n");
    await app.vault.create("Daily/2026-09-04.md", "# Daily Log\n");
    await app.vault.adapter.write(".obsidian/app.json", '{"theme": "dark"}');

    // 1. Attempt deleteConflictPayload on external / vault files
    const deleteNote = await StorageManager.deleteConflictPayload(app, "Notes/ImportantNote.md");
    expect(deleteNote).toBe(false);
    expect(await app.vault.adapter.exists("Notes/ImportantNote.md")).toBe(true);

    const deleteAppJson = await StorageManager.deleteConflictPayload(app, ".obsidian/app.json");
    expect(deleteAppJson).toBe(false);
    expect(await app.vault.adapter.exists(".obsidian/app.json")).toBe(true);

    // Path traversal attack attempt
    const deleteTraversal = await StorageManager.deleteConflictPayload(
      app,
      ".obsidian/github-vault-relay/conflicts/../../Notes/ImportantNote.md"
    );
    expect(deleteTraversal).toBe(false);
    expect(await app.vault.adapter.exists("Notes/ImportantNote.md")).toBe(true);

    // 2. Run cleanOrphanConflictPayloads and ensure vault files remain untouched
    const gc = await StorageManager.cleanOrphanConflictPayloads(app);
    expect(await app.vault.adapter.exists("Notes/ImportantNote.md")).toBe(true);
    expect(await app.vault.adapter.exists("Daily/2026-09-04.md")).toBe(true);
    expect(await app.vault.adapter.exists(".obsidian/app.json")).toBe(true);
    expect(gc.removed).toBe(0);
  });
});
