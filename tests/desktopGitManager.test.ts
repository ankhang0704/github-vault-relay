import { describe, it, expect, beforeEach } from "vitest";
import { App, Platform } from "obsidian";
import {
  isValidCommitSha,
  isValidBranchName,
  getGitHandoffFilePath,
  emitGitHandoffSignal,
  readGitHandoffSignal,
  triggerDesktopGitAdvanceInBackground,
} from "../src/sync/desktopGitManager";
import { VaultRelaySettings, DEFAULT_SETTINGS } from "../src/settings";

describe("Desktop Git Manager (Remote Commit Handoff Signal)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
    const plat = Platform as unknown as { isDesktopApp: boolean; isDesktop: boolean; isMobile: boolean };
    plat.isDesktopApp = true;
    plat.isDesktop = true;
    plat.isMobile = false;
  });

  describe("Validation Utilities", () => {
    it("validates 40-character hexadecimal Git commit SHAs", () => {
      expect(isValidCommitSha("60b77bd3e55883d29a5fc8a7b97e3f22579b6348")).toBe(true);
      expect(isValidCommitSha("60B77BD3E55883D29A5FC8A7B97E3F22579B6348")).toBe(true);
      expect(isValidCommitSha("  60b77bd3e55883d29a5fc8a7b97e3f22579b6348  ")).toBe(true);

      // Invalid lengths
      expect(isValidCommitSha("60b77bd")).toBe(false);
      expect(isValidCommitSha("60b77bd3e55883d29a5fc8a7b97e3f22579b6348000")).toBe(false);

      // Non-hex characters
      expect(isValidCommitSha("60z77bd3e55883d29a5fc8a7b97e3f22579b6348")).toBe(false);

      // Command injection attempts
      expect(isValidCommitSha("60b77bd3e55883d29a5fc8a7b97e3f22579b6348; rm -rf /")).toBe(false);
      expect(isValidCommitSha("60b77bd3e55883d29a5fc8a7b97e3f22579b6348 && git")).toBe(false);

      // Non-strings
      expect(isValidCommitSha(null)).toBe(false);
      expect(isValidCommitSha(undefined)).toBe(false);
      expect(isValidCommitSha(123456789)).toBe(false);
      expect(isValidCommitSha({})).toBe(false);
    });

    it("validates branch names", () => {
      expect(isValidBranchName("main")).toBe(true);
      expect(isValidBranchName("master")).toBe(true);
      expect(isValidBranchName("feature/my-branch")).toBe(true);
      expect(isValidBranchName("v1.0.0-rc.1")).toBe(true);

      // Dangerous characters
      expect(isValidBranchName("main; rm -rf")).toBe(false);
      expect(isValidBranchName("main && echo 1")).toBe(false);
      expect(isValidBranchName("main | cat")).toBe(false);
      expect(isValidBranchName("main`whoami`")).toBe(false);
      expect(isValidBranchName("main$(whoami)")).toBe(false);
      expect(isValidBranchName("../traversal")).toBe(false);
      expect(isValidBranchName("")).toBe(false);
      expect(isValidBranchName(null)).toBe(false);
    });

    it("resolves git handoff file path in internal storage", () => {
      const path = getGitHandoffFilePath(app);
      expect(path).toContain("git-handoff.json");
      expect(path).toContain("github-vault-relay");
    });
  });

  describe("emitGitHandoffSignal", () => {
    const sampleSha = "60b77bd3e55883d29a5fc8a7b97e3f22579b6348";

    it("skips emission when not running on Desktop", async () => {
      Platform.isDesktopApp = false;

      const result = await emitGitHandoffSignal(app, "main", sampleSha);
      expect(result.status).toBe("SKIPPED");
      expect(result.message).toContain("not running on Desktop");

      const handoffPath = getGitHandoffFilePath(app);
      expect(await app.vault.adapter.exists(handoffPath)).toBe(false);
    });

    it("fails when commitSha is invalid", async () => {
      Platform.isDesktopApp = true;

      const result = await emitGitHandoffSignal(app, "main", "invalid-sha; rm -rf /");
      expect(result.status).toBe("FAILED");
      expect(result.error).toContain("Invalid commit SHA format");

      const handoffPath = getGitHandoffFilePath(app);
      expect(await app.vault.adapter.exists(handoffPath)).toBe(false);
    });

    it("emits a durable handoff signal on Desktop with valid commit SHA", async () => {
      Platform.isDesktopApp = true;

      const result = await emitGitHandoffSignal(app, "main", sampleSha);
      expect(result.status).toBe("SUCCESS");
      expect(result.signal).toBeDefined();
      expect(result.signal?.$schemaVersion).toBe(1);
      expect(result.signal?.action).toBe("adopt-remote-commit");
      expect(result.signal?.status).toBe("pending");
      expect(result.signal?.branch).toBe("main");
      expect(result.signal?.remoteCommitSha).toBe(sampleSha);
      expect(result.signal?.appliedAt).toBeNull();
      expect(result.signal?.lastError).toBeNull();

      const handoffPath = getGitHandoffFilePath(app);
      expect(await app.vault.adapter.exists(handoffPath)).toBe(true);

      const content = await app.vault.adapter.read(handoffPath);
      const parsed = JSON.parse(content);
      expect(parsed.remoteCommitSha).toBe(sampleSha);
      expect(parsed.status).toBe("pending");
    });

    it("falls back to 'main' branch if branch name is invalid", async () => {
      Platform.isDesktopApp = true;

      const result = await emitGitHandoffSignal(app, "bad;branch", sampleSha);
      expect(result.status).toBe("SUCCESS");
      expect(result.signal?.branch).toBe("main");
    });

    it("handles adapter write exceptions gracefully", async () => {
      Platform.isDesktopApp = true;
      // Mock write failure
      app.vault.adapter.write = () => Promise.reject(new Error("Disk write error"));

      const result = await emitGitHandoffSignal(app, "main", sampleSha);
      expect(result.status).toBe("FAILED");
      expect(result.error).toContain("Disk write error");
    });
  });

  describe("readGitHandoffSignal", () => {
    const sampleSha = "60b77bd3e55883d29a5fc8a7b97e3f22579b6348";

    it("returns null when signal file does not exist", async () => {
      const signal = await readGitHandoffSignal(app);
      expect(signal).toBeNull();
    });

    it("returns null when signal file contains malformed JSON", async () => {
      const handoffPath = getGitHandoffFilePath(app);
      await app.vault.adapter.write(handoffPath, "not-json");

      const signal = await readGitHandoffSignal(app);
      expect(signal).toBeNull();
    });

    it("returns null when signal schema is unrecognized", async () => {
      const handoffPath = getGitHandoffFilePath(app);
      await app.vault.adapter.write(handoffPath, JSON.stringify({ $schemaVersion: 999 }));

      const signal = await readGitHandoffSignal(app);
      expect(signal).toBeNull();
    });

    it("returns parsed signal when file is valid", async () => {
      await emitGitHandoffSignal(app, "main", sampleSha);
      const signal = await readGitHandoffSignal(app);

      expect(signal).not.toBeNull();
      expect(signal?.remoteCommitSha).toBe(sampleSha);
      expect(signal?.status).toBe("pending");
    });
  });

  describe("triggerDesktopGitAdvanceInBackground", () => {
    const sampleSha = "60b77bd3e55883d29a5fc8a7b97e3f22579b6348";

    it("does nothing if autoAdvanceDesktopGit setting is disabled", async () => {
      const settings: VaultRelaySettings = {
        ...DEFAULT_SETTINGS,
        autoAdvanceDesktopGit: false,
      };

      triggerDesktopGitAdvanceInBackground(app, settings, sampleSha);

      // Wait a tick for any async task
      await new Promise((resolve) => setTimeout(resolve, 50));

      const handoffPath = getGitHandoffFilePath(app);
      expect(await app.vault.adapter.exists(handoffPath)).toBe(false);
    });

    it("does nothing if commitSha is missing or invalid", async () => {
      const settings: VaultRelaySettings = {
        ...DEFAULT_SETTINGS,
        autoAdvanceDesktopGit: true,
      };

      triggerDesktopGitAdvanceInBackground(app, settings, undefined);
      triggerDesktopGitAdvanceInBackground(app, settings, "bad-sha");

      await new Promise((resolve) => setTimeout(resolve, 50));

      const handoffPath = getGitHandoffFilePath(app);
      expect(await app.vault.adapter.exists(handoffPath)).toBe(false);
    });

    it("emits handoff signal in background when enabled with valid sha", async () => {
      const settings: VaultRelaySettings = {
        ...DEFAULT_SETTINGS,
        autoAdvanceDesktopGit: true,
        branch: "main",
      };

      triggerDesktopGitAdvanceInBackground(app, settings, sampleSha);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const handoffPath = getGitHandoffFilePath(app);
      expect(await app.vault.adapter.exists(handoffPath)).toBe(true);

      const signal = await readGitHandoffSignal(app);
      expect(signal?.remoteCommitSha).toBe(sampleSha);
    });
  });
});
