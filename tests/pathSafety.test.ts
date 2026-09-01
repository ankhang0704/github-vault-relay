import { describe, it, expect } from "vitest";
import { validatePathSafety, detectCaseCollisions } from "../src/sync/pathSafety";

describe("Path Safety & Case Collisions (src/sync/pathSafety.ts)", () => {
  describe("validatePathSafety", () => {
    it("accepts valid vault paths", () => {
      expect(validatePathSafety("Notes/Daily/2026-09-01.md").valid).toBe(true);
      expect(validatePathSafety("README.md").valid).toBe(true);
      expect(validatePathSafety("assets/photo.png").valid).toBe(true);
      expect(validatePathSafety("Projects/My Project/design.canvas").valid).toBe(true);
    });

    it("rejects directory traversal attempts (C2-010)", () => {
      expect(validatePathSafety("../escaped.md").valid).toBe(false);
      expect(validatePathSafety("notes/../../etc/passwd").valid).toBe(false);
      expect(validatePathSafety("folder/./test.md").valid).toBe(false);
    });

    it("rejects absolute paths and drive letters", () => {
      expect(validatePathSafety("/root/note.md").valid).toBe(false);
      expect(validatePathSafety("C:\\Windows\\system32").valid).toBe(false);
      expect(validatePathSafety("D:/vault/note.md").valid).toBe(false);
    });

    it("rejects NUL characters", () => {
      expect(validatePathSafety("bad\0file.md").valid).toBe(false);
    });

    it("rejects reserved internal system directories (C2-011)", () => {
      expect(validatePathSafety(".obsidian/plugins/test.js").valid).toBe(false);
      expect(validatePathSafety(".git/HEAD").valid).toBe(false);
      expect(validatePathSafety("_fit/conflict.md").valid).toBe(false);
      expect(validatePathSafety("_vault-relay/state.json").valid).toBe(false);
      expect(validatePathSafety("_vault-relay/conflicts/file.md").valid).toBe(false);
    });
  });

  describe("detectCaseCollisions (REG-010)", () => {
    it("detects case-only renames and duplicate entries differing only by case", () => {
      const paths = ["summary.md", "Summary.md", "notes/test.md", "Notes/Test.md", "unique.md"];
      const collisions = detectCaseCollisions(paths);

      expect(collisions.size).toBe(2);
      expect(collisions.get("summary.md")).toEqual(["summary.md", "Summary.md"]);
      expect(collisions.get("notes/test.md")).toEqual(["notes/test.md", "Notes/Test.md"]);
    });

    it("returns empty map when all paths have distinct lowercase representations", () => {
      const paths = ["note1.md", "note2.md", "folder/note3.md"];
      const collisions = detectCaseCollisions(paths);
      expect(collisions.size).toBe(0);
    });
  });
});
