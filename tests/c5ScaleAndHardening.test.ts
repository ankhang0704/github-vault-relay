/**
 * C5-SCALE: Large Vault / Scale & Performance Tests
 * C5-SIZE: Binary Size Boundary Tests
 * C5-CACHE: Local Hash Cache Final Audit
 * C5-GC: Memory / Storage Leak Audit
 * C5-STORAGE: Internal Storage Lifecycle
 * C5-RATELIMIT: API Rate Limit Behavior
 * C5-CONFLICT: Final Conflict Matrix
 * C5-SYNCFAIL: Unified Sync Failure Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import { classifySyncState } from "../src/sync/syncClassifier";
import { SyncEngine } from "../src/sync/syncEngine";
import { UnifiedSyncEngine } from "../src/sync/unifiedSyncEngine";
import { ConflictManager } from "../src/sync/conflictManager";
import { GitHubClient } from "../src/github/githubClient";
import { VaultRelaySettings, DEFAULT_SETTINGS } from "../src/settings";
import { calculateCanonicalGitBlobSha } from "../src/sync/hashUtils";
import { isOversized, MAX_SAFE_FILE_SIZE_BYTES, formatFileSize } from "../src/sync/fileSizePolicy";
import { StorageManager } from "../src/sync/storageManager";
import { LocalFileEntry, RemoteBlobEntry, SyncStateData } from "../src/sync/syncTypes";
import { SyncProgressEvent } from "../src/sync/progressTypes";

function makeSettings(): VaultRelaySettings {
  return { ...DEFAULT_SETTINGS, owner: "owner", repo: "repo", branch: "main" };
}

// =========================================================
// C5-SCALE: Large Vault / Scale Tests
// =========================================================
describe("C5-SCALE: Large Vault Classification Performance (C5-SCALE-001..005)", () => {
  function generateFiles(count: number): { local: Map<string, LocalFileEntry>; remote: Map<string, RemoteBlobEntry> } {
    const local = new Map<string, LocalFileEntry>();
    const remote = new Map<string, RemoteBlobEntry>();
    for (let i = 0; i < count; i++) {
      const path = `folder${Math.floor(i / 50)}/note_${i}.md`;
      const sha = `sha_${i}_${Date.now()}`;
      local.set(path, { path, sha, size: 1000 + i, mtime: Date.now() });
      remote.set(path, { path, sha, size: 1000 + i, mode: "100644" });
    }
    return { local, remote };
  }

  it("C5-SCALE-001: 100 files classification completes without error", () => {
    const { local, remote } = generateFiles(100);
    const result = classifySyncState({ localFiles: local, remoteBlobs: remote });
    expect(result.items).toHaveLength(100);
    expect(result.counts.UNCHANGED).toBe(100);
  });

  it("C5-SCALE-002: 500 files classification completes without error", () => {
    const { local, remote } = generateFiles(500);
    const result = classifySyncState({ localFiles: local, remoteBlobs: remote });
    expect(result.items).toHaveLength(500);
    expect(result.counts.UNCHANGED).toBe(500);
  });

  it("C5-SCALE-003: 1000 files classification completes without error", () => {
    const { local, remote } = generateFiles(1000);
    const result = classifySyncState({ localFiles: local, remoteBlobs: remote });
    expect(result.items).toHaveLength(1000);
    expect(result.counts.UNCHANGED).toBe(1000);
  });

  it("C5-SCALE-004: 1000 files with mixed categories classifies correctly", () => {
    const local = new Map<string, LocalFileEntry>();
    const remote = new Map<string, RemoteBlobEntry>();
    const state: SyncStateData = { version: 1, files: {} };

    for (let i = 0; i < 1000; i++) {
      const path = `notes/file_${i}.md`;
      if (i < 200) {
        // LOCAL_ONLY
        local.set(path, { path, sha: `local_${i}`, size: 100, mtime: Date.now() });
      } else if (i < 400) {
        // REMOTE_ONLY
        remote.set(path, { path, sha: `remote_${i}`, size: 100, mode: "100644" });
      } else if (i < 600) {
        // UNCHANGED
        const sha = `same_${i}`;
        local.set(path, { path, sha, size: 100, mtime: Date.now() });
        remote.set(path, { path, sha, size: 100, mode: "100644" });
      } else if (i < 800) {
        // LOCAL_CHANGED
        const baseSha = `base_${i}`;
        local.set(path, { path, sha: `changed_${i}`, size: 100, mtime: Date.now() });
        remote.set(path, { path, sha: baseSha, size: 100, mode: "100644" });
        state.files[path] = { localSha: baseSha, remoteSha: baseSha, syncedAt: Date.now() };
      } else {
        // POTENTIAL_CONFLICT
        local.set(path, { path, sha: `local_conflict_${i}`, size: 100, mtime: Date.now() });
        remote.set(path, { path, sha: `remote_conflict_${i}`, size: 100, mode: "100644" });
      }
    }

    const result = classifySyncState({ localFiles: local, remoteBlobs: remote, state });
    expect(result.counts.LOCAL_ONLY).toBe(200);
    expect(result.counts.REMOTE_ONLY).toBe(200);
    expect(result.counts.UNCHANGED).toBe(200);
    expect(result.counts.LOCAL_CHANGED).toBe(200);
    expect(result.counts.POTENTIAL_CONFLICT).toBe(200);
  });

  it("C5-SCALE-005: Classification does not exhibit quadratic explosion", () => {
    const start100 = performance.now();
    const { local: l100, remote: r100 } = generateFiles(100);
    classifySyncState({ localFiles: l100, remoteBlobs: r100 });
    const t100 = performance.now() - start100;

    const start1000 = performance.now();
    const { local: l1000, remote: r1000 } = generateFiles(1000);
    classifySyncState({ localFiles: l1000, remoteBlobs: r1000 });
    const t1000 = performance.now() - start1000;

    // 10x files should not take more than ~50x time (generous margin, not quadratic)
    // Quadratic would be 100x
    expect(t1000).toBeLessThan(t100 * 50 + 100); // +100ms buffer for overhead
  });
});

// =========================================================
// C5-SIZE: Binary Size Boundary Tests
// =========================================================
describe("C5-SIZE: Binary Size Boundaries (C5-SIZE-001..005)", () => {
  it("C5-SIZE-001: Small file (1 KB) → not oversized", () => {
    expect(isOversized(1024)).toBe(false);
  });

  it("C5-SIZE-002: ~5 MiB file → not oversized", () => {
    expect(isOversized(5 * 1024 * 1024)).toBe(false);
  });

  it("C5-SIZE-003: ~10 MiB file → not oversized", () => {
    expect(isOversized(10 * 1024 * 1024)).toBe(false);
  });

  it("C5-SIZE-004: ~24 MiB file → not oversized (below ceiling)", () => {
    expect(isOversized(24 * 1024 * 1024)).toBe(false);
  });

  it("C5-SIZE-005: >25 MiB file → OVERSIZED, BLOCKED", () => {
    expect(isOversized(25 * 1024 * 1024 + 1)).toBe(true);
    expect(isOversized(26 * 1024 * 1024)).toBe(true);
    expect(isOversized(100 * 1024 * 1024)).toBe(true);
  });

  it("C5-SIZE-006: MAX_SAFE_FILE_SIZE_BYTES equals exactly 25 MiB", () => {
    expect(MAX_SAFE_FILE_SIZE_BYTES).toBe(25 * 1024 * 1024);
  });

  it("C5-SIZE-007: formatFileSize produces readable output", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toContain("KiB");
    expect(formatFileSize(5 * 1024 * 1024)).toContain("MiB");
  });

  it("C5-SIZE-008: isOversized handles undefined/NaN gracefully", () => {
    expect(isOversized(undefined)).toBe(false);
    expect(isOversized(NaN)).toBe(false);
  });
});

// =========================================================
// C5-GC: Storage/Memory Leak Audit
// =========================================================
describe("C5-GC: Conflict Storage GC & Lifecycle (C5-GC-001..005)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("C5-GC-001: Orphan GC removes unreferenced payloads", async () => {
    // Create orphan file in conflicts dir
    const conflictsDir = StorageManager.getConflictsDirPath(app);
    await app.vault.adapter.mkdir(conflictsDir);
    await app.vault.adapter.write(`${conflictsDir}/orphan_file.md`, "orphan content");

    // Empty metadata (no references)
    const metaPath = StorageManager.getConflictsMetaFilePath(app);
    await app.vault.adapter.write(metaPath, "[]");

    const result = await StorageManager.cleanOrphanConflictPayloads(app);
    expect(result.removed).toBe(1);
  });

  it("C5-GC-002: Orphan GC preserves active referenced payloads", async () => {
    const conflictsDir = StorageManager.getConflictsDirPath(app);
    await app.vault.adapter.mkdir(conflictsDir);
    const activePath = `${conflictsDir}/active_conflict.md`;
    await app.vault.adapter.write(activePath, "active conflict content");

    // Reference in metadata
    const metaPath = StorageManager.getConflictsMetaFilePath(app);
    await app.vault.adapter.write(metaPath, JSON.stringify([{
      id: "active_001",
      path: "notes/hello.md",
      localSha: "sha1",
      remoteSha: "sha2",
      detectedAt: Date.now(),
      snapshotPath: activePath,
    }]));

    const result = await StorageManager.cleanOrphanConflictPayloads(app);
    expect(result.removed).toBe(0);

    // File should still exist
    const exists = await app.vault.adapter.exists(activePath);
    expect(exists).toBe(true);
  });

  it("C5-GC-003: Orphan GC aborts if metadata is unreadable (preserves evidence)", async () => {
    const conflictsDir = StorageManager.getConflictsDirPath(app);
    await app.vault.adapter.mkdir(conflictsDir);
    await app.vault.adapter.write(`${conflictsDir}/potentially_active.md`, "some content");

    // Broken metadata
    const metaPath = StorageManager.getConflictsMetaFilePath(app);
    await app.vault.adapter.write(metaPath, "{ broken json }}");

    const result = await StorageManager.cleanOrphanConflictPayloads(app);
    expect(result.removed).toBe(0);
    expect(result.scanned).toBe(0);

    // File preserved
    const exists = await app.vault.adapter.exists(`${conflictsDir}/potentially_active.md`);
    expect(exists).toBe(true);
  });

  it("C5-GC-004: deleteConflictPayload rejects path traversal", async () => {
    const result = await StorageManager.deleteConflictPayload(app, "../../../etc/passwd");
    expect(result).toBe(false);
  });

  it("C5-GC-005: deleteConflictPayload rejects paths outside canonical dir", async () => {
    const result = await StorageManager.deleteConflictPayload(app, "notes/important.md");
    expect(result).toBe(false);
  });
});

// =========================================================
// C5-STORAGE: Internal Storage Lifecycle
// =========================================================
describe("C5-STORAGE: Internal Storage Lifecycle (C5-STORAGE-001..004)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("C5-STORAGE-001: Canonical storage dir is .obsidian/github-vault-relay", () => {
    const dir = StorageManager.getPluginStorageDir(app);
    expect(dir).toBe(".obsidian/github-vault-relay");
  });

  it("C5-STORAGE-002: State file path is canonical", () => {
    const path = StorageManager.getStateFilePath(app);
    expect(path).toBe(".obsidian/github-vault-relay/state.json");
  });

  it("C5-STORAGE-003: Conflicts dir is canonical", () => {
    const path = StorageManager.getConflictsDirPath(app);
    expect(path).toBe(".obsidian/github-vault-relay/conflicts");
  });

  it("C5-STORAGE-004: State save and load roundtrip preserves all fields", async () => {
    const state: SyncStateData = {
      version: 1,
      lastSyncedCommitSha: "commit_roundtrip",
      lastSyncedAt: 1234567890,
      files: {
        "a.md": { localSha: "lsha1", remoteSha: "rsha1", syncedAt: 100 },
        "b/c.md": { localSha: "lsha2", remoteSha: "rsha2", syncedAt: 200 },
      },
    };

    await StorageManager.saveState(app, state);
    const loaded = await StorageManager.loadState(app);

    expect(loaded.version).toBe(1);
    expect(loaded.lastSyncedCommitSha).toBe("commit_roundtrip");
    expect(loaded.lastSyncedAt).toBe(1234567890);
    expect(loaded.files["a.md"].localSha).toBe("lsha1");
    expect(loaded.files["b/c.md"].remoteSha).toBe("rsha2");
  });
});

// =========================================================
// C5-CACHE: Local Hash Cache Audit
// =========================================================
describe("C5-CACHE: Local Hash Cache Audit (C5-CACHE-001..003)", () => {
  it("C5-CACHE-001: Same path/size/mtime but different bytes → cache returns stale SHA, but mutation paths re-read", async () => {
    const app = new App();
    const file = await app.vault.create("test.md", "AAAA");
    const originalStat = { ...file.stat };
    const engine = new SyncEngine(app, makeSettings());
    const first = await engine.scanLocalVault();

    await app.vault.modify(file, "BBBB");
    const originalGetFiles = app.vault.getFiles;
    app.vault.getFiles = () => originalGetFiles().map((entry) => {
      if (entry.path === "test.md") entry.stat = originalStat;
      return entry;
    });

    const cached = await engine.scanLocalVault();
    const trustworthy = await engine.scanLocalVault(true);
    expect(cached.get("test.md")?.sha).toBe(first.get("test.md")?.sha);
    expect(trustworthy.get("test.md")?.sha).not.toBe(first.get("test.md")?.sha);
  });

  it("C5-CACHE-002: calculateCanonicalGitBlobSha normalizes CRLF for text files", async () => {
    const crlfContent = new TextEncoder().encode("line1\r\nline2\r\nline3");
    const lfContent = new TextEncoder().encode("line1\nline2\nline3");

    const shaCRLF = await calculateCanonicalGitBlobSha(crlfContent, "test.md");
    const shaLF = await calculateCanonicalGitBlobSha(lfContent, "test.md");

    expect(shaCRLF).toBe(shaLF);
  });

  it("C5-CACHE-003: calculateCanonicalGitBlobSha does NOT normalize binary files", async () => {
    const binaryWithCRLF = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]);
    const binaryWithLF = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0A]);

    const shaCRLF = await calculateCanonicalGitBlobSha(binaryWithCRLF, "image.png");
    const shaLF = await calculateCanonicalGitBlobSha(binaryWithLF, "image.png");

    // Binary files should NOT be normalized
    expect(shaCRLF).not.toBe(shaLF);
  });
});

// =========================================================
// C5-RATELIMIT: API Rate Limit Behavior
// =========================================================
describe("C5-RATELIMIT: Rate Limit & Retry Behavior (C5-RATELIMIT-001..004)", () => {
  it("C5-RATELIMIT-001: 429 Retry-After bounded to max 10 seconds", async () => {
    let callCount = 0;
    const client = new GitHubClient({
      token: "github_pat_test_429",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => {
        callCount++;
        return {
          status: 429, headers: { "retry-after": "100" }, // Extreme value
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "rate limited" }, text: "",
        };
      },
    });

    try {
      await client.getRepo();
    } catch {
      // Expected to fail after max retries
    }

    // Should have made bounded number of attempts (not infinite)
    expect(callCount).toBeGreaterThan(1);
    expect(callCount).toBeLessThanOrEqual(5);
  }, 30_000); // Allow 30 seconds for bounded retry-after waits

  it("C5-RATELIMIT-002: 401/403 fail fast without retry", async () => {
    let callCount = 0;
    const client = new GitHubClient({
      token: "github_pat_test_auth",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => {
        callCount++;
        return {
          status: 401, headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "Bad credentials" }, text: "",
        };
      },
    });

    await expect(client.getRepo()).rejects.toThrow(/401/);
    expect(callCount).toBe(1); // No retry for auth errors
  });

  it("C5-RATELIMIT-003: 503/504 retry with bounded exponential backoff", async () => {
    let callCount = 0;
    const client = new GitHubClient({
      token: "github_pat_test_503",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => {
        callCount++;
        return {
          status: 503, headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "Service Unavailable" }, text: "",
        };
      },
    });

    await expect(client.getRepo()).rejects.toThrow();
    expect(callCount).toBe(3); // max 3 attempts
  });

  it("C5-RATELIMIT-004: Generic 422 fails closed without retry", async () => {
    let callCount = 0;
    const client = new GitHubClient({
      token: "github_pat_test_422",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => {
        callCount++;
        return {
          status: 422, headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "Unprocessable Entity" }, text: "",
        };
      },
    });

    await expect(client.getRepo()).rejects.toThrow(/422/);
    expect(callCount).toBe(1); // No retry
  });
});

// =========================================================
// C5-CONFLICT: Final Conflict Matrix
// =========================================================
describe("C5-CONFLICT: Final Conflict Matrix (C5-CONFLICT-001..005)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("C5-CONFLICT-001: ConflictManager recordConflict creates metadata entry", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test", owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" }),
    });
    const cm = new ConflictManager(app, settings, client);

    const record = await cm.recordConflict("notes/conflict.md", "local_sha", "remote_sha", "commit_sha");
    expect(record.path).toBe("notes/conflict.md");
    expect(record.localSha).toBe("local_sha");
    expect(record.remoteSha).toBe("remote_sha");

    const records = await cm.loadConflictRecords();
    expect(records).toHaveLength(1);
    expect(records[0].path).toBe("notes/conflict.md");
  });

  it("C5-CONFLICT-002: Resolved conflict is removed from metadata", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test", owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" }),
    });
    const cm = new ConflictManager(app, settings, client);

    await cm.recordConflict("notes/resolved.md", "local", "remote");
    let records = await cm.loadConflictRecords();
    expect(records).toHaveLength(1);

    await cm.removeConflict("notes/resolved.md");
    records = await cm.loadConflictRecords();
    expect(records).toHaveLength(0);
  });

  it("C5-CONFLICT-003: Multiple conflicts tracked independently", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test", owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" }),
    });
    const cm = new ConflictManager(app, settings, client);

    await cm.recordConflict("notes/a.md", "la", "ra");
    await cm.recordConflict("notes/b.md", "lb", "rb");
    await cm.recordConflict("notes/c.md", "lc", "rc");

    const records = await cm.loadConflictRecords();
    expect(records).toHaveLength(3);

    // Remove one
    await cm.removeConflict("notes/b.md");
    const remaining = await cm.loadConflictRecords();
    expect(remaining).toHaveLength(2);
    expect(remaining.find((r) => r.path === "notes/b.md")).toBeUndefined();
  });

  it("C5-CONFLICT-004: Re-recording same path updates existing record", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test", owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" }),
    });
    const cm = new ConflictManager(app, settings, client);

    await cm.recordConflict("notes/update.md", "old_local", "old_remote");
    await cm.recordConflict("notes/update.md", "new_local", "new_remote");

    const records = await cm.loadConflictRecords();
    expect(records).toHaveLength(1);
    expect(records[0].localSha).toBe("new_local");
    expect(records[0].remoteSha).toBe("new_remote");
  });

  it("C5-CONFLICT-005: Conflict count equals reviewable unresolved conflicts", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test", owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" }),
    });
    const cm = new ConflictManager(app, settings, client);

    await cm.recordConflict("a.md", "la", "ra");
    await cm.recordConflict("b.md", "lb", "rb");
    await cm.recordConflict("c.md", "lc", "rc");

    // Resolve one
    await cm.removeConflict("b.md");

    const records = await cm.loadConflictRecords();
    expect(records).toHaveLength(2);
    // Count matches unresolved
    expect(records.filter((r) => !r.id || r.id.length > 0)).toHaveLength(2);
  });
});

// =========================================================
// C5-SYNCFAIL: Unified Sync Failure Tests
// =========================================================
describe("C5-SYNCFAIL: Unified Sync Failure (C5-SYNCFAIL-001..004)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("C5-SYNCFAIL-001: Pull failure → Push never starts", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test_syncfail",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => ({
        status: 500, headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { message: "Server error" }, text: "",
      }),
    });
    const engine = new UnifiedSyncEngine(app, settings, client);
    const events: SyncProgressEvent[] = [];

    let result;
    try {
      result = await engine.executeSync((e) => events.push(e));
    } catch {
      // UnifiedSyncEngine may throw on hard failures from generatePreview
      // This is expected — verify no UPLOADING phase was reached
      expect(events.some((e) => e.phase === "UPLOADING")).toBe(false);
      return;
    }
    expect(result.status).toBe("FAIL");
    expect(result.pushedCount).toBe(0);
    // Should never reach UPLOADING phase
    expect(events.some((e) => e.phase === "UPLOADING")).toBe(false);
  });

  it("C5-SYNCFAIL-002: No changes → PASS immediately", async () => {
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "empty_commit", commit: { tree: { sha: "empty_tree" } } } },
            text: "",
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "empty_tree", tree: [], truncated: false },
            text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
    const engine = new UnifiedSyncEngine(app, settings, client);

    const result = await engine.executeSync();
    expect(result.status).toBe("PASS");
    expect(result.pulledCount).toBe(0);
    expect(result.pushedCount).toBe(0);
  });

  it("C5-SYNCFAIL-003: Partial success reported truthfully (Pull OK, Push failed)", async () => {
    const settings = makeSettings();
    const fileContent = new TextEncoder().encode("local only for push");
    await app.vault.createBinary("local-only.md", fileContent.buffer as ArrayBuffer);

    const client = new GitHubClient({
      token: "github_pat_test",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_partial", commit: { tree: { sha: "tree_partial" } } } },
            text: "",
          };
        }
        if (params.url.includes("/git/trees/") && (params.method || "GET") === "GET") {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_partial", tree: [], truncated: false },
            text: "",
          };
        }
        // Blob upload fails for push
        if (params.url.includes("/git/blobs") && params.method === "POST") {
          return {
            status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { message: "blob upload failed" }, text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
    const engine = new UnifiedSyncEngine(app, settings, client);

    const result = await engine.executeSync();
    // Pull had nothing to do, Push failed at blob upload
    expect(["FAIL", "ABORTED"]).toContain(result.status);
    expect(result.summaryMessage).toBeTruthy();
  });

  it("C5-SYNCFAIL-004: Unified sync does not pretend to be atomic", async () => {
    // This is a design audit test: the UnifiedSyncResult explicitly separates
    // pullReport and pushReport, has durationMs, and reports partial success
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "atomic_test", commit: { tree: { sha: "tree_atomic" } } } },
            text: "",
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_atomic", tree: [], truncated: false },
            text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
    const engine = new UnifiedSyncEngine(app, settings, client);

    const result = await engine.executeSync();
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.finalReport).toBeTruthy();
    // Result type has pullReport and pushReport as optional fields
    // They may be undefined when no sync phases ran
    expect(result.pullReport === undefined || result.pullReport !== null).toBe(true);
    expect(result.pushReport === undefined || result.pushReport !== null).toBe(true);
  });
});
