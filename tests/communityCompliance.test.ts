import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

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
});
