import { describe, it, expect } from "vitest";
import { isPathExcluded, normalizePath, parseExclusionRules, DEFAULT_EXCLUSIONS } from "../src/sync/pathFilter";

describe("pathFilter", () => {
  describe("normalizePath", () => {
    it("converts backslashes to forward slashes", () => {
      expect(normalizePath("folder\\subfolder\\file.md")).toBe("folder/subfolder/file.md");
    });

    it("strips leading slashes and relative prefix", () => {
      expect(normalizePath("./notes/test.md")).toBe("notes/test.md");
      expect(normalizePath("/notes/test.md")).toBe("notes/test.md");
      expect(normalizePath("///notes/test.md")).toBe("notes/test.md");
    });
  });

  describe("isPathExcluded", () => {
    it("excludes default critical folders", () => {
      expect(isPathExcluded(".obsidian/workspace.json")).toBe(true);
      expect(isPathExcluded(".obsidian/plugins/vault-relay/main.js")).toBe(true);
      expect(isPathExcluded(".git/HEAD")).toBe(true);
      expect(isPathExcluded(".git/objects/12/3456")).toBe(true);
      expect(isPathExcluded("_fit/snapshots/1.json")).toBe(true);
      expect(isPathExcluded("_vault-relay/state.json")).toBe(true);
    });

    it("allows standard vault notes and attachments", () => {
      expect(isPathExcluded("Notes/Daily/2026-09-01.md")).toBe(false);
      expect(isPathExcluded("README.md")).toBe(false);
      expect(isPathExcluded("assets/images/photo.png")).toBe(false);
      expect(isPathExcluded("Projects/Project A/Design.canvas")).toBe(false);
    });

    it("respects custom exclusions", () => {
      const customRules = [...DEFAULT_EXCLUSIONS, "Private/", "archive/old.md"];
      expect(isPathExcluded("Private/secret.md", customRules)).toBe(true);
      expect(isPathExcluded("Private/Sub/secret.md", customRules)).toBe(true);
      expect(isPathExcluded("archive/old.md", customRules)).toBe(true);
      expect(isPathExcluded("archive/new.md", customRules)).toBe(false);
      expect(isPathExcluded("Public/note.md", customRules)).toBe(false);
    });

    it("handles Windows backslashes in input paths correctly", () => {
      expect(isPathExcluded(".obsidian\\workspace.json")).toBe(true);
      expect(isPathExcluded("_vault-relay\\state.json")).toBe(true);
      expect(isPathExcluded("Folder\\Note.md")).toBe(false);
    });
  });

  describe("parseExclusionRules", () => {
    it("parses multiline text and preserves default exclusions", () => {
      const input = `
        # This is a comment
        temp/
        drafts/
      `;
      const rules = parseExclusionRules(input);
      expect(rules).toContain("temp/");
      expect(rules).toContain("drafts/");
      expect(rules).toContain(".obsidian/");
      expect(rules).toContain(".git/");
      expect(rules).toContain("_vault-relay/");
    });
  });
});
