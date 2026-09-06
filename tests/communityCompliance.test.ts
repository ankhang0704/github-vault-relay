import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { deserializeState } from "../src/sync/syncState";
import { VaultRelaySettingTab } from "../src/settings";
import VaultRelayPlugin from "../src/main";
import { App } from "./__mocks__/obsidian";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("Obsidian Community Directory Compliance Suite (COMMUNITY-001..010)", () => {
  it("COMMUNITY-001: Manifest satisfies all directory identity constraints", () => {
    const manifest = JSON.parse(read("manifest.json"));

    // ID constraints: lowercase letters/hyphens only, no 'obsidian', no 'plugin' ending
    expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
    expect(manifest.id.toLowerCase()).not.toContain("obsidian");
    expect(manifest.id.toLowerCase().endsWith("-plugin")).toBe(false);
    expect(manifest.id.toLowerCase().endsWith("plugin")).toBe(false);

    // Name constraints: neither "Obsidian" nor "Plugin"
    expect(manifest.name).not.toMatch(/\bObsidian\b/i);
    expect(manifest.name).not.toMatch(/\bPlugin\b/i);

    // Description constraints: <= 250 chars and ends with "."
    expect(manifest.description.length).toBeLessThanOrEqual(250);
    expect(manifest.description.endsWith(".")).toBe(true);

    // Author and authorUrl
    expect(typeof manifest.author).toBe("string");
    expect(manifest.author.length).toBeGreaterThan(0);
    expect(manifest.authorUrl).toMatch(/^https:\/\//);
  });

  it("COMMUNITY-002: Settings tab does not use manual HTML headings (uses setHeading)", () => {
    const settingsCode = read("src/settings.ts");

    // Must not use createEl('h1'|'h2'|'h3'...)
    expect(settingsCode).not.toMatch(/containerEl\.createEl\s*\(\s*["']h[1-6]["']/);
    expect(settingsCode).toContain(".setHeading()");
  });

  it("COMMUNITY-003: Modals and Settings do not use static style assignments", () => {
    const uiFiles = [
      "src/settings.ts",
      "src/ui/clearTokenConfirmModal.ts",
      "src/ui/conflictResolutionModal.ts",
      "src/ui/pullConfirmModal.ts",
      "src/ui/pullResultModal.ts",
      "src/ui/pushConfirmModal.ts",
      "src/ui/pushResultModal.ts",
      "src/ui/syncDashboardModal.ts",
      "src/ui/syncPreviewModal.ts",
    ];

    for (const file of uiFiles) {
      const content = read(file);
      // Ensure no static style property assignments for width/maxWidth/padding/minHeight
      expect(content, `${file} should not have style.maxWidth`).not.toMatch(/\.style\.maxWidth\s*=/);
      expect(content, `${file} should not have style.minHeight`).not.toMatch(/\.style\.minHeight\s*=/);
      expect(content, `${file} should not have style.width`).not.toMatch(/\.style\.width\s*=\s*["']\d+/);
      expect(content, `${file} should not have style.padding`).not.toMatch(/\.style\.padding\s*=\s*["']\d+/);
    }
  });

  it("COMMUNITY-004: File deletion exclusively delegates to app.fileManager.trashFile", () => {
    const storageCode = read("src/sync/storageManager.ts");

    expect(storageCode).toContain("await app.fileManager.trashFile(file)");
    // Must not contain fallback to vault.delete() for user files
    expect(storageCode).not.toMatch(/await app\.vault\.delete\(file\)/);
  });

  it("COMMUNITY-005: Config directory references use dynamic vault.configDir", () => {
    const storageCode = read("src/sync/storageManager.ts");

    expect(storageCode).toContain("app.vault.configDir");
  });

  it("COMMUNITY-006: esbuild uses Node builtins without extra package dependencies", () => {
    const esbuildCode = read("esbuild.config.mjs");
    const pkg = JSON.parse(read("package.json"));

    expect(esbuildCode).toContain('from "node:module"');
    expect(pkg.devDependencies["builtin-modules"]).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
  });

  it("COMMUNITY-007: Package.json description matches manifest.json", () => {
    const manifest = JSON.parse(read("manifest.json"));
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.description).toBe(manifest.description);
  });

  it("COMMUNITY-013: persisted state decoder rejects malformed unknown values without throwing", () => {
    // String with invalid JSON syntax
    const emptyState = deserializeState("{ corrupt json !!!");
    expect(emptyState.files).toEqual({});

    // JSON that is not an object (e.g. number or null or array)
    expect(deserializeState("null").files).toEqual({});
    expect(deserializeState("123").files).toEqual({});
    expect(deserializeState("[]").files).toEqual({});

    // State with invalid files map
    const invalidFilesState = deserializeState(
      JSON.stringify({
        version: 2,
        files: {
          "bad1.md": "not-an-object",
          "bad2.md": { remoteSha: 123, localSha: "abc", syncedAt: 456 },
          "good.md": { remoteSha: "sha1", localSha: "sha2", syncedAt: 1000 },
        },
      })
    );
    expect(invalidFilesState.files["bad1.md"]).toBeUndefined();
    expect(invalidFilesState.files["bad2.md"]).toBeUndefined();
    expect(invalidFilesState.files["good.md"]).toBeDefined();
    expect(invalidFilesState.files["good.md"].remoteSha).toBe("sha1");
  });

  it("COMMUNITY-014: GitHub error guard safely narrows unknown error in client", () => {
    const clientCode = read("src/github/githubClient.ts");
    expect(clientCode).toContain('typeof jsonBody === "object" && jsonBody !== null');
    expect(clientCode).not.toContain("response.json.message");
  });

  it("COMMUNITY-015: settings tab display() is synchronous void and does not return a Promise", () => {
    const settingsCode = read("src/settings.ts");
    expect(settingsCode).toContain("public override display(): void");
    expect(settingsCode).not.toContain("public async display(): Promise<void>");

    const app = new App();
    const manifest = {
      id: "github-vault-relay",
      name: "test",
      version: "1.0.0",
      minAppVersion: "1.11.4",
    } as unknown as import("obsidian").PluginManifest;
    const obsidianApp = app as unknown as import("obsidian").App;
    const plugin = new VaultRelayPlugin(obsidianApp, manifest);
    const tab = new VaultRelaySettingTab(obsidianApp, plugin);
    const result = tab.display();
    expect(result).toBeUndefined();
  });

  it("COMMUNITY-016: async UI modal callbacks explicitly handle rejection", () => {
    const modalFiles = [
      "src/ui/pullConfirmModal.ts",
      "src/ui/pushConfirmModal.ts",
      "src/ui/syncPreviewModal.ts",
      "src/ui/syncDashboardModal.ts",
    ];

    for (const f of modalFiles) {
      const code = read(f);
      expect(code, `${f} should handle rejections`).toMatch(/void.*\.catch|\.catch\(|try\s*\{/);
    }
  });

  it("COMMUNITY-017: declarative settings definitions exist via getSettingDefinitions() for Obsidian >= 1.13+", () => {
    const app = new App();
    const obsidianApp = app as unknown as import("obsidian").App;
    const manifest = {
      id: "github-vault-relay",
      name: "test",
      version: "1.0.0",
      minAppVersion: "1.11.4",
    } as unknown as import("obsidian").PluginManifest;
    const plugin = new VaultRelayPlugin(obsidianApp, manifest);
    const tab = new VaultRelaySettingTab(obsidianApp, plugin);

    const defs = tab.getSettingDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);

    const headings = defs.map(
      (d: { heading?: string; name?: string }) => d.heading || d.name
    );
    expect(headings).toContain("Connection Wizard");
    expect(headings).toContain("Advanced / Security");
    expect(headings).toContain("Diagnostics & Sync");
  });

  it("COMMUNITY-018: legacy settings path remains supported via display() for Obsidian < 1.13", () => {
    const settingsCode = read("src/settings.ts");
    expect(settingsCode).toContain("public override display(): void");
    expect(settingsCode).toContain("public override getSettingDefinitions(): SettingDefinitionItem[]");

    const app = new App();
    const obsidianApp = app as unknown as import("obsidian").App;
    const manifest = {
      id: "github-vault-relay",
      name: "test",
      version: "1.0.0",
      minAppVersion: "1.11.4",
    } as unknown as import("obsidian").PluginManifest;
    const plugin = new VaultRelayPlugin(obsidianApp, manifest);
    const tab = new VaultRelaySettingTab(obsidianApp, plugin);

    tab.display();
    expect(tab.containerEl.children.length).toBeGreaterThan(0);
  });

  it("COMMUNITY-019: no deprecated setWarning calls exist in production codebase", () => {
    const srcFiles = [
      "src/settings.ts",
      "src/ui/clearTokenConfirmModal.ts",
      "src/ui/conflictResolutionModal.ts",
      "src/ui/pullConfirmModal.ts",
      "src/ui/pushConfirmModal.ts",
      "src/ui/syncDashboardModal.ts",
      "src/ui/syncPreviewModal.ts",
    ];

    for (const f of srcFiles) {
      const code = read(f);
      expect(code, `${f} contains deprecated .setWarning()`).not.toContain(".setWarning()");
    }
  });

  it("COMMUNITY-020: no routine production console logging in push/pull/sync engines", () => {
    const engineFiles = [
      "src/sync/pushEngine.ts",
      "src/sync/pullEngine.ts",
      "src/sync/syncEngine.ts",
      "src/sync/storageManager.ts",
    ];

    for (const f of engineFiles) {
      const code = read(f);
      expect(code, `${f} should not have routine console.info`).not.toMatch(/console\.info\(/);
    }
  });

  it("COMMUNITY-021: unbound callback behavior preserved on StorageManager state validator", () => {
    const storageCode = read("src/sync/storageManager.ts");
    expect(storageCode).toContain("isStateValue(this: void, value: unknown)");
  });
});
