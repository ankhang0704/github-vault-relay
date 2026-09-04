import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, RequestUrlParam, RequestUrlResponse, TFile } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { classifySyncState } from "../src/sync/syncClassifier";
import { PushEngine } from "../src/sync/pushEngine";
import { PullEngine } from "../src/sync/pullEngine";
import { GitHubClient } from "../src/github/githubClient";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { DEFAULT_SETTINGS, VaultRelaySettings } from "../src/settings";

describe("Removal of C4 Attachment Importer & Core Binary Sync Preservation (REMOVE-001..005)", () => {
  const testSettings: VaultRelaySettings = {
    ...DEFAULT_SETTINGS,
    owner: "testowner",
    repo: "testrepo",
    branch: "main",
    excludedPaths: [".obsidian/", ".git/"],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // REMOVE-001: No Import Attachment UI/action remains
  it("REMOVE-001: No Import Attachment UI, command, or action remains in production source", () => {
    const mainTs = fs.readFileSync(path.resolve(__dirname, "../src/main.ts"), "utf-8");
    expect(mainTs).not.toContain("github-vault-relay-import-attachment");
    expect(mainTs).not.toContain("Import attachment");
    expect(mainTs).not.toContain("AttachmentImporter");

    const dashboardTs = fs.readFileSync(path.resolve(__dirname, "../src/ui/syncDashboardModal.ts"), "utf-8");
    expect(dashboardTs).not.toContain("Import Attachment");
    expect(dashboardTs).not.toContain("AttachmentImporter");

    // Scan all UI files
    const uiDir = path.resolve(__dirname, "../src/ui");
    const uiFiles = fs.readdirSync(uiDir).filter((f) => f.endsWith(".ts"));
    for (const f of uiFiles) {
      const content = fs.readFileSync(path.join(uiDir, f), "utf-8");
      expect(content).not.toContain("AttachmentImporter");
      expect(content).not.toContain("Import Attachment");
    }
  });

  // REMOVE-002: No attachment-import production module remains
  it("REMOVE-002: No attachment-import production module remains on disk", () => {
    const importerPath = path.resolve(__dirname, "../src/sync/attachmentImporter.ts");
    expect(fs.existsSync(importerPath)).toBe(false);

    const oldTestPath = path.resolve(__dirname, "attachmentImport.test.ts");
    expect(fs.existsSync(oldTestPath)).toBe(false);
  });

  // REMOVE-003: Existing binary file in vault still classifies correctly
  it("REMOVE-003: Existing binary file in vault still classifies correctly", async () => {
    const binaryBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    const expectedSha = await calculateCanonicalGitBlobSha(binaryBytes.buffer as ArrayBuffer, "images/sample.png");

    // 1. When binary file exists locally only
    const resultLocalOnly = classifySyncState({
      localFiles: new Map([
        ["images/sample.png", { path: "images/sample.png", sha: expectedSha, size: binaryBytes.byteLength }],
      ]),
      remoteBlobs: new Map(),
    });
    expect(resultLocalOnly.counts.LOCAL_ONLY).toBe(1);
    expect(resultLocalOnly.items[0].category).toBe("LOCAL_ONLY");
    expect(resultLocalOnly.items[0].path).toBe("images/sample.png");

    // 2. When binary file matches remote SHA exactly
    const resultUnchanged = classifySyncState({
      localFiles: new Map([
        ["images/sample.png", { path: "images/sample.png", sha: expectedSha, size: binaryBytes.byteLength }],
      ]),
      remoteBlobs: new Map([
        ["images/sample.png", { path: "images/sample.png", sha: expectedSha, size: binaryBytes.byteLength, type: "blob", mode: "100644" }],
      ]),
    });
    expect(resultUnchanged.counts.UNCHANGED).toBe(1);
    expect(resultUnchanged.items[0].category).toBe("UNCHANGED");

    // 3. When binary file differs from remote SHA
    const resultChanged = classifySyncState({
      localFiles: new Map([
        ["images/sample.png", { path: "images/sample.png", sha: expectedSha, size: binaryBytes.byteLength }],
      ]),
      remoteBlobs: new Map([
        ["images/sample.png", { path: "images/sample.png", sha: "diff_remote_sha", size: 999, type: "blob", mode: "100644" }],
      ]),
    });
    expect(resultChanged.items[0].category).not.toBe("UNCHANGED");
  });

  // REMOVE-004: Existing binary file still Safe/Unified Pushes correctly
  it("REMOVE-004: Existing binary file still Safe/Unified Pushes correctly", async () => {
    const app = new App();
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x55, 0xaa]);
    const expectedRawSha = await calculateRawGitBlobSha(pngBytes);
    await app.vault.createBinary("assets/logo.png", pngBytes.buffer as ArrayBuffer);

    let createdBlobBase64 = "";
    let currentBranchSha = "commit_base_png";
    const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
      const url = params.url;

      if (url.includes("/branches/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: currentBranchSha } },
        };
      }
      if (url.includes("/git/refs/heads/main") && params.method === "GET") {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", url: "", object: { sha: currentBranchSha, type: "commit" } },
        };
      }
      if (url.includes("/git/trees/commit_base_png")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_base_png", truncated: false, tree: [] },
        };
      }
      if (url.includes("/git/blobs") && params.method === "POST") {
        const body = JSON.parse(params.body as string);
        createdBlobBase64 = body.content;
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: expectedRawSha, url: `https://api.github.com/git/blobs/${expectedRawSha}` },
        };
      }
      if (url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "tree_new_png", url: "", tree: [] },
        };
      }
      if (url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "commit_new_png", url: "", message: "Push binary", parents: [{ sha: "commit_base_png" }] },
        };
      }
      if (url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        currentBranchSha = "commit_new_png";
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", url: "", object: { sha: "commit_new_png", type: "commit" } },
        };
      }
      if (url.includes("/git/trees/commit_new_png")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_new_png",
            truncated: false,
            tree: [{ path: "assets/logo.png", mode: "100644", type: "blob", sha: expectedRawSha, size: pngBytes.byteLength }],
          },
        };
      }
      throw new Error(`Unhandled URL in mock: ${params.url} (${params.method})`);
    });

    const client = new GitHubClient({
      token: "dummy_pat",
      owner: "testowner",
      repo: "testrepo",
      branch: "main",
      requestFn: fakeRequestFn,
    });

    const pushEngine = new PushEngine(app, testSettings, client);
    const report = await pushEngine.executeSafePush();

    expect(report.status).toBe("PASS");
    expect(report.counts.pushedCreated).toBe(1);
    expect(report.newCommitSha).toBe("commit_new_png");

    // Verify byte-exact base64 transmission
    expect(createdBlobBase64.length).toBeGreaterThan(0);
    const roundtripBinary = Uint8Array.from(atob(createdBlobBase64), (c) => c.charCodeAt(0));
    expect(Array.from(roundtripBinary)).toEqual(Array.from(pngBytes));
  });

  // REMOVE-005: Remote binary file still Pulls correctly
  it("REMOVE-005: Remote binary file still Pulls correctly without byte mutation", async () => {
    const app = new App();
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0xfe]);
    const pdfSha = await calculateRawGitBlobSha(pdfBytes);

    let binaryString = "";
    for (let i = 0; i < pdfBytes.length; i++) {
      binaryString += String.fromCharCode(pdfBytes[i]);
    }
    const base64Content = btoa(binaryString);

    const fakeRequestFn = vi.fn(async (params: RequestUrlParam): Promise<RequestUrlResponse> => {
      const url = params.url;

      if (url.includes("/branches/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit_remote_pdf" } },
        };
      }
      if (url.includes("/git/trees/commit_remote_pdf")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree_remote_pdf",
            truncated: false,
            tree: [{ path: "docs/manual.pdf", mode: "100644", type: "blob", sha: pdfSha, size: pdfBytes.byteLength }],
          },
        };
      }
      if (url.includes(`/git/blobs/${pdfSha}`)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: pdfSha,
            size: pdfBytes.byteLength,
            content: base64Content,
            encoding: "base64",
          },
        };
      }
      throw new Error(`Unhandled URL in mock: ${params.url} (${params.method})`);
    });

    const client = new GitHubClient({
      token: "dummy_pat",
      owner: "testowner",
      repo: "testrepo",
      branch: "main",
      requestFn: fakeRequestFn,
    });

    const pullEngine = new PullEngine(app, testSettings, client);
    const report = await pullEngine.executeSafePull();

    expect(report.status).toBe("PASS");
    expect(report.counts.pulledCreated).toBe(1);

    // Verify byte-exact written content in vault
    const createdFile = app.vault.getAbstractFileByPath("docs/manual.pdf") as TFile;
    expect(createdFile).toBeDefined();

    const readBackBuffer = await app.vault.readBinary(createdFile);
    const readBackBytes = new Uint8Array(readBackBuffer);
    expect(Array.from(readBackBytes)).toEqual(Array.from(pdfBytes));
  });
});
