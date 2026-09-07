import { describe, it, expect, beforeEach } from "vitest";
import { App, Platform } from "obsidian";
import {
  isValidCommitSha,
  isValidBranchName,
  buildExecutionEnv,
  isDesktopGitAvailable,
  advanceDesktopGit,
  triggerDesktopGitAdvanceInBackground,
  ExecFileFunction,
} from "../src/sync/desktopGitManager";
import { VaultRelaySettings, DEFAULT_SETTINGS } from "../src/settings";

describe("Desktop Git Manager", () => {
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

    it("builds execution env with augmented Unix paths on non-Windows", () => {
      const plat = Platform as unknown as { isWin: boolean };
      plat.isWin = false;
      const env = buildExecutionEnv();
      expect(env).toBeDefined();
      expect(env?.["PATH"]).toContain("/usr/bin");
      expect(env?.["PATH"]).toContain("/opt/homebrew/bin");

      plat.isWin = true;
      const winEnv = buildExecutionEnv();
      expect(winEnv).toBeDefined();
    });
  });

  describe("isDesktopGitAvailable", () => {
    it("returns false if not running on Desktop", async () => {
      Platform.isDesktopApp = false;
      await app.vault.adapter.write(".git/HEAD", "ref: refs/heads/main\n");
      const available = await isDesktopGitAvailable(app);
      expect(available).toBe(false);
    });

    it("returns false if .git directory does not exist", async () => {
      Platform.isDesktopApp = true;
      const available = await isDesktopGitAvailable(app);
      expect(available).toBe(false);
    });

    it("returns true on Desktop when .git directory exists", async () => {
      Platform.isDesktopApp = true;
      await app.vault.adapter.write(".git/HEAD", "ref: refs/heads/main\n");
      const available = await isDesktopGitAvailable(app);
      expect(available).toBe(true);
    });
  });

  describe("advanceDesktopGit", () => {
    const sampleSha = "60b77bd3e55883d29a5fc8a7b97e3f22579b6348";

    it("skips execution on mobile", async () => {
      Platform.isDesktopApp = false;
      await app.vault.adapter.write(".git/HEAD", "ref: refs/heads/main\n");

      const result = await advanceDesktopGit(app, "main", sampleSha);
      expect(result.status).toBe("SKIPPED");
      expect(result.message).toContain("not running on Desktop");
    });

    it("skips execution when .git is missing", async () => {
      Platform.isDesktopApp = true;

      const result = await advanceDesktopGit(app, "main", sampleSha);
      expect(result.status).toBe("SKIPPED");
      expect(result.message).toContain(".git directory not found");
    });

    it("fails cleanly when commitSha is invalid", async () => {
      Platform.isDesktopApp = true;
      await app.vault.adapter.write(".git/HEAD", "ref: refs/heads/main\n");

      const result = await advanceDesktopGit(app, "main", "invalid-sha; echo bad");
      expect(result.status).toBe("FAILED");
      expect(result.error).toContain("Invalid commit SHA");
    });

    it("executes fetch, cat-file, and reset --mixed in sequence when successful", async () => {
      Platform.isDesktopApp = true;
      await app.vault.adapter.write(".git/HEAD", "ref: refs/heads/main\n");

      const executedCommands: { file: string; args: string[]; cwd: string }[] = [];
      const mockExecFile: ExecFileFunction = (file, args, options, callback) => {
        executedCommands.push({ file, args, cwd: options.cwd });
        callback(null, "", "");
      };

      const result = await advanceDesktopGit(app, "main", sampleSha, {
        customExecFile: mockExecFile,
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.commitSha).toBe(sampleSha);
      expect(executedCommands).toHaveLength(3);

      // Command 1: fetch
      expect(executedCommands[0].file).toBe("git");
      expect(executedCommands[0].args).toEqual(["fetch", "origin", "main", "--quiet"]);
      expect(executedCommands[0].cwd).toBe("/test/vault");

      // Command 2: cat-file
      expect(executedCommands[1].file).toBe("git");
      expect(executedCommands[1].args).toEqual(["cat-file", "-e", sampleSha]);

      // Command 3: reset --mixed
      expect(executedCommands[2].file).toBe("git");
      expect(executedCommands[2].args).toEqual(["reset", "--mixed", sampleSha]);
    });

    it("handles git fetch failure gracefully", async () => {
      Platform.isDesktopApp = true;
      await app.vault.adapter.write(".git/HEAD", "ref: refs/heads/main\n");

      const mockExecFile: ExecFileFunction = (file, args, _options, callback) => {
        if (args[0] === "fetch") {
          callback(new Error("fatal: unable to access repository (timed out)"), "", "");
        } else {
          callback(null, "", "");
        }
      };

      const result = await advanceDesktopGit(app, "main", sampleSha, {
        customExecFile: mockExecFile,
      });

      expect(result.status).toBe("FAILED");
      expect(result.error).toContain("fatal: unable to access repository");
    });

    it("handles commit object not found in cat-file gracefully", async () => {
      Platform.isDesktopApp = true;
      await app.vault.adapter.write(".git/HEAD", "ref: refs/heads/main\n");

      const mockExecFile: ExecFileFunction = (file, args, _options, callback) => {
        if (args[0] === "cat-file") {
          callback(new Error("fatal: Not a valid object name"), "", "");
        } else {
          callback(null, "", "");
        }
      };

      const result = await advanceDesktopGit(app, "main", sampleSha, {
        customExecFile: mockExecFile,
      });

      expect(result.status).toBe("FAILED");
      expect(result.error).toContain("Not a valid object name");
    });
  });

  describe("triggerDesktopGitAdvanceInBackground", () => {
    const sampleSha = "60b77bd3e55883d29a5fc8a7b97e3f22579b6348";

    it("does nothing if autoAdvanceDesktopGit setting is disabled", () => {
      const settings: VaultRelaySettings = {
        ...DEFAULT_SETTINGS,
        autoAdvanceDesktopGit: false,
      };

      // Should not throw or execute
      expect(() => {
        triggerDesktopGitAdvanceInBackground(app, settings, sampleSha);
      }).not.toThrow();
    });

    it("does nothing if commitSha is missing or invalid", () => {
      const settings: VaultRelaySettings = {
        ...DEFAULT_SETTINGS,
        autoAdvanceDesktopGit: true,
      };

      expect(() => {
        triggerDesktopGitAdvanceInBackground(app, settings, undefined);
        triggerDesktopGitAdvanceInBackground(app, settings, "bad-sha");
      }).not.toThrow();
    });
  });
});
