import fs from "fs";
import { describe, it, expect, beforeEach } from "vitest";
import { App, TFile } from "obsidian";
import { AttachmentImporter } from "../src/sync/attachmentImporter";

describe("Mobile Attachment Importer (IMPORT-001..006)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  it("IMPORT-001: Imports binary file (PNG/PDF) into vault using standard arrayBuffer", async () => {
    const importer = new AttachmentImporter(app);
    const fakeContent = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes
    const fakeFile = {
      name: "test-diagram.png",
      size: fakeContent.byteLength,
      arrayBuffer: async () => fakeContent.buffer as ArrayBuffer,
    } as unknown as File;

    const result = await importer.importFile(fakeFile);
    expect(result.success).toBe(true);
    expect(result.vaultPath).toBe("test-diagram.png");
    expect(result.fileName).toBe("test-diagram.png");

    const vaultFile = app.vault.getAbstractFileByPath("test-diagram.png");
    expect(vaultFile).toBeInstanceOf(TFile);
  });

  it("IMPORT-002: Generates collision-safe name without overwriting when destination exists", async () => {
    await app.vault.create("photo.jpg", "existing content");

    const importer = new AttachmentImporter(app);
    const fakeFile = {
      name: "photo.jpg",
      size: 10,
      arrayBuffer: async () => new Uint8Array(10).buffer as ArrayBuffer,
    } as unknown as File;

    const result = await importer.importFile(fakeFile);
    expect(result.success).toBe(true);
    expect(result.vaultPath).toBe("photo (1).jpg");

    // Existing file is preserved
    const original = app.vault.getAbstractFileByPath("photo.jpg");
    expect(await app.vault.read(original as TFile)).toBe("existing content");

    // Second collision increments
    const result2 = await importer.importFile(fakeFile);
    expect(result2.vaultPath).toBe("photo (2).jpg");
  });

  it("IMPORT-003: Uses configured Obsidian attachment folder path when present", async () => {
    (app.vault as unknown as { getConfig: (k: string) => string }).getConfig = (k: string) => {
      if (k === "attachmentFolderPath") return "attachments";
      return "";
    };

    const importer = new AttachmentImporter(app);
    const fakeFile = {
      name: "doc.pdf",
      size: 50,
      arrayBuffer: async () => new Uint8Array(50).buffer as ArrayBuffer,
    } as unknown as File;

    const result = await importer.importFile(fakeFile);
    expect(result.success).toBe(true);
    expect(result.vaultPath).toBe("attachments/doc.pdf");
  });

  it("IMPORT-004: Rejects files exceeding the 25 MiB safety ceiling", async () => {
    const importer = new AttachmentImporter(app);
    const fakeLargeFile = {
      name: "huge-video.mov",
      size: 30 * 1024 * 1024, // 30 MiB
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;

    const result = await importer.importFile(fakeLargeFile);
    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeds the 25 MiB mobile safety ceiling");
  });

  it("IMPORT-005: Zero Node fs dependencies in attachmentImporter.ts", () => {
    const source = fs.readFileSync("src/sync/attachmentImporter.ts", "utf8");
    expect(source.includes("require('fs')")).toBe(false);
    expect(source.includes('require("fs")')).toBe(false);
    expect(source.includes('from "fs"')).toBe(false);
    expect(source.includes("node:fs")).toBe(false);
  });
  it("IMPORT-006: Imported attachment becomes normal LOCAL_ONLY file and is discoverable by SyncEngine", async () => {
    const { SyncEngine } = await import("../src/sync/syncEngine");
    const { GitHubClient } = await import("../src/github/githubClient");

    const importer = new AttachmentImporter(app);
    const fakeContent = new Uint8Array([1, 2, 3, 4]);
    const fakeFile = {
      name: "diagram.png",
      size: 4,
      arrayBuffer: async () => fakeContent.buffer as ArrayBuffer,
    } as unknown as File;

    const importRes = await importer.importFile(fakeFile);
    expect(importRes.success).toBe(true);

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main" });
    const engine = new SyncEngine(app, { owner: "octocat", repo: "notes", branch: "main", excludedPaths: [] }, client);

    const localVault = await engine.scanLocalVault();
    expect(localVault.has("diagram.png")).toBe(true);
    expect(localVault.get("diagram.png")?.size).toBe(4);
    expect(localVault.get("diagram.png")?.sha).toBeDefined();
  });
});
