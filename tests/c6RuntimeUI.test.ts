/**
 * C6 Runtime UI Regression Test Suite (tests/c6RuntimeUI.test.ts)
 *
 * Verifies that delete and move operations are first-class, explicit,
 * truthful, and mobile-safe across all Vault Relay UI modals.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import fs from "node:fs";
import path from "node:path";
import VaultRelayPlugin from "../src/main";
import { PullConfirmModal } from "../src/ui/pullConfirmModal";
import { PushConfirmModal } from "../src/ui/pushConfirmModal";
import { PullResultModal } from "../src/ui/pullResultModal";
import { PushResultModal } from "../src/ui/pushResultModal";
import { SyncDashboardModal } from "../src/ui/syncDashboardModal";
import { ConflictResolutionModal } from "../src/ui/conflictResolutionModal";
import { SyncPreviewModal } from "../src/ui/syncPreviewModal";
import { computeSemanticPreview, getSemanticCategoryLabel } from "../src/sync/semanticSummary";
import { getPhaseLabel } from "../src/sync/progressTypes";
import {
  SyncPreviewItem,
  SyncPreviewReport,
  SyncCategoryCounts,
  PullExecutionReport,
  PushExecutionReport,
} from "../src/sync/syncTypes";
import { ConflictRecord } from "../src/sync/conflictManager";
import { MockElement } from "./__mocks__/obsidian";

interface ModalInternalWithPreview {
  previewReport?: SyncPreviewReport | null;
  isLoading?: boolean;
  renderConfirmation?: () => void;
}

interface ConflictModalInternal {
  conflicts?: ConflictRecord[];
  render?: () => void;
}

interface DashboardModalInternal {
  report?: SyncPreviewReport | null;
  render?: () => void;
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

describe("C6 — Runtime UI Tests (C6-UI-DEL-001..006, C6-UI-MOVE-001..003, C6-UI-PROGRESS-001..002, C6-UI-MOBILE-001..002, C6-UI-ZERO-001)", () => {
  let app: App;
  let plugin: VaultRelayPlugin;

  beforeEach(() => {
    app = new App();
    plugin = new VaultRelayPlugin(app, {
      id: "github-vault-relay",
      name: "GitHub Vault Relay",
      version: "0.6.0",
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

  function makeEmptyCounts() {
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

  function makeMockReport(items: SyncPreviewItem[], countsPartial: Partial<SyncCategoryCounts> = {}): SyncPreviewReport {
    return {
      timestamp: Date.now(),
      branch: "main",
      items,
      counts: { ...makeEmptyCounts(), ...countsPartial },
      totalScannedLocal: items.length,
      totalScannedRemote: items.length,
      truncatedRemoteTree: false,
      caseCollisions: [],
    };
  }

  // =========================================================================
  // 1. DELETION PRESENTATION & WORDING (C6-UI-DEL-001..006)
  // =========================================================================

  it("C6-UI-DEL-001: Pull Confirm exposes REMOTE_DELETED as 'Files to remove locally'", async () => {
    const report = makeMockReport(
      [
        { path: "deleted1.md", category: "REMOTE_DELETED", remoteSha: undefined, baseSha: "abc1" },
        { path: "deleted2.md", category: "REMOTE_DELETED", remoteSha: undefined, baseSha: "abc2" },
      ],
      { REMOTE_DELETED: 2 }
    );

    const modal = new PullConfirmModal(app, plugin);
    const internal = modal as unknown as ModalInternalWithPreview;
    internal.previewReport = report;
    internal.isLoading = false;
    internal.renderConfirmation?.();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("Files to remove locally: 2");
    expect(text).toContain("trash according to your Obsidian trash settings");
    expect(text).not.toContain("Remote Del");
    expect(text).not.toContain("REMOTE_DELETED");
  });

  it("C6-UI-DEL-002: Push Confirm exposes LOCAL_DELETED as 'Files to delete from GitHub'", async () => {
    const report = makeMockReport(
      [
        { path: "fileA.md", category: "LOCAL_DELETED", localSha: undefined, baseSha: "shaA" },
        { path: "fileB.md", category: "LOCAL_DELETED", localSha: undefined, baseSha: "shaB" },
        { path: "fileC.md", category: "LOCAL_DELETED", localSha: undefined, baseSha: "shaC" },
      ],
      { LOCAL_DELETED: 3 }
    );

    const modal = new PushConfirmModal(app, plugin);
    const internal = modal as unknown as ModalInternalWithPreview;
    internal.previewReport = report;
    internal.isLoading = false;
    internal.renderConfirmation?.();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("Files to delete from GitHub: 3");
    expect(text).toContain("available in Git history");
    expect(text).not.toContain("Local Del");
    expect(text).not.toContain("LOCAL_DELETED");
  });

  it("C6-UI-DEL-003: Pull result reports removed-local count", () => {
    const report: PullExecutionReport = {
      status: "PASS",
      branch: "main",
      remoteCommitSha: "abc1234",
      timestamp: Date.now(),
      summaryMessage: "Pull succeeded",
      counts: {
        pulledCreated: 0,
        pulledUpdated: 0,
        pulledDeleted: 2,
        pulledMoved: 0,
        conflictsPreserved: 0,
        unchanged: 5,
        skippedLocalOnly: 0,
        skippedLocalChanged: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      results: [
        { path: "removed1.md", action: "PULL_DELETE", status: "SUCCESS" },
        { path: "removed2.md", action: "PULL_DELETE", status: "SUCCESS" },
      ],
    };

    const modal = new PullResultModal(app, report);
    modal.onOpen();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("Removed locally");
    expect(text).toContain("2");
    expect(text).toContain("removed1.md");
  });

  it("C6-UI-DEL-004: Push result reports remote-deleted count", () => {
    const report: PushExecutionReport = {
      status: "PASS",
      branch: "main",
      newCommitSha: "def5678",
      timestamp: Date.now(),
      summaryMessage: "Push succeeded",
      counts: {
        pushedCreated: 0,
        pushedUpdated: 0,
        pushedDeleted: 1,
        pushedMoved: 0,
        unchanged: 10,
        skippedRemoteOnly: 0,
        skippedRemoteChanged: 0,
        skippedConflicts: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      results: [{ path: "oldFile.md", action: "PUSH_DELETE", status: "SUCCESS" }],
    };

    const modal = new PushResultModal(app, report);
    modal.onOpen();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("Deleted from GitHub");
    expect(text).toContain("1");
    expect(text).toContain("oldFile.md");
  });

  it("C6-UI-DEL-005: Unified Preview exposes both deletion directions and semantic labels", () => {
    const items: SyncPreviewItem[] = [
      { path: "local_del.md", category: "LOCAL_DELETED", localSha: undefined, baseSha: "b1" },
      { path: "remote_del.md", category: "REMOTE_DELETED", remoteSha: undefined, baseSha: "b2" },
    ];

    expect(getSemanticCategoryLabel("LOCAL_DELETED")).toBe("Delete from GitHub");
    expect(getSemanticCategoryLabel("REMOTE_DELETED")).toBe("Remove locally");

    const sem = computeSemanticPreview(items);
    expect(sem.pushDeleteRemote).toBe(1);
    expect(sem.pullRemoveLocal).toBe(1);
    expect(sem.totalPushMutations).toBe(1);
    expect(sem.totalPullMutations).toBe(1);
  });

  it("C6-UI-DEL-006: Delete conflict uses Keep File / Delete File / Cancel with explicit descriptions", async () => {
    const conflict: ConflictRecord = {
      id: "notes/conflict.md",
      path: "notes/conflict.md",
      conflictType: "DELETE_LOCAL_REMOTE_MODIFIED",
      detectedAt: Date.now(),
      baseSha: "base1",
      localSha: "",
      remoteSha: "remote1",
    };

    const modal = new ConflictResolutionModal(app, plugin, undefined, null);
    const internal = modal as unknown as ConflictModalInternal;
    internal.conflicts = [conflict];
    internal.render?.();

    const text = getAllText(modal.contentEl as unknown as MockElement);
    expect(text).toContain("Deleted on this device, modified on GitHub.");
    expect(text).toContain("Keep File: Restore the GitHub version locally.");
    expect(text).toContain("Delete File: Delete the GitHub version in a new commit.");

    const buttons = (modal.contentEl as unknown as MockElement).findAll((el: MockElement) => el.tag === "button");
    const buttonTexts = buttons.map((b: MockElement) => b.textContent?.trim());
    expect(buttonTexts).toContain("Keep File");
    expect(buttonTexts).toContain("Delete File");
    expect(buttonTexts).toContain("Cancel");
  });

  // =========================================================================
  // 2. MOVE PRESENTATION & SINGLE COUNTING (C6-UI-MOVE-001..003)
  // =========================================================================

  it("C6-UI-MOVE-001: exact move is displayed as one Move", () => {
    const items: SyncPreviewItem[] = [
      {
        path: "oldFolder/Note.md",
        category: "LOCAL_DELETED",
        localSha: undefined,
        baseSha: "sha1",
        isMove: true,
        movedTo: "newFolder/Note.md",
      },
      {
        path: "newFolder/Note.md",
        category: "LOCAL_ONLY",
        localSha: "sha1",
        isMove: true,
        movedFrom: "oldFolder/Note.md",
      },
    ];

    const sem = computeSemanticPreview(items);
    expect(sem.pushMoves).toBe(1);
    expect(sem.totalSemanticMoves).toBe(1);
    expect(sem.pushCreate).toBe(0);
    expect(sem.pushDeleteRemote).toBe(0);
    expect(sem.totalPushMutations).toBe(1);
  });

  it("C6-UI-MOVE-002: exact move is not misleadingly double-counted", () => {
    const items: SyncPreviewItem[] = [
      {
        path: "docs/A.md",
        category: "REMOTE_DELETED",
        remoteSha: undefined,
        baseSha: "shaA",
        isMove: true,
        movedTo: "archive/A.md",
      },
      {
        path: "archive/A.md",
        category: "REMOTE_ONLY",
        remoteSha: "shaA",
        isMove: true,
        movedFrom: "docs/A.md",
      },
    ];

    const sem = computeSemanticPreview(items);
    expect(sem.pullMoves).toBe(1);
    expect(sem.pullCreate).toBe(0);
    expect(sem.pullRemoveLocal).toBe(0);
    expect(sem.totalPullMutations).toBe(1);
  });

  it("C6-UI-MOVE-003: unpaired delete+add remain independent operations", () => {
    const items: SyncPreviewItem[] = [
      { path: "deleted.md", category: "LOCAL_DELETED", localSha: undefined, baseSha: "sha1" },
      { path: "brandNew.md", category: "LOCAL_ONLY", localSha: "sha2" },
    ];

    const sem = computeSemanticPreview(items);
    expect(sem.pushMoves).toBe(0);
    expect(sem.pushDeleteRemote).toBe(1);
    expect(sem.pushCreate).toBe(1);
    expect(sem.totalPushMutations).toBe(2);
  });

  // =========================================================================
  // 3. PROGRESS UX (C6-UI-PROGRESS-001..002)
  // =========================================================================

  it("C6-UI-PROGRESS-001: local deletion and move progress phases are truthful and visible", () => {
    expect(getPhaseLabel("REMOVING_LOCAL")).toBe("Removing local files...");
    expect(getPhaseLabel("APPLYING_MOVES")).toBe("Applying moves...");
  });

  it("C6-UI-PROGRESS-002: remote deletion progress phase is truthful and visible", () => {
    expect(getPhaseLabel("DELETING_REMOTE")).toBe("Deleting files from GitHub...");
  });

  // =========================================================================
  // 4. MOBILE RESPONSIVENESS & TOUCH TARGETS (C6-UI-MOBILE-001..002)
  // =========================================================================

  it("C6-UI-MOBILE-001: delete/move rows wrap safely at narrow viewport", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "styles.css"), "utf8");
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/overflow-x:\s*hidden/);
    expect(css).toMatch(/@media\s*\(max-width:\s*480px\)/);
    expect(css).toContain(".vault-relay-move-row");
    expect(css).toContain(".vault-relay-destructive-card");
  });

  it("C6-UI-MOBILE-002: destructive actions retain >=44px touch targets", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "styles.css"), "utf8");
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toMatch(/min-width:\s*44px/);

    const pullModal = new PullConfirmModal(app, plugin);
    pullModal.onOpen();
    const pullButtons = (pullModal.contentEl as unknown as MockElement).findAll((el: MockElement) => el.tag === "button");
    for (const b of pullButtons) {
      expect(b.attributes.style || "").toMatch(/min-height:\s*44px/);
    }

    const pushModal = new PushConfirmModal(app, plugin);
    pushModal.onOpen();
    const pushButtons = (pushModal.contentEl as unknown as MockElement).findAll((el: MockElement) => el.tag === "button");
    for (const b of pushButtons) {
      expect(b.attributes.style || "").toMatch(/min-height:\s*44px/);
    }
  });

  // =========================================================================
  // 5. ZERO DELETE/MOVE CLUTTER (C6-UI-ZERO-001)
  // =========================================================================

  it("C6-UI-ZERO-001: zero delete/move counts do not clutter normal Sync UX", () => {
    const normalReport = makeMockReport(
      [
        { path: "create.md", category: "LOCAL_ONLY", localSha: "sha1" },
        { path: "update.md", category: "REMOTE_CHANGED", remoteSha: "sha2", baseSha: "sha0" },
      ],
      {
        LOCAL_ONLY: 1,
        REMOTE_CHANGED: 1,
        UNCHANGED: 5,
      }
    );

    // 1. Pull Confirm: no destructive warning section
    const pullModal = new PullConfirmModal(app, plugin);
    const pullInternal = pullModal as unknown as ModalInternalWithPreview;
    pullInternal.previewReport = normalReport;
    pullInternal.isLoading = false;
    pullInternal.renderConfirmation?.();
    expect(getAllText(pullModal.contentEl as unknown as MockElement)).not.toContain("Files to remove locally");

    // 2. Push Confirm: no destructive warning section
    const pushModal = new PushConfirmModal(app, plugin);
    const pushInternal = pushModal as unknown as ModalInternalWithPreview;
    pushInternal.previewReport = normalReport;
    pushInternal.isLoading = false;
    pushInternal.renderConfirmation?.();
    expect(getAllText(pushModal.contentEl as unknown as MockElement)).not.toContain("Files to delete from GitHub");

    // 3. Pull Result with 0 deletes: no "Removed locally" badge
    const pullResModal = new PullResultModal(app, {
      status: "PASS",
      branch: "main",
      timestamp: Date.now(),
      summaryMessage: "Pull succeeded",
      counts: {
        pulledCreated: 1,
        pulledUpdated: 0,
        pulledDeleted: 0,
        pulledMoved: 0,
        conflictsPreserved: 0,
        unchanged: 5,
        skippedLocalOnly: 0,
        skippedLocalChanged: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      results: [],
    });
    pullResModal.onOpen();
    expect(getAllText(pullResModal.contentEl as unknown as MockElement)).not.toContain("Removed locally");

    // 4. Push Result with 0 deletes: no "Deleted from GitHub" badge
    const pushResModal = new PushResultModal(app, {
      status: "PASS",
      branch: "main",
      newCommitSha: "c2",
      timestamp: Date.now(),
      summaryMessage: "Push succeeded",
      counts: {
        pushedCreated: 1,
        pushedUpdated: 0,
        pushedDeleted: 0,
        pushedMoved: 0,
        unchanged: 5,
        skippedRemoteOnly: 0,
        skippedRemoteChanged: 0,
        skippedConflicts: 0,
        skippedOversized: 0,
        skippedUnsafe: 0,
        failed: 0,
      },
      results: [],
    });
    pushResModal.onOpen();
    expect(getAllText(pushResModal.contentEl as unknown as MockElement)).not.toContain("Deleted from GitHub");

    // 5. Dashboard with 0 deletes: no "Destructive Operations Pending" warning box
    const dashModal = new SyncDashboardModal(app, plugin);
    dashModal.isModalOpen = true;
    const dashInternal = dashModal as unknown as DashboardModalInternal;
    dashInternal.report = normalReport;
    dashInternal.render?.();
    expect(getAllText(dashModal.contentEl as unknown as MockElement)).not.toContain("Destructive Operations Pending");
    expect(getAllText(dashModal.contentEl as unknown as MockElement)).not.toContain("Destructive changes");
  });

  // =========================================================================
  // 6. DEFAULT DASHBOARD UX SIMPLIFICATION (C6-UI-DASH-001..010)
  // =========================================================================
  describe("Default Dashboard UX Simplification (C6-UI-DASH-001..010)", () => {
    it("C6-UI-DASH-001: Create + Update collapse into one Changes card with '+ X new · ~ Y updated'", () => {
      const report = makeMockReport(
        [
          { path: "new1.md", category: "LOCAL_ONLY", localSha: "s1" },
          { path: "new2.md", category: "LOCAL_ONLY", localSha: "s2" },
          { path: "new3.md", category: "REMOTE_ONLY", remoteSha: "s3" },
          { path: "mod1.md", category: "LOCAL_CHANGED", localSha: "s4", baseSha: "s0" },
          { path: "mod2.md", category: "REMOTE_CHANGED", remoteSha: "s5", baseSha: "s0" },
        ],
        {
          LOCAL_ONLY: 2,
          REMOTE_ONLY: 1,
          LOCAL_CHANGED: 1,
          REMOTE_CHANGED: 1,
          UNCHANGED: 10,
        }
      );

      const modal = new SyncDashboardModal(app, plugin);
      modal.isModalOpen = true;
      const internal = modal as unknown as DashboardModalInternal;
      internal.report = report;
      internal.render?.();

      const root = modal.contentEl as unknown as MockElement;
      const text = getAllText(root);

      expect(text).toContain("Changes");
      expect(text).toContain("5 files");
      expect(text).toContain("+ 3 new · ~ 2 updated");

      const summaryCards = root.findAll((el: MockElement) => el.hasClass("vault-relay-summary-card"));
      expect(summaryCards.length).toBe(1);
      expect(getAllText(summaryCards[0])).toContain("Changes");
    });

    it("C6-UI-DASH-002: Normal conflict + delete conflict collapse into one Conflicts card with subtype counts", () => {
      const report = makeMockReport(
        [
          { path: "cf1.md", category: "POTENTIAL_CONFLICT", localSha: "s1", remoteSha: "s2", baseSha: "s0" },
          { path: "cf2.md", category: "DELETE_CONFLICT", deleteConflictType: "REMOTE_DELETED_LOCAL_MODIFIED", localSha: "s3", baseSha: "s0" },
        ],
        {
          POTENTIAL_CONFLICT: 1,
          DELETE_CONFLICT: 1,
          UNCHANGED: 10,
        }
      );

      const modal = new SyncDashboardModal(app, plugin);
      modal.isModalOpen = true;
      const internal = modal as unknown as DashboardModalInternal;
      internal.report = report;
      internal.render?.();

      const root = modal.contentEl as unknown as MockElement;
      const text = getAllText(root);

      expect(text).toContain("Conflicts");
      expect(text).toContain("2 files");
      expect(text).toContain("1 content · 1 delete");

      const conflictCards = root.findAll((el: MockElement) => el.hasClass("vault-relay-summary-card-warning"));
      expect(conflictCards.length).toBe(1);

      expect(text).toContain("Review Conflicts");
      expect(text).toContain("Sync Blocked by Conflicts");
    });

    it("C6-UI-DASH-003: Exact Move remains separate and is not double-counted in Changes", () => {
      const report = makeMockReport(
        [
          { path: "old.md", category: "LOCAL_DELETED", isMove: true, movedTo: "new.md", baseSha: "s1" },
          { path: "new.md", category: "LOCAL_ONLY", isMove: true, movedFrom: "old.md", localSha: "s1" },
        ],
        {
          LOCAL_DELETED: 1,
          LOCAL_ONLY: 1,
          UNCHANGED: 10,
        }
      );

      const modal = new SyncDashboardModal(app, plugin);
      modal.isModalOpen = true;
      const internal = modal as unknown as DashboardModalInternal;
      internal.report = report;
      internal.render?.();

      const root = modal.contentEl as unknown as MockElement;
      const text = getAllText(root);

      expect(text).toContain("Moves");
      expect(text).toContain("1 file");

      const summaryCards = root.findAll((el: MockElement) => el.hasClass("vault-relay-summary-card"));
      expect(summaryCards.length).toBe(1);
      expect(getAllText(summaryCards[0])).toContain("Moves");
      expect(text).not.toContain("Changes");
    });

    it("C6-UI-DASH-004: Delete operations create one destructive banner rather than permanent delete cards", () => {
      const report = makeMockReport(
        [
          { path: "del_remote1.md", category: "LOCAL_DELETED", baseSha: "s1" },
          { path: "del_remote2.md", category: "LOCAL_DELETED", baseSha: "s2" },
          { path: "del_local1.md", category: "REMOTE_DELETED", baseSha: "s3" },
        ],
        {
          LOCAL_DELETED: 2,
          REMOTE_DELETED: 1,
          UNCHANGED: 10,
        }
      );

      const modal = new SyncDashboardModal(app, plugin);
      modal.isModalOpen = true;
      const internal = modal as unknown as DashboardModalInternal;
      internal.report = report;
      internal.render?.();

      const root = modal.contentEl as unknown as MockElement;
      const text = getAllText(root);

      const banners = root.findAll((el: MockElement) => el.hasClass("vault-relay-destructive-banner"));
      expect(banners.length).toBe(1);
      expect(text).toContain("Destructive changes");
      expect(text).toContain("2 files will be deleted from GitHub");
      expect(text).toContain("1 file will be removed locally");

      const summaryCards = root.findAll((el: MockElement) => el.hasClass("vault-relay-summary-card"));
      expect(summaryCards.length).toBe(0);
    });

    it("C6-UI-DASH-005: Delete banner is absent when delete counts are zero", () => {
      const report = makeMockReport(
        [
          { path: "new.md", category: "LOCAL_ONLY", localSha: "s1" },
        ],
        {
          LOCAL_ONLY: 1,
          UNCHANGED: 10,
        }
      );

      const modal = new SyncDashboardModal(app, plugin);
      modal.isModalOpen = true;
      const internal = modal as unknown as DashboardModalInternal;
      internal.report = report;
      internal.render?.();

      const root = modal.contentEl as unknown as MockElement;
      const text = getAllText(root);

      const banners = root.findAll((el: MockElement) => el.hasClass("vault-relay-destructive-banner"));
      expect(banners.length).toBe(0);
      expect(text).not.toContain("Destructive changes");
    });

    it("C6-UI-DASH-006: Unchanged appears as lightweight footer text, not primary metric card", () => {
      const report = makeMockReport(
        [
          { path: "note.md", category: "LOCAL_CHANGED", localSha: "s2", baseSha: "s1" },
        ],
        {
          LOCAL_CHANGED: 1,
          UNCHANGED: 106,
        }
      );

      const modal = new SyncDashboardModal(app, plugin);
      modal.isModalOpen = true;
      const internal = modal as unknown as DashboardModalInternal;
      internal.report = report;
      internal.render?.();

      const root = modal.contentEl as unknown as MockElement;
      const text = getAllText(root);

      const footers = root.findAll((el: MockElement) => el.hasClass("vault-relay-dashboard-footer"));
      expect(footers.length).toBe(1);
      expect(footers[0].textContent).toBe("106 files already in sync");
      expect(text).toContain("106 files already in sync");

      const summaryCards = root.findAll((el: MockElement) => el.hasClass("vault-relay-summary-card"));
      for (const card of summaryCards) {
        expect(getAllText(card)).not.toContain("Unchanged");
      }
    });

    it("C6-UI-DASH-007: Zero-change dashboard displays 'Everything is in sync' without zero-card clutter", () => {
      const report = makeMockReport([], { UNCHANGED: 106 });

      const modal = new SyncDashboardModal(app, plugin);
      modal.isModalOpen = true;
      const internal = modal as unknown as DashboardModalInternal;
      internal.report = report;
      internal.render?.();

      const root = modal.contentEl as unknown as MockElement;
      const text = getAllText(root);

      const zeroCards = root.findAll((el: MockElement) => el.hasClass("vault-relay-zero-state"));
      expect(zeroCards.length).toBe(1);
      expect(text).toContain("✓ Everything is in sync");
      expect(text).toContain("106 files synchronized");

      const summaryCards = root.findAll((el: MockElement) => el.hasClass("vault-relay-summary-card"));
      expect(summaryCards.length).toBe(0);
      expect(text).not.toMatch(/Changes\s+0/i);
      expect(text).not.toMatch(/Moves\s+0/i);
      expect(text).not.toMatch(/Conflicts\s+0/i);
    });

    it("C6-UI-DASH-008: Default dashboard renders maximum three semantic summary cards", () => {
      const report = makeMockReport(
        [
          { path: "new.md", category: "LOCAL_ONLY", localSha: "s1" },
          { path: "mod.md", category: "LOCAL_CHANGED", localSha: "s2", baseSha: "s0" },
          { path: "old.md", category: "LOCAL_DELETED", isMove: true, movedTo: "renamed.md", baseSha: "s3" },
          { path: "renamed.md", category: "LOCAL_ONLY", isMove: true, movedFrom: "old.md", localSha: "s3" },
          { path: "cf.md", category: "POTENTIAL_CONFLICT", localSha: "s4", remoteSha: "s5", baseSha: "s6" },
          { path: "del.md", category: "LOCAL_DELETED", baseSha: "s7" },
        ],
        {
          LOCAL_ONLY: 2,
          LOCAL_CHANGED: 1,
          LOCAL_DELETED: 2,
          POTENTIAL_CONFLICT: 1,
          UNCHANGED: 50,
        }
      );

      const modal = new SyncDashboardModal(app, plugin);
      modal.isModalOpen = true;
      const internal = modal as unknown as DashboardModalInternal;
      internal.report = report;
      internal.render?.();

      const root = modal.contentEl as unknown as MockElement;
      const summaryCards = root.findAll((el: MockElement) => el.hasClass("vault-relay-summary-card"));

      expect(summaryCards.length).toBe(3);
      const cardTexts = summaryCards.map((c: MockElement) => getAllText(c));
      expect(cardTexts.some((t) => t.includes("Changes"))).toBe(true);
      expect(cardTexts.some((t) => t.includes("Moves"))).toBe(true);
      expect(cardTexts.some((t) => t.includes("Conflicts"))).toBe(true);
    });

    it("C6-UI-DASH-009: Preview Details still exposes complete 8-category breakdown", () => {
      const report = makeMockReport(
        [
          { path: "create.md", category: "LOCAL_ONLY", localSha: "s1" },
          { path: "update.md", category: "LOCAL_CHANGED", localSha: "s2", baseSha: "s0" },
          { path: "del_remote.md", category: "LOCAL_DELETED", baseSha: "s3" },
          { path: "rem_local.md", category: "REMOTE_DELETED", baseSha: "s4" },
          { path: "move_from.md", category: "LOCAL_DELETED", isMove: true, movedTo: "move_to.md", baseSha: "s5" },
          { path: "move_to.md", category: "LOCAL_ONLY", isMove: true, movedFrom: "move_from.md", localSha: "s5" },
          { path: "conflict.md", category: "POTENTIAL_CONFLICT", localSha: "s6", remoteSha: "s7", baseSha: "s8" },
          { path: "del_conflict.md", category: "DELETE_CONFLICT", localSha: "s9", baseSha: "s10" },
        ],
        {
          LOCAL_ONLY: 2,
          LOCAL_CHANGED: 1,
          LOCAL_DELETED: 2,
          REMOTE_DELETED: 1,
          POTENTIAL_CONFLICT: 1,
          DELETE_CONFLICT: 1,
          UNCHANGED: 20,
        }
      );

      const modal = new SyncPreviewModal(app, plugin);
      const renderable = modal as unknown as {
        report: SyncPreviewReport;
        renderReport: () => void;
      };
      renderable.report = report;
      renderable.renderReport();

      const root = modal.contentEl as unknown as MockElement;
      const text = getAllText(root);

      expect(text).toContain("Local Only");
      expect(text).toContain("Local Changed");
      expect(text).toContain("Delete from GitHub");
      expect(text).toContain("Remove locally");
      expect(text).toContain("Moves");
      expect(text).toContain("Delete Conflict");
      expect(text).toContain("Conflicts");
      expect(text).toContain("Unchanged");
    });

    it("C6-UI-DASH-010: Narrow viewport css contains summary cards 1fr wrap and touch target >= 44px", () => {
      const cssPath = path.resolve(__dirname, "../styles.css");
      const css = fs.readFileSync(cssPath, "utf8");

      expect(css).toContain(".vault-relay-summary-cards");
      expect(css).toContain("@media (max-width: 480px)");
      expect(css).toMatch(/grid-template-columns:\s*1fr/);

      expect(css).toContain("min-height: 44px");
      expect(css).toContain("min-width: 44px");
    });
  });
});

