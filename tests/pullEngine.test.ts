import { describe, it, expect, vi } from "vitest";
import { App, TFile } from "obsidian";
import { PullEngine } from "../src/sync/pullEngine";
import { GitHubClient } from "../src/github/githubClient";
import { VaultRelaySettings } from "../src/settings";
import { calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { RequestUrlParam, RequestUrlResponse } from "obsidian";

describe("Safe Pull Engine (src/sync/pullEngine.ts)", () => {
  const defaultSettings: VaultRelaySettings = {
    owner: "octocat",
    repo: "my-vault",
    branch: "main",
    excludedPaths: [".obsidian/", ".git/", "_fit/", "_vault-relay/"],
  };

  /**
   * Helper to construct a mock GitHubClient with a simulated branch, tree, and blobs.
   */
  function createMockGitHubClient(
    treeItems: Array<{ path: string; content: string | Uint8Array; sha?: string; size?: number; type?: "blob" | "tree" }>,
    options?: { truncated?: boolean; branchSha?: string; failBlobSha?: string }
  ) {
    const branchSha = options?.branchSha || "commit_head_1111111111111111111111111111111111111111";
    const treeSha = "tree_sha_2222222222222222222222222222222222222222";

    const blobMap = new Map<string, { bytes: Uint8Array; base64: string; size: number }>();
    const treeList: Array<{ path: string; mode: string; type: "blob" | "tree"; sha: string; size: number }> = [];

    for (const item of treeItems) {
      const type = item.type || "blob";
      let bytes: Uint8Array;
      if (typeof item.content === "string") {
        bytes = new TextEncoder().encode(item.content);
      } else {
        bytes = item.content;
      }

      // If SHA not provided, compute raw git blob sha synchronously/placeholder
      const computedSha = item.sha || `sha_for_${item.path.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const size = item.size ?? bytes.byteLength;

      // Base64 encoding
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      blobMap.set(computedSha, { bytes, base64, size });
      treeList.push({
        path: item.path,
        mode: "100644",
        type,
        sha: computedSha,
        size,
      });
    }

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
      const url = params.url;

      // Branch lookup
      if (url.includes("/branches/")) {
        return {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: {
              sha: branchSha,
              url: "https://api.github.com/commits/" + branchSha,
              commit: { tree: { sha: treeSha, url: "" } },
            },
          },
          text: "{}",
        };
      }

      // Tree lookup
      if (url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: treeSha,
            url: "",
            tree: treeList,
            truncated: !!options?.truncated,
          },
          text: "{}",
        };
      }

      // Blob lookup
      if (url.includes("/git/blobs/")) {
        const parts = url.split("/");
        const requestedSha = parts[parts.length - 1];

        if (options?.failBlobSha === requestedSha) {
          return {
            status: 404,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { message: "Blob not found" },
            text: '{"message":"Blob not found"}',
          };
        }

        const blob = blobMap.get(requestedSha);
        if (blob) {
          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {
              sha: requestedSha,
              size: blob.size,
              content: blob.base64,
              encoding: "base64",
              url: "",
            },
            text: "{}",
          };
        }

        return {
          status: 404,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "Blob not found" },
          text: "{}",
        };
      }

      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        text: "{}",
      };
    });

    return new GitHubClient({
      token: "github_pat_test",
      owner: "octocat",
      repo: "my-vault",
      branch: "main",
      requestFn: fakeRequestFn,
    });
  }

  it("C2-001: REMOTE_ONLY creates a local file safely in the vault", async () => {
    const app = new App();
    const noteText = "# Remote Note\n\nContent from GitHub\n";
    const noteBytes = new TextEncoder().encode(noteText);
    const noteSha = await calculateRawGitBlobSha(noteBytes);

    const client = createMockGitHubClient([{ path: "Notes/Welcome.md", content: noteBytes, sha: noteSha }]);
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.status).toBe("PASS");
    expect(report.counts.pulledCreated).toBe(1);

    const createdFile = app.vault.getAbstractFileByPath("Notes/Welcome.md");
    expect(createdFile).toBeInstanceOf(TFile);
    expect(await app.vault.read(createdFile as TFile)).toBe(noteText);

    // Verify baseline state was established
    const state = await engine.loadState();
    expect(state.files["Notes/Welcome.md"]).toBeDefined();
    expect(state.files["Notes/Welcome.md"].remoteSha).toBe(noteSha);
  });

  it("C2-002: REMOTE_CHANGED safely updates an existing local file when baseline matches", async () => {
    const app = new App();
    const oldText = "# Old Note\n";
    const newText = "# Updated Remote Note\n";

    const oldBytes = new TextEncoder().encode(oldText);
    const newBytes = new TextEncoder().encode(newText);

    const oldSha = await calculateRawGitBlobSha(oldBytes);
    const newSha = await calculateRawGitBlobSha(newBytes);

    // Create local file with old content
    await app.vault.create("Notes/Daily.md", oldText);

    // Seed state with old baseline
    const initialEngine = new PullEngine(app, defaultSettings, createMockGitHubClient([]));
    await initialEngine.saveState({
      version: 1,
      lastSyncedCommitSha: "old_commit_sha",
      files: {
        "Notes/Daily.md": { localSha: oldSha, remoteSha: oldSha, syncedAt: Date.now() - 1000 },
      },
    });

    // Remote has new content
    const client = createMockGitHubClient([{ path: "Notes/Daily.md", content: newBytes, sha: newSha }]);
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.status).toBe("PASS");
    expect(report.counts.pulledUpdated).toBe(1);

    const updatedFile = app.vault.getAbstractFileByPath("Notes/Daily.md") as TFile;
    expect(await app.vault.read(updatedFile)).toBe(newText);

    const state = await engine.loadState();
    expect(state.files["Notes/Daily.md"].remoteSha).toBe(newSha);
  });

  it("C2-003: LOCAL_CHANGED is never overwritten during safe pull", async () => {
    const app = new App();
    const baseText = "# Base Note\n";
    const localModifiedText = "# Local User Edits (Do Not Overwrite!)\n";

    const baseBytes = new TextEncoder().encode(baseText);
    const baseSha = await calculateRawGitBlobSha(baseBytes);

    await app.vault.create("Notes/MyDraft.md", localModifiedText);

    const initialEngine = new PullEngine(app, defaultSettings, createMockGitHubClient([]));
    await initialEngine.saveState({
      version: 1,
      files: {
        "Notes/MyDraft.md": { localSha: baseSha, remoteSha: baseSha, syncedAt: Date.now() - 1000 },
      },
    });

    // Remote is still baseSha
    const client = createMockGitHubClient([{ path: "Notes/MyDraft.md", content: baseBytes, sha: baseSha }]);
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.counts.skippedLocalChanged).toBe(1);
    expect(report.counts.pulledUpdated).toBe(0);

    const localFile = app.vault.getAbstractFileByPath("Notes/MyDraft.md") as TFile;
    expect(await app.vault.read(localFile)).toBe(localModifiedText);
  });

  it("C2-004 & C2-005: POTENTIAL_CONFLICT preserves local file untouched and saves remote copy in _vault-relay/conflicts/", async () => {
    const app = new App();
    const localText = "# Local Important Notes\n";
    const remoteText = "# Remote Conflicting Notes\n";

    const remoteBytes = new TextEncoder().encode(remoteText);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);

    await app.vault.create("Project/Plan.md", localText);

    const client = createMockGitHubClient([{ path: "Project/Plan.md", content: remoteBytes, sha: remoteSha }]);
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.status).toBe("PASS_WITH_WARNINGS");
    expect(report.counts.conflictsPreserved).toBe(1);

    // Verify local original was NOT overwritten
    const localFile = app.vault.getAbstractFileByPath("Project/Plan.md") as TFile;
    expect(await app.vault.read(localFile)).toBe(localText);

    // Verify conflict file was preserved under _vault-relay/conflicts/
    const conflictResult = report.results.find((r) => r.path === "Project/Plan.md");
    expect(conflictResult?.conflictPath).toBeDefined();
    expect(conflictResult?.conflictPath).toContain("vault-relay/conflicts/");

    const conflictFile = app.vault.getAbstractFileByPath(conflictResult!.conflictPath!) as TFile;
    expect(conflictFile).toBeInstanceOf(TFile);
    expect(await app.vault.read(conflictFile)).toBe(remoteText);
  });

  it("C2-006: EOL-only differences with no previous baseline establish safe baseline without conflict (REG-004)", async () => {
    const app = new App();
    const textLF = "# Title\n\nBody content\n";
    const textCRLF = "# Title\r\n\r\nBody content\r\n";

    // Local vault has CRLF on disk (e.g. Windows checkout)
    await app.vault.create("Notes/CrossPlatform.md", textCRLF);

    // Remote GitHub repo has LF
    const remoteBytes = new TextEncoder().encode(textLF);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);

    const client = createMockGitHubClient([{ path: "Notes/CrossPlatform.md", content: remoteBytes, sha: remoteSha }]);
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.counts.conflictsPreserved).toBe(0);
    expect(report.counts.unchanged).toBe(1);

    // Baseline is established
    const state = await engine.loadState();
    expect(state.files["Notes/CrossPlatform.md"]).toBeDefined();
    expect(state.files["Notes/CrossPlatform.md"].remoteSha).toBe(remoteSha);
  });

  it("C2-008: Local file edited in editor during pull planning -> abort overwrite and preserve conflict copy", async () => {
    const app = new App();
    const plannedText = "# Planned Content\n";
    const editedText = "# Concurrently Edited by User in Editor\n";
    const remoteText = "# New Remote Content\n";

    const plannedBytes = new TextEncoder().encode(plannedText);
    const plannedSha = await calculateRawGitBlobSha(plannedBytes);

    const remoteBytes = new TextEncoder().encode(remoteText);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);

    await app.vault.create("Notes/Concurrency.md", plannedText);

    // Setup initial baseline
    const initialEngine = new PullEngine(app, defaultSettings, createMockGitHubClient([]));
    await initialEngine.saveState({
      version: 1,
      files: {
        "Notes/Concurrency.md": { localSha: plannedSha, remoteSha: "old_remote_sha", syncedAt: Date.now() - 500 },
      },
    });

    const client = createMockGitHubClient([{ path: "Notes/Concurrency.md", content: remoteBytes, sha: remoteSha }]);
    const engine = new PullEngine(app, defaultSettings, client);

    // Spy on scanLocalVault to simulate user editing the note right after scan
    const originalScan = engine.scanLocalVault.bind(engine);
    engine.scanLocalVault = async () => {
      const map = await originalScan();
      // Right after scan, user modifies file on disk
      const f = app.vault.getAbstractFileByPath("Notes/Concurrency.md") as TFile;
      await app.vault.modify(f, editedText);
      return map;
    };

    const report = await engine.executeSafePull();

    expect(report.counts.conflictsPreserved).toBe(1);
    expect(report.counts.pulledUpdated).toBe(0);

    // Local user edits preserved
    const currentFile = app.vault.getAbstractFileByPath("Notes/Concurrency.md") as TFile;
    expect(await app.vault.read(currentFile)).toBe(editedText);
  });

  it("C2-009: Truncated remote tree completely aborts safe pull with zero writes", async () => {
    const app = new App();
    const client = createMockGitHubClient(
      [{ path: "Notes/Note1.md", content: "data", sha: "sha1" }],
      { truncated: true }
    );
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.status).toBe("ABORTED");
    expect(report.counts.pulledCreated).toBe(0);
    expect(app.vault.getFiles().length).toBe(0);
  });

  it("C2-010 & C2-011: Unsafe traversal paths and reserved prefixes are safely rejected", async () => {
    const app = new App();
    const validContent = "# Valid\n";
    const validBytes = new TextEncoder().encode(validContent);
    const validSha = await calculateRawGitBlobSha(validBytes);

    const client = createMockGitHubClient([
      { path: "../escaped.md", content: "evil", sha: "sha_evil" },
      { path: ".obsidian/plugins/evil.js", content: "evil", sha: "sha_plugin" },
      { path: "_fit/state.json", content: "evil", sha: "sha_state" },
      { path: "Valid/Note.md", content: validBytes, sha: validSha },
    ]);
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.counts.skippedUnsafe).toBe(1); // ../escaped.md
    expect(report.counts.pulledCreated).toBe(1); // Valid/Note.md

    expect(app.vault.getAbstractFileByPath("../escaped.md")).toBeNull();
    expect(app.vault.getAbstractFileByPath(".obsidian/plugins/evil.js")).toBeNull();
    expect(app.vault.getAbstractFileByPath("Valid/Note.md")).toBeInstanceOf(TFile);
  });

  it("C2-012: Binary attachments (PNG/PDF) are pulled 100% byte-exact (REG-006)", async () => {
    const app = new App();
    const binaryBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    const binarySha = await calculateRawGitBlobSha(binaryBytes);

    const client = createMockGitHubClient([{ path: "Images/diagram.png", content: binaryBytes, sha: binarySha }]);
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.status).toBe("PASS");
    expect(report.counts.pulledCreated).toBe(1);

    const created = app.vault.getAbstractFileByPath("Images/diagram.png") as TFile;
    const readBack = await app.vault.readBinary(created);
    expect(new Uint8Array(readBack)).toEqual(binaryBytes);
  });

  it("C2-013: Oversized remote files (>25 MiB) are skipped without failing safe files (REG-003)", async () => {
    const app = new App();
    const oversizedSizeBytes = 26 * 1024 * 1024; // 26 MiB

    const safeText = "# Safe Note\n";
    const safeBytes = new TextEncoder().encode(safeText);
    const safeSha = await calculateRawGitBlobSha(safeBytes);

    const client = createMockGitHubClient([
      { path: "Videos/large.mp4", content: new Uint8Array(0), size: oversizedSizeBytes, sha: "sha_oversized" },
      { path: "Notes/Safe.md", content: safeBytes, sha: safeSha },
    ]);
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.status).toBe("PASS_WITH_WARNINGS");
    expect(report.counts.skippedOversized).toBe(1);
    expect(report.counts.pulledCreated).toBe(1);

    expect(app.vault.getAbstractFileByPath("Notes/Safe.md")).toBeInstanceOf(TFile);
    expect(app.vault.getAbstractFileByPath("Videos/large.mp4")).toBeNull();
  });

  it("C2-015: Preserving conflict copy never overwrites an existing conflict file", async () => {
    const app = new App();
    const localText = "# Local\n";
    const remoteText1 = "# Remote 1\n";
    const remoteText2 = "# Remote 2\n";

    await app.vault.create("Notes/Conflict.md", localText);

    const remoteSha1 = await calculateRawGitBlobSha(new TextEncoder().encode(remoteText1));
    const remoteSha2 = await calculateRawGitBlobSha(new TextEncoder().encode(remoteText2));

    const client1 = createMockGitHubClient([{ path: "Notes/Conflict.md", content: remoteText1, sha: remoteSha1 }]);
    const engine1 = new PullEngine(app, defaultSettings, client1);
    const report1 = await engine1.executeSafePull();

    const client2 = createMockGitHubClient([{ path: "Notes/Conflict.md", content: remoteText2, sha: remoteSha2 }]);
    const engine2 = new PullEngine(app, defaultSettings, client2);
    const report2 = await engine2.executeSafePull();

    const conflict1Path = report1.results[0].conflictPath!;
    const conflict2Path = report2.results[0].conflictPath!;

    expect(conflict1Path).not.toBe(conflict2Path);
    expect(app.vault.getAbstractFileByPath(conflict1Path)).toBeInstanceOf(TFile);
    expect(app.vault.getAbstractFileByPath(conflict2Path)).toBeInstanceOf(TFile);
  });

  it("C2-014 & REG-009: Failed blob download does not advance baseline state for that file", async () => {
    const app = new App();
    const safeContent = "# Safe\n";
    const safeBytes = new TextEncoder().encode(safeContent);
    const safeSha = await calculateRawGitBlobSha(safeBytes);

    const failingSha = "sha_failing_blob_123456789012345678901234";

    const client = createMockGitHubClient(
      [
        { path: "Notes/Safe.md", content: safeBytes, sha: safeSha },
        { path: "Notes/Failing.md", content: "data", sha: failingSha },
      ],
      { failBlobSha: failingSha }
    );
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.status).toBe("FAIL");
    expect(report.counts.pulledCreated).toBe(1); // Notes/Safe.md succeeded
    expect(report.counts.failed).toBe(1); // Notes/Failing.md failed

    const state = await engine.loadState();
    expect(state.files["Notes/Safe.md"]).toBeDefined();
    expect(state.files["Notes/Failing.md"]).toBeUndefined(); // State was NOT advanced for failed file
  });

  it("REG-001: executeSafePull fetches fresh branch HEAD and uses it for state persistence", async () => {
    const app = new App();
    const freshBranchSha = "fresh_head_commit_abcdef1234567890abcdef1234";
    const content = "# Fresh Note\n";
    const bytes = new TextEncoder().encode(content);
    const sha = await calculateRawGitBlobSha(bytes);

    const client = createMockGitHubClient(
      [{ path: "Notes/Fresh.md", content: bytes, sha }],
      { branchSha: freshBranchSha }
    );
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();
    expect(report.remoteCommitSha).toBe(freshBranchSha);

    const state = await engine.loadState();
    expect(state.lastSyncedCommitSha).toBe(freshBranchSha);
  });

  it("REG-002: First sync when both local and remote have files handles identical and differing notes safely", async () => {
    const app = new App();
    const sameText = "# Identical Text\n";
    const diffLocal = "# Local Unique Content\n";
    const diffRemote = "# Remote Divergent Content\n";

    const sameBytes = new TextEncoder().encode(sameText);
    const sameSha = await calculateRawGitBlobSha(sameBytes);

    const diffRemoteBytes = new TextEncoder().encode(diffRemote);
    const diffRemoteSha = await calculateRawGitBlobSha(diffRemoteBytes);

    // Local vault has 2 notes
    await app.vault.create("Notes/Same.md", sameText);
    await app.vault.create("Notes/Diff.md", diffLocal);

    // Remote repo has 2 notes
    const client = createMockGitHubClient([
      { path: "Notes/Same.md", content: sameBytes, sha: sameSha },
      { path: "Notes/Diff.md", content: diffRemoteBytes, sha: diffRemoteSha },
    ]);
    const engine = new PullEngine(app, defaultSettings, client);

    const report = await engine.executeSafePull();

    expect(report.counts.unchanged).toBe(1); // Same.md established baseline
    expect(report.counts.conflictsPreserved).toBe(1); // Diff.md preserved local and created conflict copy

    // Local files remain untouched
    const diffFile = app.vault.getAbstractFileByPath("Notes/Diff.md") as TFile;
    expect(await app.vault.read(diffFile)).toBe(diffLocal);

    // State tracks Same.md but does not establish false baseline for Diff.md
    const state = await engine.loadState();
    expect(state.files["Notes/Same.md"]).toBeDefined();
    expect(state.files["Notes/Diff.md"]).toBeUndefined();
  });
});
