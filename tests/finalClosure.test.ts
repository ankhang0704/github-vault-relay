import { describe, expect, it, vi } from "vitest";
import { App, PluginManifest, TFile } from "obsidian";
import VaultRelayPlugin from "../src/main";
import { GitHubClient } from "../src/github/githubClient";
import { calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { PullEngine } from "../src/sync/pullEngine";
import { SyncEngine } from "../src/sync/syncEngine";
import { sanitizeErrorMessage } from "../src/security/redact";

const manifest: PluginManifest = {
  id: "github-vault-relay",
  name: "GitHub Vault Relay",
  version: "1.0.4",
  minAppVersion: "1.11.4",
  description: "Test manifest",
  author: "Test",
};

describe("Final product closure regressions", () => {
  it("normalizes persisted settings with the live configDir", async () => {
    const app = new App();
    app.vault.configDir = "mobile-obsidian";
    const plugin = new VaultRelayPlugin(app, manifest);
    plugin.loadData = async () => ({ excludedPaths: [".git/"], settingsVersion: 2 });

    await plugin.loadSettings();

    expect(plugin.settings.excludedPaths).toContain("mobile-obsidian/");
    expect(plugin.settings.excludedPaths).toContain(".git/");
  });

  it("excludes custom configDir from local scans and remote previews", async () => {
    const app = new App();
    app.vault.configDir = "mobile-obsidian";
    const visibleFile = await app.vault.create("visible.md", "visible");
    const originalGetFiles = app.vault.getFiles;
    const internalFile = new TFile();
    internalFile.path = "mobile-obsidian/github-vault-relay/local-state.json";
    internalFile.stat = { mtime: Date.now(), ctime: Date.now(), size: 1 };
    app.vault.getFiles = () => [...originalGetFiles(), internalFile];

    const remoteText = "remote";
    const remoteBytes = new TextEncoder().encode(remoteText);
    const remoteSha = await calculateRawGitBlobSha(remoteBytes);
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "commit", commit: { tree: { sha: "tree" } } } },
        };
      }
      if (params.url.includes("/git/trees/tree")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "tree",
            truncated: false,
            tree: [
              { path: "mobile-obsidian/github-vault-relay/remote-state.json", type: "blob", mode: "100644", sha: "internal" },
              { path: "remote.md", type: "blob", mode: "100644", sha: remoteSha, size: remoteBytes.byteLength },
            ],
          },
        };
      }
      if (params.url.includes(`/git/blobs/${remoteSha}`)) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: remoteSha,
            size: remoteBytes.byteLength,
            encoding: "base64",
            content: Buffer.from(remoteBytes).toString("base64"),
          },
        };
      }
      throw new Error(`Unhandled request URL: ${params.url}`);
    });

    const settings = { owner: "owner", repo: "repo", branch: "main", excludedPaths: [".git/"] };
    const client = new GitHubClient({ ...settings, token: "test-token", requestFn: fakeRequestFn });
    const syncEngine = new SyncEngine(app, settings, client);
    const localFiles = await syncEngine.scanLocalVault(true);
    const preview = await syncEngine.generatePreview(true);

    expect(localFiles.has(visibleFile.path)).toBe(true);
    expect(localFiles.has(internalFile.path)).toBe(false);
    expect(preview.items.some((item) => item.path.includes("mobile-obsidian/"))).toBe(false);
    expect(preview.items.some((item) => item.path === "remote.md")).toBe(true);

    const pullReport = await new PullEngine(app, settings, client).executeSafePull();
    expect(pullReport.status).toBe("PASS");
    expect(app.vault.getAbstractFileByPath("remote.md")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath("mobile-obsidian/github-vault-relay/remote-state.json")).toBeNull();
  });

  it("keeps diagnostic output sanitized for token-bearing errors and objects", () => {
    const pat = "github_pat_11AABBCCDDEEFFGGHHIIJJKK_1234567890abcdefghijklmnopqrstuvwxyz";
    const message = sanitizeErrorMessage({
      message: `request failed with ${pat}`,
      request: { headers: { Authorization: `Bearer ${pat}` }, body: pat },
    });

    expect(message).not.toContain(pat);
    expect(message).toContain("[REDACTED_TOKEN]");
  });

  it("does not pass caught error variables directly to production diagnostics", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(process.cwd(), "src");
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(entryPath);
        else if (entry.name.endsWith(".ts")) files.push(entryPath);
      }
    };
    await visit(root);
    const source = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n");

    expect(source).not.toMatch(/console\.(?:warn|error|log|info|debug)\([^;\n]*,\s*(?:err|error|[A-Za-z_$][\w$]*(?:Err|Error))\s*\)/);
    expect(source).not.toMatch(/new Notice\([^;\n]*(?:String\(err\)|err\.message|String\(error\)|error\.message)/);
  });
});
