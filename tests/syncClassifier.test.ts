import { describe, it, expect } from "vitest";
import { classifySyncState } from "../src/sync/syncClassifier";
import { LocalFileEntry, RemoteBlobEntry, SyncStateData } from "../src/sync/syncTypes";

describe("syncClassifier", () => {
  it("classifies LOCAL_ONLY when file only exists locally", () => {
    const localFiles = new Map<string, LocalFileEntry>([
      ["Notes/NewLocal.md", { path: "Notes/NewLocal.md", sha: "sha_local_1", size: 100 }],
    ]);
    const remoteBlobs = new Map<string, RemoteBlobEntry>();

    const result = classifySyncState({ localFiles, remoteBlobs });

    expect(result.counts.LOCAL_ONLY).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      path: "Notes/NewLocal.md",
      category: "LOCAL_ONLY",
      localSha: "sha_local_1",
    });
  });

  it("classifies REMOTE_ONLY when file only exists remotely", () => {
    const localFiles = new Map<string, LocalFileEntry>();
    const remoteBlobs = new Map<string, RemoteBlobEntry>([
      ["Notes/NewRemote.md", { path: "Notes/NewRemote.md", sha: "sha_remote_1", size: 200 }],
    ]);

    const result = classifySyncState({ localFiles, remoteBlobs });

    expect(result.counts.REMOTE_ONLY).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      path: "Notes/NewRemote.md",
      category: "REMOTE_ONLY",
      remoteSha: "sha_remote_1",
    });
  });

  it("classifies UNCHANGED when local and remote hashes match", () => {
    const localFiles = new Map<string, LocalFileEntry>([
      ["Notes/Same.md", { path: "Notes/Same.md", sha: "sha_match_123", size: 150 }],
    ]);
    const remoteBlobs = new Map<string, RemoteBlobEntry>([
      ["Notes/Same.md", { path: "Notes/Same.md", sha: "sha_match_123", size: 150 }],
    ]);

    const result = classifySyncState({ localFiles, remoteBlobs });

    expect(result.counts.UNCHANGED).toBe(1);
    expect(result.items[0]).toMatchObject({
      path: "Notes/Same.md",
      category: "UNCHANGED",
      localSha: "sha_match_123",
      remoteSha: "sha_match_123",
    });
  });

  it("classifies LOCAL_CHANGED when local hash changed from state and remote is unchanged", () => {
    const localFiles = new Map<string, LocalFileEntry>([
      ["Notes/Doc.md", { path: "Notes/Doc.md", sha: "sha_local_v2", size: 160 }],
    ]);
    const remoteBlobs = new Map<string, RemoteBlobEntry>([
      ["Notes/Doc.md", { path: "Notes/Doc.md", sha: "sha_base_v1", size: 150 }],
    ]);
    const state: SyncStateData = {
      version: 1,
      files: {
        "Notes/Doc.md": {
          localSha: "sha_base_v1",
          remoteSha: "sha_base_v1",
          syncedAt: 1000,
        },
      },
    };

    const result = classifySyncState({ localFiles, remoteBlobs, state });

    expect(result.counts.LOCAL_CHANGED).toBe(1);
    expect(result.items[0]).toMatchObject({
      path: "Notes/Doc.md",
      category: "LOCAL_CHANGED",
      localSha: "sha_local_v2",
      remoteSha: "sha_base_v1",
    });
  });

  it("classifies REMOTE_CHANGED when remote hash changed from state and local is unchanged", () => {
    const localFiles = new Map<string, LocalFileEntry>([
      ["Notes/Doc.md", { path: "Notes/Doc.md", sha: "sha_base_v1", size: 150 }],
    ]);
    const remoteBlobs = new Map<string, RemoteBlobEntry>([
      ["Notes/Doc.md", { path: "Notes/Doc.md", sha: "sha_remote_v2", size: 180 }],
    ]);
    const state: SyncStateData = {
      version: 1,
      files: {
        "Notes/Doc.md": {
          localSha: "sha_base_v1",
          remoteSha: "sha_base_v1",
          syncedAt: 1000,
        },
      },
    };

    const result = classifySyncState({ localFiles, remoteBlobs, state });

    expect(result.counts.REMOTE_CHANGED).toBe(1);
    expect(result.items[0]).toMatchObject({
      path: "Notes/Doc.md",
      category: "REMOTE_CHANGED",
      localSha: "sha_base_v1",
      remoteSha: "sha_remote_v2",
    });
  });

  it("classifies POTENTIAL_CONFLICT when BOTH local and remote changed from state (changed-both => conflict)", () => {
    const localFiles = new Map<string, LocalFileEntry>([
      ["Notes/Conflict.md", { path: "Notes/Conflict.md", sha: "sha_local_v2", size: 210 }],
    ]);
    const remoteBlobs = new Map<string, RemoteBlobEntry>([
      ["Notes/Conflict.md", { path: "Notes/Conflict.md", sha: "sha_remote_v2", size: 220 }],
    ]);
    const state: SyncStateData = {
      version: 1,
      files: {
        "Notes/Conflict.md": {
          localSha: "sha_base_v1",
          remoteSha: "sha_base_v1",
          syncedAt: 1000,
        },
      },
    };

    const result = classifySyncState({ localFiles, remoteBlobs, state });

    expect(result.counts.POTENTIAL_CONFLICT).toBe(1);
    expect(result.items[0]).toMatchObject({
      path: "Notes/Conflict.md",
      category: "POTENTIAL_CONFLICT",
      localSha: "sha_local_v2",
      remoteSha: "sha_remote_v2",
    });
  });

  it("classifies POTENTIAL_CONFLICT when both exist with different hashes and NO sync state exists", () => {
    const localFiles = new Map<string, LocalFileEntry>([
      ["Notes/UnknownBase.md", { path: "Notes/UnknownBase.md", sha: "sha_local_diff", size: 300 }],
    ]);
    const remoteBlobs = new Map<string, RemoteBlobEntry>([
      ["Notes/UnknownBase.md", { path: "Notes/UnknownBase.md", sha: "sha_remote_diff", size: 350 }],
    ]);

    const result = classifySyncState({ localFiles, remoteBlobs });

    expect(result.counts.POTENTIAL_CONFLICT).toBe(1);
    expect(result.items[0]).toMatchObject({
      path: "Notes/UnknownBase.md",
      category: "POTENTIAL_CONFLICT",
    });
  });

  it("classifies reviewed split local/remote baselines as UNCHANGED", () => {
    const localFiles = new Map<string, LocalFileEntry>([
      ["Notes/KeepBoth.md", { path: "Notes/KeepBoth.md", sha: "sha_local", size: 10 }],
    ]);
    const remoteBlobs = new Map<string, RemoteBlobEntry>([
      ["Notes/KeepBoth.md", { path: "Notes/KeepBoth.md", sha: "sha_remote", size: 11 }],
    ]);
    const state: SyncStateData = {
      version: 1,
      files: {
        "Notes/KeepBoth.md": {
          localSha: "sha_local",
          remoteSha: "sha_remote",
          syncedAt: 1,
        },
      },
    };

    const result = classifySyncState({ localFiles, remoteBlobs, state });

    expect(result.counts.UNCHANGED).toBe(1);
    expect(result.counts.POTENTIAL_CONFLICT).toBe(0);
  });

  it("accurately aggregates counts across multiple files of different categories", () => {
    const localFiles = new Map<string, LocalFileEntry>([
      ["1_local_only.md", { path: "1_local_only.md", sha: "l1", size: 10 }],
      ["3_unchanged.md", { path: "3_unchanged.md", sha: "u1", size: 10 }],
      ["4_local_changed.md", { path: "4_local_changed.md", sha: "lc_new", size: 10 }],
      ["6_conflict.md", { path: "6_conflict.md", sha: "c_l", size: 10 }],
    ]);

    const remoteBlobs = new Map<string, RemoteBlobEntry>([
      ["2_remote_only.md", { path: "2_remote_only.md", sha: "r1", size: 10 }],
      ["3_unchanged.md", { path: "3_unchanged.md", sha: "u1", size: 10 }],
      ["4_local_changed.md", { path: "4_local_changed.md", sha: "base", size: 10 }],
      ["5_remote_changed.md", { path: "5_remote_changed.md", sha: "rc_new", size: 10 }],
      ["6_conflict.md", { path: "6_conflict.md", sha: "c_r", size: 10 }],
    ]);

    const state: SyncStateData = {
      version: 1,
      files: {
        "3_unchanged.md": { localSha: "u1", remoteSha: "u1", syncedAt: 1 },
        "4_local_changed.md": { localSha: "base", remoteSha: "base", syncedAt: 1 },
        "5_remote_changed.md": { localSha: "base", remoteSha: "base", syncedAt: 1 },
        "6_conflict.md": { localSha: "base", remoteSha: "base", syncedAt: 1 },
      },
    };

    // Add local entry for 5_remote_changed to simulate local having base content
    localFiles.set("5_remote_changed.md", { path: "5_remote_changed.md", sha: "base", size: 10 });

    const result = classifySyncState({ localFiles, remoteBlobs, state });

    expect(result.counts.LOCAL_ONLY).toBe(1);
    expect(result.counts.REMOTE_ONLY).toBe(1);
    expect(result.counts.UNCHANGED).toBe(1);
    expect(result.counts.LOCAL_CHANGED).toBe(1);
    expect(result.counts.REMOTE_CHANGED).toBe(1);
    expect(result.counts.POTENTIAL_CONFLICT).toBe(1);
    expect(result.items).toHaveLength(6);
  });
});
