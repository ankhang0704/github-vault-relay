/**
 * Conflict Resolution Reentrancy & UX Lifecycle Tests (W5-UX-001..010)
 *
 * Verifies:
 * - Engine-level in-flight guard prevents duplicate mutations under spam/concurrent clicks
 * - UI lock immediately disables all 3 action buttons on click
 * - Modal automatically closes when the last conflict is resolved
 * - Modal removes resolved card and stays open when remaining conflicts exist
 * - Failure preserves conflict and handles stale state safely
 * - Use Remote spam produces single local overwrite
 * - Keep Both spam produces single conflict copy file
 * - Parent Dashboard metrics refresh immediately upon resolution
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, TFile } from "obsidian";
import { ConflictManager, ConflictRecord } from "../src/sync/conflictManager";
import { ConflictResolutionModal } from "../src/ui/conflictResolutionModal";
import { GitHubClient, GitHubError } from "../src/github/githubClient";
import VaultRelayPlugin from "../src/main";
import { calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { MockElement } from "./__mocks__/obsidian";

describe("C4 W5 Conflict Resolution Reentrancy & Lifecycle (W5-UX-001..010)", () => {
  let app: App;
  let plugin: VaultRelayPlugin;
  const settings = {
    owner: "octocat",
    repo: "notes",
    branch: "main",
    excludedPaths: [".obsidian/", ".git/", "_fit/"],
  };

  beforeEach(() => {
    app = new App();
    plugin = new VaultRelayPlugin(app, {
      id: "github-vault-relay",
      name: "GitHub Vault Relay",
      version: "0.3.0",
      minAppVersion: "1.0.0",
      author: "Test",
      description: "Test",
    });
    plugin.settings = { ...settings };
  });

  function setupKeepLocalMockClient(
    localSha: string,
    path = "Note.md",
    remoteShaOrMap: string | Record<string, string> = "old_remote_sha"
  ) {
    let patchCount = 0;
    let commitCount = 0;
    let createdTreeItems: Array<{ path: string; mode?: string; sha: string }> = [];

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string; body?: unknown }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: "main",
            commit: { sha: "commit_base", commit: { tree: { sha: "tree_base" } } },
          },
        };
      }
      if (params.url.includes("/git/trees/commit_new")) {
        const treeList =
          createdTreeItems.length > 0
            ? createdTreeItems.map((item) => ({
                path: item.path,
                mode: item.mode || "100644",
                type: "blob",
                sha: item.sha,
                size: 20,
              }))
            : [{ path, mode: "100644", type: "blob", sha: localSha, size: 20 }];
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new",
            truncated: false,
            tree: treeList,
          },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        try {
          const parsed = typeof params.body === "string" ? JSON.parse(params.body) : params.body;
          if (parsed && Array.isArray((parsed as { tree?: Array<{ path: string; mode?: string; sha: string }> }).tree)) {
            createdTreeItems = (parsed as { tree: Array<{ path: string; mode?: string; sha: string }> }).tree;
          }
        } catch {
          // ignore
        }
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_new" } };
      }
      if (params.url.includes("/git/trees/")) {
        const treeList =
          typeof remoteShaOrMap === "string"
            ? [{ path, mode: "100644", type: "blob", sha: remoteShaOrMap, size: 20 }]
            : Object.entries(remoteShaOrMap).map(([p, s]) => ({ path: p, mode: "100644", type: "blob", sha: s, size: 20 }));
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "tree_base", truncated: false, tree: treeList } };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        let sha = localSha;
        try {
          const parsed = typeof params.body === "string" ? JSON.parse(params.body) : params.body;
          if ((parsed as { content?: string })?.content) {
            const raw = Buffer.from((parsed as { content: string }).content, "base64");
            sha = await calculateRawGitBlobSha(raw);
          }
        } catch {
          // ignore
        }
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha } };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        commitCount++;
        return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "commit_new" } };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        patchCount++;
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new" } } };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { ref: "refs/heads/main", object: { sha: "commit_new" } } };
      }
      throw new Error("Unhandled URL: " + params.url);
    });

    const client = new GitHubClient({
      token: "tok",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: fakeRequestFn,
    });

    return { client, getCounts: () => ({ patchCount, commitCount }) };
  }

  // W5-UX-001: double-click Keep Local -> only one resolution call
  it("W5-UX-001: double-click Keep Local -> only one resolution call", async () => {
    const fileContent = "# Conflict Note Content\n";
    await app.vault.create("Note.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    const { client, getCounts } = setupKeepLocalMockClient(localSha);
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c1",
      path: "Note.md",
      localSha,
      remoteSha: "old_remote_sha",
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    // Fire two concurrent calls
    const [res1, res2] = await Promise.all([
      manager.resolveKeepLocal(record),
      manager.resolveKeepLocal(record),
    ]);

    // One succeeds, one is rejected by in-flight guard
    const successes = [res1, res2].filter((r) => r.success);
    const rejections = [res1, res2].filter((r) => !r.success);

    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(1);
    expect(rejections[0].message).toMatch(/already in progress|already been resolved/i);
    expect(getCounts().commitCount).toBe(1);
    expect(getCounts().patchCount).toBe(1);
  });

  // W5-UX-002: 10 rapid Keep Local clicks -> only one remote mutation / one commit
  it("W5-UX-002: 10 rapid Keep Local clicks -> only one remote mutation / one commit", async () => {
    const fileContent = "# Ten Rapid Clicks\n";
    await app.vault.create("Note.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    const { client, getCounts } = setupKeepLocalMockClient(localSha, "Note.md", "remote_sha");
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c2",
      path: "Note.md",
      localSha,
      remoteSha: "remote_sha",
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    // Launch 10 concurrent requests
    const promises = Array.from({ length: 10 }, () => manager.resolveKeepLocal(record));
    const results = await Promise.all(promises);

    const successful = results.filter((r) => r.success);
    expect(successful.length).toBe(1);
    expect(getCounts().commitCount).toBe(1);
    expect(getCounts().patchCount).toBe(1);
  });

  // W5-UX-003: buttons disabled immediately while resolving
  it("W5-UX-003: buttons disabled immediately while resolving", async () => {
    const fileContent = "# UI Lock Test\n";
    await app.vault.create("Note.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    let resolvePromise: (val: unknown) => void;
    const slowPushPromise = new Promise((r) => {
      resolvePromise = r;
    });

    const { client } = setupKeepLocalMockClient(localSha);
    // Wrap client to make it wait until we release it
    const originalGetBranch = client.getBranch.bind(client);
    client.getBranch = vi.fn(async (branch, fresh) => {
      await slowPushPromise;
      return originalGetBranch(branch, fresh);
    });

    const manager = new ConflictManager(app, settings, client);
    const record: ConflictRecord = {
      id: "c3",
      path: "Note.md",
      localSha,
      remoteSha: "remote_sha",
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const modal = new ConflictResolutionModal(app, plugin);
    // Inject our mock manager
    (modal as unknown as { conflictManager: ConflictManager }).conflictManager = manager;
    await modal.onOpen();

    // Find action buttons in modal
    const buttons = (modal.contentEl as unknown as MockElement).findAll((el: MockElement) => el.tag === "button");

    const keepLocalBtn = buttons.find((b: MockElement) => b.textContent.includes("Keep Local"));
    const useRemoteBtn = buttons.find((b: MockElement) => b.textContent.includes("Use Remote"));
    const keepBothBtn = buttons.find((b: MockElement) => b.textContent.includes("Keep Both"));

    expect(keepLocalBtn).toBeDefined();
    expect(useRemoteBtn).toBeDefined();
    expect(keepBothBtn).toBeDefined();

    expect(keepLocalBtn!.disabled).toBe(false);
    expect(useRemoteBtn!.disabled).toBe(false);
    expect(keepBothBtn!.disabled).toBe(false);

    // Trigger Keep Local
    const clickAction = keepLocalBtn!.onclick!();

    // Verify immediately locked
    expect(keepLocalBtn!.disabled).toBe(true);
    expect(useRemoteBtn!.disabled).toBe(true);
    expect(keepBothBtn!.disabled).toBe(true);
    expect(modal.isResolving("Note.md")).toBe(true);

    // Release push
    resolvePromise!(null);
    await clickAction;
  });

  // W5-UX-004: successful final conflict -> modal closes automatically
  it("W5-UX-004: successful final conflict -> modal closes automatically", async () => {
    const fileContent = "# Single Conflict\n";
    await app.vault.create("Note.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    const { client } = setupKeepLocalMockClient(localSha, "Note.md", "remote_sha");
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c4",
      path: "Note.md",
      localSha,
      remoteSha: "remote_sha",
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const modal = new ConflictResolutionModal(app, plugin);
    (modal as unknown as { conflictManager: ConflictManager }).conflictManager = manager;
    await modal.open();
    expect(modal.isOpen).toBe(true);

    const buttons = (modal.contentEl as unknown as MockElement).findAll((el: MockElement) => el.tag === "button");
    const keepLocalBtn = buttons.find((b: MockElement) => b.textContent.includes("Keep Local"));
    await keepLocalBtn!.onclick!();

    // Verified: modal closed automatically
    expect(modal.isOpen).toBe(false);
  });

  // W5-UX-005: successful resolution with remaining conflicts -> resolved card removed, modal stays open
  it("W5-UX-005: successful resolution with remaining conflicts -> resolved card removed, modal stays open", async () => {
    await app.vault.create("Note1.md", "# Note 1\n");
    await app.vault.create("Note2.md", "# Note 2\n");
    const localSha1 = await calculateRawGitBlobSha(new TextEncoder().encode("# Note 1\n"));
    const localSha2 = await calculateRawGitBlobSha(new TextEncoder().encode("# Note 2\n"));

    const { client } = setupKeepLocalMockClient(localSha1, "Note1.md", { "Note1.md": "remote1", "Note2.md": "remote2" });
    const manager = new ConflictManager(app, settings, client);

    const record1: ConflictRecord = {
      id: "c5_1",
      path: "Note1.md",
      localSha: localSha1,
      remoteSha: "remote1",
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    const record2: ConflictRecord = {
      id: "c5_2",
      path: "Note2.md",
      localSha: localSha2,
      remoteSha: "remote2",
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record1, record2]);

    const modal = new ConflictResolutionModal(app, plugin);
    (modal as unknown as { conflictManager: ConflictManager }).conflictManager = manager;
    await modal.open();
    expect(modal.isOpen).toBe(true);

    // Resolve Note1.md
    const allButtons = (modal.contentEl as unknown as MockElement).findAll((el: MockElement) => el.tag === "button");
    const keepLocalBtn = allButtons.find((b: MockElement) => b.textContent.includes("Keep Local"));
    await keepLocalBtn!.onclick!();

    // Modal remains open because Note2.md remains
    expect(modal.isOpen).toBe(true);

    // Remaining conflicts count is 1
    const remaining = (modal as unknown as { conflicts: ConflictRecord[] }).conflicts;
    expect(remaining.length).toBe(1);
    expect(remaining[0].path).toBe("Note2.md");
  });

  // W5-UX-006: failure does not close modal or lose conflict
  it("W5-UX-006: failure does not close modal or lose conflict", async () => {
    await app.vault.create("Note.md", "# Text");

    const failingClient = new GitHubClient({
      token: "tok",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: vi.fn(async () => {
        throw new GitHubError("Network offline", 400);
      }),
    });

    const manager = new ConflictManager(app, settings, failingClient);
    const record: ConflictRecord = {
      id: "c6",
      path: "Note.md",
      localSha: "sha_l",
      remoteSha: "sha_r",
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const modal = new ConflictResolutionModal(app, plugin);
    (modal as unknown as { conflictManager: ConflictManager }).conflictManager = manager;
    await modal.open();

    const keepLocalBtn = (modal.contentEl as unknown as MockElement)
      .findAll((b: MockElement) => b.tag === "button" && b.textContent.includes("Keep Local"))[0];

    await keepLocalBtn!.onclick!();

    // Modal stays open
    expect(modal.isOpen).toBe(true);

    // Conflict was not lost
    const stored = await manager.loadConflictRecords();
    expect(stored.length).toBe(1);
    expect(stored[0].path).toBe("Note.md");
  });

  // W5-UX-007: stale remote after review -> old actions remain blocked until refresh
  it("W5-UX-007: stale remote after review -> old actions remain blocked until refresh", async () => {
    await app.vault.create("Note.md", "# Stale Test");

    const client = new GitHubClient({
      token: "tok",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: vi.fn(async (params: { url: string }) => {
        if (params.url.includes("/branches/main")) {
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_has_advanced_ahead" } },
          };
        }
        throw new Error("Unexpected");
      }),
    });

    const manager = new ConflictManager(app, settings, client);
    const record: ConflictRecord = {
      id: "c7",
      path: "Note.md",
      localSha: "sha_local",
      remoteSha: "sha_remote",
      remoteCommitSha: "commit_old_reviewed",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    const modal = new ConflictResolutionModal(app, plugin);
    (modal as unknown as { conflictManager: ConflictManager }).conflictManager = manager;
    await modal.open();

    const buttons = (modal.contentEl as unknown as MockElement).findAll((el: MockElement) => el.tag === "button");
    const keepLocalBtn = buttons.find((b: MockElement) => b.textContent.includes("Keep Local"));
    await keepLocalBtn!.onclick!();

    // Stale failure occurred
    expect(modal.isOpen).toBe(true);

    // Old buttons remain disabled
    expect(keepLocalBtn!.disabled).toBe(true);

    // Refresh button is rendered
    const refreshBtn = (modal.contentEl as unknown as MockElement)
      .findAll((b: MockElement) => b.tag === "button" && b.textContent.includes("Refresh Conflicts"))[0];

    expect(refreshBtn).toBeDefined();
  });

  // W5-UX-008: Use Remote spam -> one local overwrite only
  it("W5-UX-008: Use Remote spam -> one local overwrite only", async () => {
    const originalLocal = "local content";
    await app.vault.create("Note.md", originalLocal);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(originalLocal));

    const remoteContent = "remote authoritative content";
    const remoteSha = await calculateRawGitBlobSha(new TextEncoder().encode(remoteContent));

    let fetchCount = 0;
    const client = new GitHubClient({
      token: "tok",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: vi.fn(async (params: { url: string }) => {
        if (params.url.includes("/branches/main")) {
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_base" } },
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: {
              sha: "tree_base",
              truncated: false,
              tree: [{ path: "Note.md", mode: "100644", type: "blob", sha: remoteSha }],
            },
          };
        }
        if (params.url.includes("/git/blobs/" + remoteSha)) {
          fetchCount++;
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: {
              sha: remoteSha,
              content: Buffer.from(remoteContent).toString("base64"),
              encoding: "base64",
              size: remoteContent.length,
            },
          };
        }
        throw new Error("Unhandled: " + params.url);
      }),
    });

    const manager = new ConflictManager(app, settings, client);
    const record: ConflictRecord = {
      id: "c8",
      path: "Note.md",
      localSha,
      remoteSha,
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    // Launch 10 rapid concurrent Use Remote requests
    const results = await Promise.all(
      Array.from({ length: 10 }, () => manager.resolveUseRemote(record))
    );

    const successful = results.filter((r) => r.success);
    expect(successful.length).toBe(1);
    expect(fetchCount).toBe(1);

    // Local content updated exactly once
    const file = app.vault.getAbstractFileByPath("Note.md");
    expect(file).toBeInstanceOf(TFile);
    const updated = await app.vault.read(file as TFile);
    expect(updated).toBe(remoteContent);
  });

  // W5-UX-009: Keep Both spam -> one conflict-copy file only
  it("W5-UX-009: Keep Both spam -> one conflict-copy file only", async () => {
    const localContent = "local untouched";
    await app.vault.create("Note.md", localContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(localContent));

    const remoteContent = "remote copy";
    const remoteSha = await calculateRawGitBlobSha(new TextEncoder().encode(remoteContent));

    let blobFetchCount = 0;
    const client = new GitHubClient({
      token: "tok",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: vi.fn(async (params: { url: string }) => {
        if (params.url.includes("/branches/main")) {
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "commit_base" } },
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: {
              sha: "tree_base",
              truncated: false,
              tree: [{ path: "Note.md", mode: "100644", type: "blob", sha: remoteSha }],
            },
          };
        }
        if (params.url.includes("/git/blobs/" + remoteSha)) {
          blobFetchCount++;
          return {
            status: 200,
            headers: {},
            text: "",
            arrayBuffer: new ArrayBuffer(0),
            json: {
              sha: remoteSha,
              content: Buffer.from(remoteContent).toString("base64"),
              encoding: "base64",
              size: remoteContent.length,
            },
          };
        }
        throw new Error("Unhandled: " + params.url);
      }),
    });

    const manager = new ConflictManager(app, settings, client);
    const record: ConflictRecord = {
      id: "c9",
      path: "Note.md",
      localSha,
      remoteSha,
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    // 10 concurrent clicks on Keep Both
    const results = await Promise.all(
      Array.from({ length: 10 }, () => manager.resolveKeepBoth(record))
    );

    const successful = results.filter((r) => r.success);
    expect(successful.length).toBe(1);
    expect(blobFetchCount).toBe(1);

    // Verify all vault files: only Note.md and exactly ONE conflict copy
    const files = app.vault.getFiles();
    expect(files.length).toBe(2);
    expect(files.some((f) => f.path === "Note.md")).toBe(true);
    expect(files.some((f) => f.path.includes("remote conflict"))).toBe(true);
  });

  // W5-UX-010: Dashboard conflict count refreshes immediately after success
  it("W5-UX-010: Dashboard conflict count refreshes immediately after success", async () => {
    const fileContent = "# Dashboard Callback\n";
    await app.vault.create("Note.md", fileContent);
    const localSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));

    const { client } = setupKeepLocalMockClient(localSha, "Note.md", "remote");
    const manager = new ConflictManager(app, settings, client);

    const record: ConflictRecord = {
      id: "c10",
      path: "Note.md",
      localSha,
      remoteSha: "remote",
      remoteCommitSha: "commit_base",
      detectedAt: Date.now(),
    };
    await manager.saveConflictRecords([record]);

    let callbackTriggered = false;
    const modal = new ConflictResolutionModal(app, plugin, () => {
      callbackTriggered = true;
    });
    (modal as unknown as { conflictManager: ConflictManager }).conflictManager = manager;
    await modal.open();

    const keepLocalBtn = (modal.contentEl as unknown as MockElement)
      .findAll((b: MockElement) => b.tag === "button" && b.textContent.includes("Keep Local"))[0];

    await keepLocalBtn!.onclick!();

    expect(callbackTriggered).toBe(true);
  });
});
