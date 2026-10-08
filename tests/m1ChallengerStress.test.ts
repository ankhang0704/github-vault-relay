/**
 * Milestone 1 Empirical Stress Test Suite (tests/m1ChallengerStress.test.ts)
 *
 * Adversarially challenges:
 * 1. Touch target compliance (44px min) & button styling classes.
 * 2. Modal styling class attachment on open.
 * 3. Truncated tree conditions & execution blocking.
 * 4. Missing tokens & secure storage handling.
 * 5. API error handling during preflight and execution.
 * 6. Zero changes edge cases.
 * 7. Command invocations for pull-safe-changes, push-safe-changes, etc.
 * 8. Status banner & badge fidelity in SyncResultModal.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import fs from "node:fs";
import path from "node:path";
import VaultRelayPlugin from "../src/main";
import { SyncConfirmModal } from "../src/ui/syncConfirmModal";
import { SyncResultModal } from "../src/ui/syncResultModal";
import {
  SyncPreviewItem,
  SyncPreviewReport,
  PullExecutionReport,
  PushExecutionReport,
} from "../src/sync/syncTypes";
import * as secretStore from "../src/security/secretStore";
import { SyncEngine } from "../src/sync/syncEngine";
import { PullEngine } from "../src/sync/pullEngine";
import { PushEngine } from "../src/sync/pushEngine";
import { MockElement, CommandConfig } from "./__mocks__/obsidian";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function getAllText(el: MockElement | { textContent?: string; children?: MockElement[] }): string {
  let res = el?.textContent || "";
  if (el?.children) {
    for (const child of el.children) {
      res += " " + getAllText(child);
    }
  }
  return res;
}

interface ModalInternalWithPreview {
  previewReport?: SyncPreviewReport | null;
  isLoading?: boolean;
  renderConfirmation?: () => void;
  renderError?: (msg: string) => void;
  runPreflight?: () => Promise<void>;
}

describe("Milestone 1 Adversarial Stress Tests", () => {
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
      repo: "vault-notes",
      branch: "main",
      excludedPaths: [".obsidian/", ".git/", "_fit/"],
    };
  });

  function makeMockReport(items: SyncPreviewItem[], truncated = false): SyncPreviewReport {
    return {
      timestamp: Date.now(),
      branch: "main",
      items,
      counts: {
        LOCAL_ONLY: 0,
        LOCAL_CHANGED: 0,
        LOCAL_DELETED: 0,
        REMOTE_ONLY: 0,
        REMOTE_CHANGED: 0,
        REMOTE_DELETED: 0,
        POTENTIAL_CONFLICT: 0,
        DELETE_CONFLICT: 0,
        DELETED: 0,
        UNCHANGED: items.length,
        OVERSIZED: 0,
        UNSAFE: 0,
      },
      totalScannedLocal: items.length,
      totalScannedRemote: items.length,
      truncatedRemoteTree: truncated,
      caseCollisions: [],
    };
  }

  // =========================================================================
  // 1. TOUCH TARGET & ACCESSIBILITY AUDIT (44px min)
  // =========================================================================

  it("CHALLENGE-TOUCH-001: Stylesheet enforces min 44px tap targets for buttons and action layout", () => {
    const css = read("styles.css");

    // Modal buttons must have min 44px height and width
    expect(css).toMatch(/\.vault-relay-modal\s+button[\s\S]*?min-height:\s*44px/);
    expect(css).toMatch(/\.vault-relay-modal\s+button[\s\S]*?min-width:\s*44px/);

    // .vault-relay-btn-lg must have min-height 44px
    expect(css).toMatch(/\.vault-relay-btn-lg\s*\{[^}]*min-height:\s*44px/);

    // Media query < 480px must stack action buttons
    expect(css).toMatch(/@media\s*\(max-width:\s*480px\)[\s\S]*?\.vault-relay-action-row\s+button\s*\{[^}]*width:\s*100%/);
  });

  it("CHALLENGE-TOUCH-002: SyncConfirmModal buttons strictly comply with 44px min dimensions", () => {
    const report = makeMockReport([
      { path: "note1.md", category: "REMOTE_ONLY", remoteSha: "sha1" },
    ]);

    const modal = new SyncConfirmModal(app, plugin, "pull");
    const internal = modal as unknown as ModalInternalWithPreview;
    internal.previewReport = report;
    internal.isLoading = false;
    internal.renderConfirmation?.();

    const buttons = (modal.contentEl as unknown as MockElement).findAll((el) => el.tag === "button");
    expect(buttons.length).toBe(2);

    const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
    expect(cancelBtn).toBeDefined();
    expect(cancelBtn?.hasClass("vault-relay-btn-lg")).toBe(true);

    const confirmBtn = buttons.find((b) => b.textContent === "Confirm Safe Pull");
    expect(confirmBtn).toBeDefined();
    const confirmClasses = Array.from(confirmBtn?.classes ?? []).join(" ");
    expect(confirmClasses).toContain("vault-relay-btn-lg");
    expect(confirmClasses).toContain("mod-cta");
  });

  it("CHALLENGE-TOUCH-003: SyncConfirmModal error state close button has min 44px tap target", () => {
    const modal = new SyncConfirmModal(app, plugin, "push");
    const internal = modal as unknown as ModalInternalWithPreview;
    internal.renderError?.("Network connection timed out");

    const buttons = (modal.contentEl as unknown as MockElement).findAll((el) => el.tag === "button");
    expect(buttons.length).toBe(1);

    const closeBtn = buttons[0];
    expect(closeBtn.textContent).toBe("Close");
    expect(closeBtn.hasClass("vault-relay-btn-lg")).toBe(true);
  });

  it("CHALLENGE-TOUCH-004: SyncResultModal close button strictly complies with 44px min dimensions", () => {
    const report: PullExecutionReport = {
      status: "PASS",
      branch: "main",
      remoteCommitSha: "sha123",
      timestamp: Date.now(),
      summaryMessage: "Sync succeeded",
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
      results: [{ path: "note1.md", action: "PULL_CREATE", status: "SUCCESS" }],
    };

    const modal = new SyncResultModal(app, report, "pull");
    modal.onOpen();

    const buttons = (modal.contentEl as unknown as MockElement).findAll((el) => el.tag === "button");
    expect(buttons.length).toBe(1);

    const doneBtn = buttons[0];
    expect(doneBtn.textContent).toBe("Done");
    expect(doneBtn.hasClass("vault-relay-btn-lg")).toBe(true);
  });

  // =========================================================================
  // 2. MODAL STYLING CLASS ATTACHMENT ON OPEN
  // =========================================================================

  it("CHALLENGE-CLASS-001: SyncConfirmModal attaches vault-relay-modal and vault-relay-confirm-modal", () => {
    vi.spyOn(secretStore, "getStoredPat").mockResolvedValue("test-token");
    vi.spyOn(SyncEngine.prototype, "generatePreview").mockResolvedValue(makeMockReport([]));

    const pullModal = new SyncConfirmModal(app, plugin, "pull");
    pullModal.onOpen();
    expect((pullModal.modalEl as unknown as MockElement).hasClass("vault-relay-modal")).toBe(true);
    expect((pullModal.modalEl as unknown as MockElement).hasClass("vault-relay-confirm-modal")).toBe(true);

    const pushModal = new SyncConfirmModal(app, plugin, "push");
    pushModal.onOpen();
    expect((pushModal.modalEl as unknown as MockElement).hasClass("vault-relay-modal")).toBe(true);
    expect((pushModal.modalEl as unknown as MockElement).hasClass("vault-relay-confirm-modal")).toBe(true);
  });

  it("CHALLENGE-CLASS-002: SyncResultModal attaches vault-relay-modal and vault-relay-result-modal", () => {
    const pullReport: PullExecutionReport = {
      status: "PASS",
      branch: "main",
      remoteCommitSha: "sha1",
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

    const modalWithExplicitDir = new SyncResultModal(app, pullReport, "pull");
    modalWithExplicitDir.onOpen();
    expect((modalWithExplicitDir.modalEl as unknown as MockElement).hasClass("vault-relay-modal")).toBe(true);
    expect((modalWithExplicitDir.modalEl as unknown as MockElement).hasClass("vault-relay-result-modal")).toBe(true);

    const pushReport: PushExecutionReport = {
      status: "PASS",
      branch: "main",
      newCommitSha: "newsha123",
      timestamp: Date.now(),
      summaryMessage: "Done",
      counts: {
        pushedCreated: 0,
        pushedUpdated: 0,
        pushedDeleted: 0,
        pushedMoved: 0,
        skippedConflicts: 0,
        unchanged: 0,
        skippedRemoteOnly: 0,
        skippedRemoteChanged: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      results: [],
    };

    const modalWithAutoDetect = new SyncResultModal(app, pushReport);
    modalWithAutoDetect.onOpen();
    expect((modalWithAutoDetect.modalEl as unknown as MockElement).hasClass("vault-relay-modal")).toBe(true);
    expect((modalWithAutoDetect.modalEl as unknown as MockElement).hasClass("vault-relay-result-modal")).toBe(true);
  });

  // =========================================================================
  // 3. TRUNCATED REMOTE TREE POLICY (Adversarial Safety Block)
  // =========================================================================

  it("CHALLENGE-TRUNCATED-001: Truncated Git tree (>100k items) blocks Safe Pull without rendering confirm button", () => {
    const report = makeMockReport([], true); // truncatedRemoteTree = true

    const modal = new SyncConfirmModal(app, plugin, "pull");
    const internal = modal as unknown as ModalInternalWithPreview;
    internal.previewReport = report;
    internal.isLoading = false;
    internal.renderConfirmation?.();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("🚫 Safe pull blocked: Truncated Git tree");
    expect(text).toContain(">100,000 items");
    expect(text).toContain("Safe pull cannot proceed to avoid partial synchronization");

    // Must NOT render confirm button
    const buttons = (modal.contentEl as unknown as MockElement).findAll((el) => el.tag === "button");
    const confirmBtn = buttons.find((b) => b.textContent?.includes("Confirm"));
    expect(confirmBtn).toBeUndefined();
  });

  it("CHALLENGE-TRUNCATED-002: Truncated Git tree (>100k items) blocks Safe Push without rendering confirm button", () => {
    const report = makeMockReport([], true); // truncatedRemoteTree = true

    const modal = new SyncConfirmModal(app, plugin, "push");
    const internal = modal as unknown as ModalInternalWithPreview;
    internal.previewReport = report;
    internal.isLoading = false;
    internal.renderConfirmation?.();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("🚫 Safe Push Blocked: Truncated Git Tree");
    expect(text).toContain(">100,000 items");
    expect(text).toContain("Safe push cannot proceed to avoid partial synchronization");

    // Must NOT render confirm button
    const buttons = (modal.contentEl as unknown as MockElement).findAll((el) => el.tag === "button");
    const confirmBtn = buttons.find((b) => b.textContent?.includes("Confirm"));
    expect(confirmBtn).toBeUndefined();
  });

  // =========================================================================
  // 4. MISSING TOKEN & PREFLIGHT ERROR HANDLING
  // =========================================================================

  it("CHALLENGE-TOKEN-001: Missing PAT shows preflight error and safe Close button without crash", async () => {
    vi.spyOn(secretStore, "getStoredPat").mockResolvedValue(null);

    const modal = new SyncConfirmModal(app, plugin, "pull");
    modal.onOpen();

    // Allow runPreflight promise to resolve
    await Promise.resolve();
    await Promise.resolve();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("Preflight check failed");
    expect(text).toContain("No GitHub PAT found in secure storage. Please configure settings first.");

    const closeBtn = (modal.contentEl as unknown as MockElement).findAll((el) => el.tag === "button")[0];
    expect(closeBtn).toBeDefined();
    expect(closeBtn.textContent).toBe("Close");

    const closeSpy = vi.spyOn(modal, "close");
    closeBtn.onclick?.();
    expect(closeSpy).toHaveBeenCalled();
  });

  it("CHALLENGE-API-001: Preflight API exception is sanitized and rendered with notice", async () => {
    vi.spyOn(secretStore, "getStoredPat").mockResolvedValue("test-token");
    vi.spyOn(SyncEngine.prototype, "generatePreview").mockRejectedValue(
      new Error("API rate limit exceeded for token ghp_1234567890abcdef1234567890abcdef1234")
    );

    const modal = new SyncConfirmModal(app, plugin, "push");
    modal.onOpen();

    // Allow preflight promise to catch error
    await Promise.resolve();
    await Promise.resolve();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("Preflight Check Failed");
    // Token must be redacted
    expect(text).not.toContain("ghp_1234567890abcdef1234567890abcdef1234");
    expect(text).toContain("[REDACTED_TOKEN]");

    const buttons = (modal.contentEl as unknown as MockElement).findAll((el) => el.tag === "button");
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toBe("Close");
  });

  // =========================================================================
  // 5. EXECUTION ERROR RESILIENCE
  // =========================================================================

  it("CHALLENGE-EXEC-001: Execution network error during Safe Pull closes modal cleanly", async () => {
    vi.spyOn(secretStore, "getStoredPat").mockResolvedValue("test-token");
    vi.spyOn(PullEngine.prototype, "executeSafePull").mockRejectedValue(
      new Error("GitHub 503 Server Unavailable")
    );

    const report = makeMockReport([
      { path: "note1.md", category: "REMOTE_ONLY", remoteSha: "sha1" },
    ]);

    const modal = new SyncConfirmModal(app, plugin, "pull");
    const internal = modal as unknown as ModalInternalWithPreview;
    internal.previewReport = report;
    internal.isLoading = false;
    internal.renderConfirmation?.();

    const buttons = (modal.contentEl as unknown as MockElement).findAll((el) => el.tag === "button");
    const confirmBtn = buttons.find((b) => b.textContent === "Confirm Safe Pull");
    expect(confirmBtn).toBeDefined();

    const closeSpy = vi.spyOn(modal, "close");
    confirmBtn?.onclick?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Modal must be closed cleanly
    expect(closeSpy).toHaveBeenCalled();
  });

  it("CHALLENGE-EXEC-002: Execution conflict error during Safe Push closes modal cleanly", async () => {
    vi.spyOn(secretStore, "getStoredPat").mockResolvedValue("test-token");
    vi.spyOn(PushEngine.prototype, "executeSafePush").mockRejectedValue(
      new Error("Remote ref moved concurrently (409 Conflict)")
    );

    const report = makeMockReport([
      { path: "local.md", category: "LOCAL_ONLY", localSha: "sha1" },
    ]);

    const modal = new SyncConfirmModal(app, plugin, "push");
    const internal = modal as unknown as ModalInternalWithPreview;
    internal.previewReport = report;
    internal.isLoading = false;
    internal.renderConfirmation?.();

    const buttons = (modal.contentEl as unknown as MockElement).findAll((el) => el.tag === "button");
    const confirmBtn = buttons.find((b) => b.textContent === "Confirm Safe Push");
    expect(confirmBtn).toBeDefined();

    const pushCloseSpy = vi.spyOn(modal, "close");
    confirmBtn?.onclick?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Modal must be closed cleanly
    expect(pushCloseSpy).toHaveBeenCalled();
  });

  // =========================================================================
  // 6. ZERO CHANGES EDGE CASES
  // =========================================================================

  it("CHALLENGE-ZERO-001: Preflight zero changes renders zero counts cleanly without destructive warnings", () => {
    const report = makeMockReport([]); // 0 items

    const modal = new SyncConfirmModal(app, plugin, "pull");
    const internal = modal as unknown as ModalInternalWithPreview;
    internal.previewReport = report;
    internal.isLoading = false;
    internal.renderConfirmation?.();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("New files to create locally: 0");
    expect(text).toContain("Files to update locally: 0");
    expect(text).toContain("Unchanged files: 0");
    expect(text).not.toContain("Files to remove locally");
  });

  it("CHALLENGE-ZERO-002: SyncResultModal displays truthful zero-state text for pull", () => {
    const report: PullExecutionReport = {
      status: "PASS",
      branch: "main",
      remoteCommitSha: "sha1",
      timestamp: Date.now(),
      summaryMessage: "Vault is fully up to date",
      counts: {
        pulledCreated: 0,
        pulledUpdated: 0,
        pulledDeleted: 0,
        pulledMoved: 0,
        conflictsPreserved: 0,
        unchanged: 15,
        skippedLocalOnly: 0,
        skippedLocalChanged: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      results: [{ path: "unchanged.md", action: "SKIP_UNCHANGED", status: "SKIPPED" }],
    };

    const modal = new SyncResultModal(app, report, "pull");
    modal.onOpen();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("No file changes required execution. Vault is fully up to date.");
  });

  it("CHALLENGE-ZERO-003: SyncResultModal displays truthful zero-state text for push", () => {
    const report: PushExecutionReport = {
      status: "PASS",
      branch: "main",
      newCommitSha: "sha1",
      timestamp: Date.now(),
      summaryMessage: "Remote repository is up to date",
      counts: {
        pushedCreated: 0,
        pushedUpdated: 0,
        pushedDeleted: 0,
        pushedMoved: 0,
        skippedConflicts: 0,
        unchanged: 20,
        skippedRemoteOnly: 0,
        skippedRemoteChanged: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      results: [{ path: "unchanged.md", action: "SKIP_UNCHANGED", status: "SKIPPED" }],
    };

    const modal = new SyncResultModal(app, report, "push");
    modal.onOpen();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("No local changes required push. Remote repository is up to date.");
  });

  // =========================================================================
  // 7. OBSIDIAN COMMAND INVOCATIONS
  // =========================================================================

  it("CHALLENGE-CMD-001: Plugin command pull-safe-changes instantiates SyncConfirmModal without runtime crash", async () => {
    const commands: CommandConfig[] = [];
    vi.spyOn(plugin, "addCommand").mockImplementation((cmd: CommandConfig) => {
      commands.push(cmd);
      return cmd;
    });

    await plugin.onload();

    const pullCmd = commands.find((c) => c.id === "pull-safe-changes");
    expect(pullCmd).toBeDefined();

    expect(() => {
      pullCmd?.callback?.();
    }).not.toThrow();
  });

  it("CHALLENGE-CMD-002: Plugin command push-safe-changes instantiates SyncConfirmModal without runtime crash", async () => {
    const commands: CommandConfig[] = [];
    vi.spyOn(plugin, "addCommand").mockImplementation((cmd: CommandConfig) => {
      commands.push(cmd);
      return cmd;
    });

    await plugin.onload();

    const pushCmd = commands.find((c) => c.id === "push-safe-changes");
    expect(pushCmd).toBeDefined();

    expect(() => {
      pushCmd?.callback?.();
    }).not.toThrow();
  });

  // =========================================================================
  // 8. RESULT MODAL STATUS BANNER & BADGE FIDELITY
  // =========================================================================

  it("CHALLENGE-STATUS-001: SyncResultModal renders honest banners for all execution statuses", () => {
    const baseCounts = {
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
    };

    const statuses = ["PASS", "PASS_WITH_WARNINGS", "ABORTED", "FAIL"] as const;

    for (const status of statuses) {
      const report: PullExecutionReport = {
        status,
        branch: "main",
        remoteCommitSha: "sha1",
        timestamp: Date.now(),
        summaryMessage: `Operation resulted in ${status}`,
        counts: baseCounts,
        results: [],
      };

      const modal = new SyncResultModal(app, report, "pull");
      modal.onOpen();

      const text = getAllText(modal.contentEl as unknown as MockElement);
      if (status === "PASS") {
        expect(text).toContain("✅ PASS");
      } else if (status === "PASS_WITH_WARNINGS") {
        expect(text).toContain("⚠️ PASS WITH WARNINGS");
      } else if (status === "ABORTED") {
        expect(text).toContain("⚠️ ABORTED");
      } else if (status === "FAIL") {
        expect(text).toContain("❌ FAIL");
      }
    }
  });

  it("CHALLENGE-STATUS-002: Push result shows new commit SHA and deleted from GitHub badge", () => {
    const report: PushExecutionReport = {
      status: "PASS",
      branch: "main",
      newCommitSha: "a1b2c3d4e5f67890",
      timestamp: Date.now(),
      summaryMessage: "Push complete",
      counts: {
        pushedCreated: 1,
        pushedUpdated: 0,
        pushedDeleted: 2,
        pushedMoved: 0,
        skippedConflicts: 0,
        unchanged: 10,
        skippedRemoteOnly: 0,
        skippedRemoteChanged: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      results: [
        { path: "deleted1.md", action: "PUSH_DELETE", status: "SUCCESS" },
        { path: "deleted2.md", action: "PUSH_DELETE", status: "SUCCESS" },
      ],
    };

    const modal = new SyncResultModal(app, report, "push");
    modal.onOpen();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("New Remote Commit: a1b2c3d");
    expect(text).toContain("Deleted from GitHub");
    expect(text).toContain("deleted1.md");
    expect(text).toContain("deleted2.md");
  });
});
