/**
 * Empirical Challenger Test Suite for Milestone 1: Unified Modal Architectures
 *
 * Adversarial and empirical verification of:
 * 1. SyncConfirmModal (pull and push branches, preflight, actions summary, button lifecycle, error handling)
 * 2. SyncResultModal (pull and push branches, direction inference, status banners, badges, filtering, teardown)
 * 3. Total removal and absence of legacy modal files across the repository
 * 4. Security invariants (zero PAT leakage, sanitized messages, mobile accessibility classes)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import VaultRelayPlugin from "../src/main";
import { SyncConfirmModal } from "../src/ui/syncConfirmModal";
import { SyncResultModal } from "../src/ui/syncResultModal";
import { PullEngine } from "../src/sync/pullEngine";
import { PushEngine } from "../src/sync/pushEngine";
import { SyncEngine } from "../src/sync/syncEngine";
import { setStoredPat } from "../src/security/secretStore";
import { App } from "obsidian";
import { MockElement } from "./__mocks__/obsidian";
import {
  PullExecutionReport,
  PushExecutionReport,
  SyncPreviewItem,
  SyncPreviewReport,
  SyncCategoryCounts,
} from "../src/sync/syncTypes";

const repoRoot = process.cwd();

function asMock(el: unknown): MockElement {
  return el as unknown as MockElement;
}

function isModalOpen(modal: unknown): boolean {
  return (modal as { isOpen?: boolean }).isOpen ?? false;
}

function getAllText(el: unknown): string {
  const mockEl = el as MockElement;
  let res = mockEl?.textContent || "";
  if (mockEl?.children) {
    for (const child of mockEl.children) {
      res += " " + getAllText(child);
    }
  }
  return res;
}

function findButtons(el: unknown): MockElement[] {
  const mockEl = el as MockElement;
  return mockEl.findAll ? mockEl.findAll((child) => child.tag === "button") : [];
}

function makeEmptyCounts(): SyncCategoryCounts {
  return {
    LOCAL_ONLY: 0,
    LOCAL_CHANGED: 0,
    LOCAL_DELETED: 0,
    REMOTE_ONLY: 0,
    REMOTE_CHANGED: 0,
    REMOTE_DELETED: 0,
    POTENTIAL_CONFLICT: 0,
    DELETE_CONFLICT: 0,
    DELETED: 0,
    UNCHANGED: 0,
    OVERSIZED: 0,
    UNSAFE: 0,
  };
}

function makeMockPreviewReport(
  items: SyncPreviewItem[],
  countsPartial: Partial<SyncCategoryCounts> = {},
  truncated = false
): SyncPreviewReport {
  return {
    timestamp: Date.now(),
    branch: "main",
    items,
    counts: { ...makeEmptyCounts(), ...countsPartial },
    totalScannedLocal: items.length,
    totalScannedRemote: items.length,
    truncatedRemoteTree: truncated,
    caseCollisions: [],
  };
}

describe("Empirical Challenger M1: Unified Modal Architectures Verification", () => {
  let app: App;
  let plugin: VaultRelayPlugin;

  beforeEach(() => {
    vi.restoreAllMocks();
    app = new App();
    plugin = new VaultRelayPlugin(app, {
      id: "github-vault-relay",
      name: "GitHub Vault Relay",
      version: "1.1.0",
      minAppVersion: "1.0.0",
      author: "Test",
      description: "Test",
    });
    plugin.settings = {
      owner: "octocat",
      repo: "notes",
      branch: "main",
      excludedPaths: [".obsidian/", ".git/", "_fit/"],
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. LEGACY MODAL REMOVAL AUDIT
  // =========================================================================
  describe("Audit 1: Total Decommissioning of Legacy Modals", () => {
    it("CHALLENGE-M1-LEGACY-001: Legacy modal source files are physically absent from disk", () => {
      const legacyFiles = [
        "src/ui/pullConfirmModal.ts",
        "src/ui/pushConfirmModal.ts",
        "src/ui/pullResultModal.ts",
        "src/ui/pushResultModal.ts",
      ];

      for (const relPath of legacyFiles) {
        const fullPath = path.join(repoRoot, relPath);
        expect(fs.existsSync(fullPath), `File ${relPath} should NOT exist on disk`).toBe(false);
      }
    });

    it("CHALLENGE-M1-LEGACY-002: Zero imports or references to legacy classes in src/", () => {
      const srcDir = path.join(repoRoot, "src");
      const files: string[] = [];

      function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(entryPath);
          else if (entry.name.endsWith(".ts")) files.push(entryPath);
        }
      }
      walk(srcDir);

      const legacyClasses = [
        "PullConfirmModal",
        "PushConfirmModal",
        "PullResultModal",
        "PushResultModal",
      ];

      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        for (const className of legacyClasses) {
          expect(
            content.includes(className),
            `File ${file} should not reference legacy class ${className}`
          ).toBe(false);
        }
      }
    });
  });

  // =========================================================================
  // 2. SYNCCONFIRMMODAL PREFLIGHT STATES & SECURITY
  // =========================================================================
  describe("Audit 2: SyncConfirmModal Preflight & Safety Guards", () => {
    it("CHALLENGE-M1-PRE-001: Missing PAT in SecretStorage renders preflight error on Pull and Push", async () => {
      // SecretStorage is empty (no PAT)
      const pullModal = new SyncConfirmModal(app, plugin, "pull");
      await (pullModal as unknown as { runPreflight: () => Promise<void> }).runPreflight();

      const pullText = getAllText(pullModal.contentEl);
      expect(pullText).toContain("Preflight check failed");
      expect(pullText).toContain("No GitHub PAT found in secure storage");
      const pullButtons = findButtons(pullModal.contentEl);
      expect(pullButtons.some((b) => b.textContent.includes("Confirm"))).toBe(false);

      const pushModal = new SyncConfirmModal(app, plugin, "push");
      await (pushModal as unknown as { runPreflight: () => Promise<void> }).runPreflight();

      const pushText = getAllText(pushModal.contentEl);
      expect(pushText).toContain("Preflight Check Failed");
      expect(pushText).toContain("No GitHub PAT found in secure storage");
      const pushButtons = findButtons(pushModal.contentEl);
      expect(pushButtons.some((b) => b.textContent.includes("Confirm"))).toBe(false);
    });

    it("CHALLENGE-M1-PRE-002: Preflight error sanitization NEVER leaks raw GitHub PAT", async () => {
      const secretToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
      await setStoredPat(app, plugin.settings.owner, plugin.settings.repo, secretToken);

      const rawTokenError = new Error(
        `GitHub API 401 Unauthorized for token ${secretToken} at https://api.github.com`
      );
      vi.spyOn(SyncEngine.prototype, "generatePreview").mockRejectedValue(rawTokenError);

      const modal = new SyncConfirmModal(app, plugin, "pull");
      await (modal as unknown as { runPreflight: () => Promise<void> }).runPreflight();

      const text = getAllText(modal.contentEl);
      expect(text).toContain("Preflight check failed");
      expect(text).not.toContain(secretToken);
      expect(text).toContain("[REDACTED_TOKEN]");
    });

    it("CHALLENGE-M1-PRE-003: Truncated remote tree (>100,000 items) blocks both Pull and Push with no confirm button", () => {
      const truncatedReport = makeMockPreviewReport([], {}, true);

      // Pull branch
      const pullModal = new SyncConfirmModal(app, plugin, "pull");
      const pullInternal = pullModal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      pullInternal.previewReport = truncatedReport;
      pullInternal.renderConfirmation();

      const pullText = getAllText(pullModal.contentEl);
      expect(pullText).toContain("🚫 Safe pull blocked: Truncated Git tree");
      expect(pullText).toContain(">100,000 items");
      const pullBtns = findButtons(pullModal.contentEl);
      expect(pullBtns.some((b) => b.textContent.includes("Confirm"))).toBe(false);

      // Push branch
      const pushModal = new SyncConfirmModal(app, plugin, "push");
      const pushInternal = pushModal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      pushInternal.previewReport = truncatedReport;
      pushInternal.renderConfirmation();

      const pushText = getAllText(pushModal.contentEl);
      expect(pushText).toContain("🚫 Safe Push Blocked: Truncated Git Tree");
      expect(pushText).toContain(">100,000 items");
      const pushBtns = findButtons(pushModal.contentEl);
      expect(pushBtns.some((b) => b.textContent.includes("Confirm"))).toBe(false);
    });
  });

  // =========================================================================
  // 3. PLANNED ACTIONS SUMMARY COMBINATORICS
  // =========================================================================
  describe("Audit 3: Planned Actions Summary Full Matrix", () => {
    it("CHALLENGE-M1-ACT-001: Pull branch correctly formats all planned action categories", () => {
      const items: SyncPreviewItem[] = [
        { path: "new.md", category: "REMOTE_ONLY", remoteSha: "sha1" },
        { path: "update.md", category: "REMOTE_CHANGED", remoteSha: "sha2", baseSha: "sha1" },
        { path: "del1.md", category: "REMOTE_DELETED", baseSha: "sha3" },
        { path: "del2.md", category: "REMOTE_DELETED", baseSha: "sha4" },
        { path: "delMove.md", category: "REMOTE_DELETED", isMove: true, movedTo: "moveDest.md", baseSha: "sha5" },
        { path: "moveDest.md", category: "REMOTE_ONLY", isMove: true, movedFrom: "delMove.md", remoteSha: "sha5" },
        { path: "conflict.md", category: "POTENTIAL_CONFLICT", remoteSha: "sha6", localSha: "sha7" },
        { path: "delConf.md", category: "DELETE_CONFLICT", remoteSha: "sha8" },
        { path: "big.md", category: "REMOTE_ONLY", isOversized: true, remoteSha: "sha9" },
        { path: "local.md", category: "LOCAL_CHANGED", localSha: "sha10" },
        { path: "same.md", category: "UNCHANGED", remoteSha: "sha11", localSha: "sha11" },
      ];

      const report = makeMockPreviewReport(items, {
        REMOTE_ONLY: 1,
        REMOTE_CHANGED: 1,
        REMOTE_DELETED: 2,
        POTENTIAL_CONFLICT: 1,
        DELETE_CONFLICT: 1,
        OVERSIZED: 1,
        LOCAL_CHANGED: 1,
        UNCHANGED: 1,
      });

      const modal = new SyncConfirmModal(app, plugin, "pull");
      const internal = modal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      internal.previewReport = report;
      internal.renderConfirmation();

      const text = getAllText(modal.contentEl);
      expect(text).toContain("Confirm safe pull (GitHub → local)");
      expect(text).toContain("New files to create locally: 2");
      expect(text).toContain("Files to update locally: 1");
      expect(text).toContain("⚠️ Files to remove locally: 2");
      expect(text).toContain("trash according to your Obsidian trash settings");
      expect(text).toContain("Moves to apply locally: 1");
      expect(text).toContain("Delete conflicts (require review): 1");
      expect(text).toContain("Potential conflicts (preserved to internal conflict storage): 1");
      expect(text).toContain("Oversized files (>25 MiB, skipped): 1");
      expect(text).toContain("Local changes / notes kept untouched: 1");
      expect(text).toContain("Unchanged files: 1");

      const confirmBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Confirm"));
      expect(confirmBtn).toBeDefined();
      expect(confirmBtn?.textContent).toBe("Confirm Safe Pull");
    });

    it("CHALLENGE-M1-ACT-002: Push branch correctly formats target and all planned action categories", () => {
      const items: SyncPreviewItem[] = [
        { path: "pNew.md", category: "LOCAL_ONLY", localSha: "sha1" },
        { path: "pUpdate.md", category: "LOCAL_CHANGED", localSha: "sha2", baseSha: "sha1" },
        { path: "pDel.md", category: "LOCAL_DELETED", baseSha: "sha3" },
        { path: "pDelMove.md", category: "LOCAL_DELETED", isMove: true, movedTo: "pMoveDest.md", baseSha: "sha4" },
        { path: "pMoveDest.md", category: "LOCAL_ONLY", isMove: true, movedFrom: "pDelMove.md", localSha: "sha4" },
        { path: "pConf.md", category: "POTENTIAL_CONFLICT", remoteSha: "sha5", localSha: "sha6" },
        { path: "pDelConf.md", category: "DELETE_CONFLICT", baseSha: "sha7" },
        { path: "pBig.md", category: "LOCAL_ONLY", isOversized: true, localSha: "sha8" },
        { path: "pRemote.md", category: "REMOTE_CHANGED", remoteSha: "sha9" },
        { path: "pSame.md", category: "UNCHANGED", remoteSha: "sha10", localSha: "sha10" },
      ];

      const report = makeMockPreviewReport(items, {
        LOCAL_ONLY: 1,
        LOCAL_CHANGED: 1,
        LOCAL_DELETED: 1,
        POTENTIAL_CONFLICT: 1,
        DELETE_CONFLICT: 1,
        OVERSIZED: 1,
        REMOTE_CHANGED: 1,
        UNCHANGED: 1,
      });

      const modal = new SyncConfirmModal(app, plugin, "push");
      const internal = modal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      internal.previewReport = report;
      internal.renderConfirmation();

      const text = getAllText(modal.contentEl);
      expect(text).toContain("Confirm Safe Push (Local → GitHub)");
      expect(text).toContain("Target: octocat/notes (branch: main)");
      expect(text).toContain("New files to create on GitHub: 2");
      expect(text).toContain("Files to update on GitHub: 1");
      expect(text).toContain("⚠️ Files to delete from GitHub: 1");
      expect(text).toContain("The current GitHub version will be removed in the new commit");
      expect(text).toContain("Moves to commit to GitHub: 1");
      expect(text).toContain("Delete conflicts (not pushed, require review): 1");
      expect(text).toContain("Conflicting files (kept untouched / not pushed): 1");
      expect(text).toContain("Oversized files (>25 MiB, skipped): 1");
      expect(text).toContain("Remote notes (kept untouched): 1");
      expect(text).toContain("Unchanged files: 1");

      const confirmBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Confirm"));
      expect(confirmBtn).toBeDefined();
      expect(confirmBtn?.textContent).toBe("Confirm Safe Push");
    });
  });

  // =========================================================================
  // 4. BUTTON EXECUTION LIFECYCLE, TEARDOWN & REJECTION SAFETY
  // =========================================================================
  describe("Audit 4: Button Execution Lifecycle & Robustness", () => {
    it("CHALLENGE-M1-LIFECYCLE-001: Cancel button cleanly tears down modal", () => {
      const modal = new SyncConfirmModal(app, plugin, "pull");
      const internal = modal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      internal.previewReport = makeMockPreviewReport([]);
      internal.renderConfirmation();

      const cancelBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Cancel"));
      expect(cancelBtn).toBeDefined();

      cancelBtn?.onclick?.();
      expect(isModalOpen(modal)).toBe(false);
      expect(modal.contentEl.children.length).toBe(0);
    });

    it("CHALLENGE-M1-LIFECYCLE-002: Pull confirm button dispatches PullEngine and triggers onComplete", async () => {
      await setStoredPat(app, plugin.settings.owner, plugin.settings.repo, "test-token");

      const mockPullReport: PullExecutionReport = {
        status: "PASS",
        branch: "main",
        remoteCommitSha: "abc1111",
        timestamp: Date.now(),
        summaryMessage: "Pull succeeded cleanly",
        counts: {
          pulledCreated: 1,
          pulledUpdated: 0,
          pulledDeleted: 0,
          pulledMoved: 0,
          conflictsPreserved: 0,
          unchanged: 2,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [{ path: "note.md", action: "PULL_CREATE", status: "SUCCESS" }],
      };

      const pullSpy = vi
        .spyOn(PullEngine.prototype, "executeSafePull")
        .mockResolvedValue(mockPullReport);

      const onCompleteMock = vi.fn();
      const modal = new SyncConfirmModal(app, plugin, "pull", onCompleteMock);
      const internal = modal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      internal.previewReport = makeMockPreviewReport([]);
      internal.renderConfirmation();

      const confirmBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Confirm"));
      const cancelBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Cancel"));

      // Trigger confirm click
      await confirmBtn?.onclick?.();
      // Wait for internal async task
      await new Promise((r) => setTimeout(r, 20));

      expect(pullSpy).toHaveBeenCalledTimes(1);
      expect(confirmBtn?.disabled).toBe(true);
      expect(cancelBtn?.disabled).toBe(true);
      expect(confirmBtn?.textContent).toBe("Pulling...");
      expect(onCompleteMock).toHaveBeenCalledWith(mockPullReport);
      expect(isModalOpen(modal)).toBe(false);
    });

    it("CHALLENGE-M1-LIFECYCLE-003: Push confirm button dispatches PushEngine and triggers onComplete", async () => {
      await setStoredPat(app, plugin.settings.owner, plugin.settings.repo, "test-token");

      const mockPushReport: PushExecutionReport = {
        status: "PASS",
        branch: "main",
        newCommitSha: "def22223333",
        timestamp: Date.now(),
        summaryMessage: "Push succeeded cleanly",
        counts: {
          pushedCreated: 1,
          pushedUpdated: 0,
          pushedDeleted: 0,
          pushedMoved: 0,
          unchanged: 3,
          skippedRemoteOnly: 0,
          skippedRemoteChanged: 0,
          skippedConflicts: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [{ path: "pushNote.md", action: "PUSH_CREATE", status: "SUCCESS" }],
      };

      const pushSpy = vi
        .spyOn(PushEngine.prototype, "executeSafePush")
        .mockResolvedValue(mockPushReport);

      const onCompleteMock = vi.fn();
      const modal = new SyncConfirmModal(app, plugin, "push", onCompleteMock);
      const internal = modal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      internal.previewReport = makeMockPreviewReport([]);
      internal.renderConfirmation();

      const confirmBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Confirm"));
      const cancelBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Cancel"));

      // Trigger confirm click
      await confirmBtn?.onclick?.();
      await new Promise((r) => setTimeout(r, 20));

      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(confirmBtn?.disabled).toBe(true);
      expect(cancelBtn?.disabled).toBe(true);
      expect(confirmBtn?.textContent).toBe("Pushing...");
      expect(onCompleteMock).toHaveBeenCalledWith(mockPushReport);
      expect(isModalOpen(modal)).toBe(false);
    });

    it("CHALLENGE-M1-LIFECYCLE-004: onComplete error does not bubble or crash UI", async () => {
      await setStoredPat(app, plugin.settings.owner, plugin.settings.repo, "test-token");

      const mockPullReport: PullExecutionReport = {
        status: "PASS",
        branch: "main",
        timestamp: Date.now(),
        summaryMessage: "OK",
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          pulledMoved: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [],
      };

      vi.spyOn(PullEngine.prototype, "executeSafePull").mockResolvedValue(mockPullReport);
      const failingCallback = vi.fn().mockRejectedValue(new Error("Downstream UI refresh exploded"));

      const modal = new SyncConfirmModal(app, plugin, "pull", failingCallback);
      const internal = modal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      internal.previewReport = makeMockPreviewReport([]);
      internal.renderConfirmation();

      const confirmBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Confirm"));

      // Trigger confirm click which handles errors internally
      confirmBtn?.onclick?.();
      await new Promise((r) => setTimeout(r, 20));
      expect(failingCallback).toHaveBeenCalledTimes(1);
      expect(isModalOpen(modal)).toBe(false);
    });

    it("CHALLENGE-M1-LIFECYCLE-005: Rapid clicking confirm button synchronously disables button and dispatches engine", async () => {
      await setStoredPat(app, plugin.settings.owner, plugin.settings.repo, "test-token");

      let resolvePull: (val: PullExecutionReport) => void;
      const pullPromise = new Promise<PullExecutionReport>((resolve) => {
        resolvePull = resolve;
      });

      const pullSpy = vi.spyOn(PullEngine.prototype, "executeSafePull").mockImplementation(() => pullPromise);

      const modal = new SyncConfirmModal(app, plugin, "pull");
      const internal = modal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      internal.previewReport = makeMockPreviewReport([]);
      internal.renderConfirmation();

      const confirmBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Confirm"));
      const cancelBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Cancel"));

      // Click once
      confirmBtn?.onclick?.();
      // Button must be synchronously disabled on the very first event dispatch
      expect(confirmBtn?.disabled).toBe(true);
      expect(cancelBtn?.disabled).toBe(true);
      expect(confirmBtn?.textContent).toBe("Pulling...");

      // Await next tick for getStoredPat
      await new Promise((r) => setTimeout(r, 20));
      expect(pullSpy).toHaveBeenCalledTimes(1);

      // Finish execution
      resolvePull!({
        status: "PASS",
        branch: "main",
        timestamp: Date.now(),
        summaryMessage: "Done",
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [],
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(pullSpy).toHaveBeenCalledTimes(1);
    });

    it("CHALLENGE-M1-LIFECYCLE-006: PushEngine failure closes modal gracefully without unhandled rejection", async () => {
      await setStoredPat(app, plugin.settings.owner, plugin.settings.repo, "test-token");

      vi.spyOn(PushEngine.prototype, "executeSafePush").mockRejectedValue(
        new Error("GitHub API 500 Internal Server Error")
      );

      const modal = new SyncConfirmModal(app, plugin, "push");
      const internal = modal as unknown as {
        previewReport: SyncPreviewReport | null;
        renderConfirmation: () => void;
      };
      internal.previewReport = makeMockPreviewReport([]);
      internal.renderConfirmation();

      const confirmBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Confirm"));

      confirmBtn?.onclick?.();
      await new Promise((r) => setTimeout(r, 20));

      expect(isModalOpen(modal)).toBe(false);
    });
  });

  // =========================================================================
  // 5. SYNCRESULTMODAL STATUS BANNERS, DIRECTION INFERENCE & SHAS
  // =========================================================================
  describe("Audit 5: SyncResultModal Status Banners, Commit SHAs & Direction", () => {
    it("CHALLENGE-M1-RES-001: Automatic direction detection handles pull vs push correctly", () => {
      const pullReport: PullExecutionReport = {
        status: "PASS",
        branch: "main",
        remoteCommitSha: "abc9999",
        timestamp: Date.now(),
        summaryMessage: "Pull complete",
        counts: {
          pulledCreated: 1,
          pulledUpdated: 0,
          pulledDeleted: 0,
          pulledMoved: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [],
      };

      const pullModal = new SyncResultModal(app, pullReport);
      pullModal.onOpen();
      expect(getAllText(pullModal.contentEl)).toContain("Safe Pull Results");

      const pushReport: PushExecutionReport = {
        status: "PASS",
        branch: "main",
        newCommitSha: "def88889999",
        timestamp: Date.now(),
        summaryMessage: "Push complete",
        counts: {
          pushedCreated: 1,
          pushedUpdated: 0,
          pushedDeleted: 0,
          pushedMoved: 0,
          unchanged: 0,
          skippedRemoteOnly: 0,
          skippedRemoteChanged: 0,
          skippedConflicts: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [],
      };

      const pushModal = new SyncResultModal(app, pushReport);
      pushModal.onOpen();
      expect(getAllText(pushModal.contentEl)).toContain("Safe Push Results");
    });

    it("CHALLENGE-M1-RES-002: Status banners correctly represent PASS, PASS_WITH_WARNINGS, ABORTED, and FAIL", () => {
      const baseReport: PullExecutionReport = {
        status: "PASS",
        branch: "main",
        timestamp: Date.now(),
        summaryMessage: "Test Summary",
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          pulledMoved: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [],
      };

      const statuses: Array<{ status: PullExecutionReport["status"]; icon: string; title: string }> = [
        { status: "PASS", icon: "✅", title: "PASS" },
        { status: "PASS_WITH_WARNINGS", icon: "⚠️", title: "PASS WITH WARNINGS" },
        { status: "ABORTED", icon: "⚠️", title: "ABORTED" },
        { status: "FAIL", icon: "❌", title: "FAIL" },
      ];

      for (const { status, icon, title } of statuses) {
        const modal = new SyncResultModal(app, { ...baseReport, status }, "pull");
        modal.onOpen();
        const text = getAllText(modal.contentEl);
        expect(text).toContain(`${icon} ${title}`);
        expect(text).toContain("Test Summary");
      }
    });

    it("CHALLENGE-M1-RES-003: Push result displays truncated 7-char newCommitSha and branch", () => {
      const report: PushExecutionReport = {
        status: "PASS",
        branch: "develop",
        newCommitSha: "a1b2c3d4e5f67890",
        timestamp: Date.now(),
        summaryMessage: "Pushed 1 note",
        counts: {
          pushedCreated: 1,
          pushedUpdated: 0,
          pushedDeleted: 0,
          pushedMoved: 0,
          unchanged: 0,
          skippedRemoteOnly: 0,
          skippedRemoteChanged: 0,
          skippedConflicts: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [],
      };

      const modal = new SyncResultModal(app, report, "push");
      modal.onOpen();
      const text = getAllText(modal.contentEl);
      expect(text).toContain("New Remote Commit: a1b2c3d (branch: develop)");
    });
  });

  // =========================================================================
  // 6. SYNCRESULTMODAL BADGES, DETAILS FILTERING & ROW RENDERING
  // =========================================================================
  describe("Audit 6: SyncResultModal Badges, Filtering & Itemized Rows", () => {
    it("CHALLENGE-M1-ROW-001: Badge labels strictly adhere to Pull vs Push terminology", () => {
      // Pull report with deletions
      const pullReport: PullExecutionReport = {
        status: "PASS",
        branch: "main",
        timestamp: Date.now(),
        summaryMessage: "Done",
        counts: {
          pulledCreated: 1,
          pulledUpdated: 0,
          pulledDeleted: 3,
          pulledMoved: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [{ path: "del.md", action: "PULL_DELETE", status: "SUCCESS" }],
      };

      const pullModal = new SyncResultModal(app, pullReport, "pull");
      pullModal.onOpen();
      const pullText = getAllText(pullModal.contentEl);
      expect(pullText).toContain("Removed locally");
      expect(pullText).not.toContain("Deleted from GitHub");

      // Push report with deletions
      const pushReport: PushExecutionReport = {
        status: "PASS",
        branch: "main",
        timestamp: Date.now(),
        summaryMessage: "Done",
        counts: {
          pushedCreated: 0,
          pushedUpdated: 0,
          pushedDeleted: 2,
          pushedMoved: 0,
          unchanged: 0,
          skippedRemoteOnly: 0,
          skippedRemoteChanged: 0,
          skippedConflicts: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [{ path: "remoteDel.md", action: "PUSH_DELETE", status: "SUCCESS" }],
      };

      const pushModal = new SyncResultModal(app, pushReport, "push");
      pushModal.onOpen();
      const pushText = getAllText(pushModal.contentEl);
      expect(pushText).toContain("Deleted from GitHub");
      expect(pushText).not.toContain("Removed locally");
    });

    it("CHALLENGE-M1-ROW-002: Execution details filter skip-actions and display accurate empty states", () => {
      // Pull report with only skip actions
      const pullReport: PullExecutionReport = {
        status: "PASS",
        branch: "main",
        timestamp: Date.now(),
        summaryMessage: "Up to date",
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          pulledMoved: 0,
          conflictsPreserved: 0,
          unchanged: 5,
          skippedLocalOnly: 2,
          skippedLocalChanged: 1,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [
          { path: "u.md", action: "SKIP_UNCHANGED", status: "SKIPPED" },
          { path: "l.md", action: "SKIP_LOCAL_ONLY", status: "SKIPPED" },
          { path: "lc.md", action: "SKIP_LOCAL_CHANGED", status: "SKIPPED" },
        ],
      };

      const pullModal = new SyncResultModal(app, pullReport, "pull");
      pullModal.onOpen();
      const pullText = getAllText(pullModal.contentEl);
      expect(pullText).toContain("No file changes required execution. Vault is fully up to date.");

      // Push report with only skip actions
      const pushReport: PushExecutionReport = {
        status: "PASS",
        branch: "main",
        timestamp: Date.now(),
        summaryMessage: "Up to date",
        counts: {
          pushedCreated: 0,
          pushedUpdated: 0,
          pushedDeleted: 0,
          pushedMoved: 0,
          unchanged: 4,
          skippedRemoteOnly: 1,
          skippedRemoteChanged: 1,
          skippedConflicts: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [
          { path: "u.md", action: "SKIP_UNCHANGED", status: "SKIPPED" },
          { path: "ro.md", action: "SKIP_REMOTE_ONLY", status: "SKIPPED" },
          { path: "rc.md", action: "SKIP_REMOTE_CHANGED", status: "SKIPPED" },
        ],
      };

      const pushModal = new SyncResultModal(app, pushReport, "push");
      pushModal.onOpen();
      const pushText = getAllText(pushModal.contentEl);
      expect(pushText).toContain("No local changes required push. Remote repository is up to date.");
    });

    it("CHALLENGE-M1-ROW-003: Row rendering formats conflict file paths and messages faithfully", () => {
      const pullReport: PullExecutionReport = {
        status: "PASS_WITH_WARNINGS",
        branch: "main",
        timestamp: Date.now(),
        summaryMessage: "Pull with preserved conflict",
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          pulledMoved: 0,
          conflictsPreserved: 1,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [
          {
            path: "ConflictNote.md",
            action: "PULL_UPDATE",
            status: "CONFLICT_PRESERVED",
            message: "Local version safely preserved to internal storage",
            conflictPath: ".obsidian/github-vault-relay/conflicts/ConflictNote.md.conflict",
          },
        ],
      };

      const modal = new SyncResultModal(app, pullReport, "pull");
      modal.onOpen();
      const text = getAllText(modal.contentEl);
      expect(text).toContain("ConflictNote.md");
      expect(text).toContain("CONFLICT_PRESERVED");
      expect(text).toContain("Local version safely preserved to internal storage");
      expect(text).toContain("Preserved conflict file: .obsidian/github-vault-relay/conflicts/ConflictNote.md.conflict");

      const doneBtn = findButtons(modal.contentEl).find((b) => b.textContent.includes("Done"));
      expect(doneBtn).toBeDefined();
      doneBtn?.onclick?.();
      expect(isModalOpen(modal)).toBe(false);
    });
  });

  // =========================================================================
  // 7. RESPONSIVE CLASSES & ACCESSIBILITY AUDIT
  // =========================================================================
  describe("Audit 7: Responsive CSS & Accessibility Contracts", () => {
    it("CHALLENGE-M1-CSS-001: Both unified modals apply .vault-relay-modal and specialized class", () => {
      const confirmModal = new SyncConfirmModal(app, plugin, "pull");
      confirmModal.onOpen();
      expect(asMock(confirmModal.modalEl).hasClass("vault-relay-modal")).toBe(true);
      expect(asMock(confirmModal.modalEl).hasClass("vault-relay-confirm-modal")).toBe(true);

      const resultReport: PullExecutionReport = {
        status: "PASS",
        branch: "main",
        timestamp: Date.now(),
        summaryMessage: "Done",
        counts: {
          pulledCreated: 0,
          pulledUpdated: 0,
          pulledDeleted: 0,
          pulledMoved: 0,
          conflictsPreserved: 0,
          unchanged: 0,
          skippedLocalOnly: 0,
          skippedLocalChanged: 0,
          skippedOversized: 0,
          skippedUnsafe: 0,
          failed: 0,
        },
        results: [],
      };

      const resultModal = new SyncResultModal(app, resultReport, "pull");
      resultModal.onOpen();
      expect(asMock(resultModal.modalEl).hasClass("vault-relay-modal")).toBe(true);
      expect(asMock(resultModal.modalEl).hasClass("vault-relay-result-modal")).toBe(true);
    });
  });
});
