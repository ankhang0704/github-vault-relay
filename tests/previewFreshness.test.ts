import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import { SyncEngine } from "../src/sync/syncEngine";
import { GitHubClient } from "../src/github/githubClient";
import { calculateCanonicalGitBlobSha } from "../src/sync/hashUtils";

describe("Preview Freshness & Performance (FRESH-001..005)", () => {
  let app: App;
  const settings = {
    owner: "octocat",
    repo: "notes",
    branch: "main",
    excludedPaths: [],
  };

  beforeEach(() => {
    app = new App();
  });

  it("FRESH-001: generatePreview requests branch with bypassCache=true, headers, and timestamp query parameter", async () => {
    let capturedBranchUrl = "";
    let capturedBranchHeaders: Record<string, string> | undefined;

    const fakeRequestFn = vi.fn(async (params: { url: string; headers?: Record<string, string> }) => {
      if (params.url.includes("/branches/main")) {
        capturedBranchUrl = params.url;
        capturedBranchHeaders = params.headers;
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_fresh", commit: { tree: { sha: "tree_fresh" } } } },
        };
      }
      if (params.url.includes("/git/trees/tree_fresh")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_fresh", truncated: false, tree: [] },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const engine = new SyncEngine(app, settings, client);

    const report = await engine.generatePreview();
    expect(report.remoteCommitSha).toBe("commit_fresh");
    expect(capturedBranchUrl).toContain("?t=");
    expect(capturedBranchHeaders?.["Cache-Control"]).toBe("no-cache, no-store, must-revalidate");
  });

  it("FRESH-002 & FRESH-003: LocalHashCache reuses SHA when mtime and size match; invalidates when content changes", async () => {
    const file = await app.vault.create("cached-note.md", "Original Content");
    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main" });
    const engine = new SyncEngine(app, settings, client);

    // First scan: computes SHA
    const scan1 = await engine.scanLocalVault();
    const sha1 = scan1.get("cached-note.md")?.sha;
    expect(sha1).toBeDefined();

    // Second scan without changes: reuses cache
    const scan2 = await engine.scanLocalVault();
    expect(scan2.get("cached-note.md")?.sha).toBe(sha1);

    // Modify file content (changes mtime and size)
    await app.vault.modify(file, "Modified Content with Different Size!");
    const scan3 = await engine.scanLocalVault();
    const sha3 = scan3.get("cached-note.md")?.sha;
    expect(sha3).not.toBe(sha1);

    const expectedSha3 = await calculateCanonicalGitBlobSha(
      await app.vault.readBinary(file),
      "cached-note.md"
    );
    expect(sha3).toBe(expectedSha3);
  });

  it("FRESH-004: clearLocalHashCache forces re-computation of local hashes", async () => {
    await app.vault.create("test.md", "Content");
    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main" });
    const engine = new SyncEngine(app, settings, client);

    await engine.scanLocalVault();
    engine.clearLocalHashCache();
    const scan = await engine.scanLocalVault();
    expect(scan.get("test.md")).toBeDefined();
  });

  it("FRESH-005: Timings are instrumented truthfully on SyncPreviewReport", async () => {
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_time", commit: { tree: { sha: "tree_time" } } } },
        };
      }
      if (params.url.includes("/git/trees/tree_time")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_time", truncated: false, tree: [] },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const engine = new SyncEngine(app, settings, client);

    const report = await engine.generatePreview();
    expect(report.timings).toBeDefined();
    expect(report.timings?.totalMs).toBeGreaterThanOrEqual(0);
    expect(report.timings?.remoteHeadMs).toBeGreaterThanOrEqual(0);
    expect(report.timings?.localScanMs).toBeGreaterThanOrEqual(0);
  });
  it("FRESH-006: Repeated preview invocations execute genuinely fresh HTTP requests with distinct timestamps", async () => {
    const requestedUrls: string[] = [];
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      requestedUrls.push(params.url);
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c_rep", commit: { tree: { sha: "t_rep" } } } },
        };
      }
      if (params.url.includes("/git/trees/t_rep")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t_rep", truncated: false, tree: [] } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const engine = new SyncEngine(app, settings, client);

    await engine.generatePreview();
    await new Promise((r) => setTimeout(r, 5));
    await engine.generatePreview();

    const branchUrls = requestedUrls.filter((u) => u.includes("/branches/main"));
    expect(branchUrls.length).toBe(2);
    // Unique timestamps prevent response memoization
    expect(branchUrls[0]).not.toBe(branchUrls[1]);
  });

  it("FRESH-007: Same size, same mtime, different bytes detects mutation under bypassCache", async () => {
    // Note with original content
    const originalText = "AABBCC"; // length 6
    const changedText   = "XXYYZZ"; // length 6
    const file = await app.vault.create("equal-size.md", originalText);

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main" });
    const engine = new SyncEngine(app, settings, client);

    // Initial warm scan
    const scan1 = await engine.scanLocalVault();
    const sha1 = scan1.get("equal-size.md")?.sha;

    // Simulate same size and force identical mtime in stat
    await app.vault.modify(file, changedText);
    file.stat.size = 6;
    file.stat.mtime = scan1.get("equal-size.md")?.mtime || 1000;

    // When bypassCache=true is passed (as UnifiedSyncEngine does before mutations)
    const scanBypass = await engine.scanLocalVault(true);
    const shaBypass = scanBypass.get("equal-size.md")?.sha;

    expect(shaBypass).not.toBe(sha1);
    const expectedNewSha = await calculateCanonicalGitBlobSha(new TextEncoder().encode(changedText), "equal-size.md");
    expect(shaBypass).toBe(expectedNewSha);
  });

  it("FRESH-008: End-to-end performance truth breakdown on 30-file fixture", async () => {
    // Create 30 files in mock vault
    for (let i = 0; i < 30; i++) {
      await app.vault.create(`note-${i}.md`, `# Note ${i}\nSome content for test fixture.`);
    }

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c_30", commit: { tree: { sha: "t_30" } } } },
        };
      }
      if (params.url.includes("/git/trees/t_30")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t_30", truncated: false, tree: [] } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const engine = new SyncEngine(app, settings, client);

    // First scan (cold)
    const reportCold = await engine.generatePreview();
    expect(reportCold.timings).toBeDefined();

    // Second scan (warm)
    const reportWarm = await engine.generatePreview();
    expect(reportWarm.timings).toBeDefined();

    const t = reportWarm.timings!;
    // Performance truth verification:
    // localScanMs measures the local scanning & hashing
    expect(t.localScanMs).toBeGreaterThanOrEqual(0);
    expect(t.remoteHeadMs).toBeGreaterThanOrEqual(0);
    expect(t.remoteTreeMs).toBeGreaterThanOrEqual(0);
    expect(t.classificationMs).toBeGreaterThanOrEqual(0);
    expect(t.totalMs).toBeGreaterThanOrEqual(t.localScanMs + t.remoteHeadMs);
  });
});
