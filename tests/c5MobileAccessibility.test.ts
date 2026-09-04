import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("C5-MOBILE: mobile-first static and accessibility audit", () => {
  it("C5-MOBILE-001: every product modal opts into the responsive shell", () => {
    const modalFiles = [
      "src/ui/clearTokenConfirmModal.ts",
      "src/ui/conflictResolutionModal.ts",
      "src/ui/pullConfirmModal.ts",
      "src/ui/pullResultModal.ts",
      "src/ui/pushConfirmModal.ts",
      "src/ui/pushResultModal.ts",
      "src/ui/syncDashboardModal.ts",
      "src/ui/syncPreviewModal.ts",
    ];

    for (const file of modalFiles) {
      expect(read(file), file).toContain('modalEl.addClass("vault-relay-modal")');
    }
    expect(read("src/settings.ts")).toContain('containerEl.addClass("vault-relay-settings")');
  });

  it("C5-MOBILE-002: narrow screens have scrolling, wrapping, safe areas, and 44px targets", () => {
    const css = read("styles.css");

    expect(css).toMatch(/max-height:\s*min\(90vh,\s*900px\)/);
    expect(css).toMatch(/overflow-x:\s*hidden/);
    expect(css).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/safe-area-inset-bottom/);
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toMatch(/min-width:\s*44px/);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/@media\s*\(max-width:\s*480px\)/);
    expect(css).toMatch(/flex-wrap:\s*wrap/);
  });

  it("C5-MOBILE-003: disabled and loading states remain visible and plainly labeled", () => {
    const css = read("styles.css");
    const conflictUi = read("src/ui/conflictResolutionModal.ts");
    const pullUi = read("src/ui/pullConfirmModal.ts");
    const pushUi = read("src/ui/pushConfirmModal.ts");

    expect(css).toMatch(/button:disabled[\s\S]*opacity:\s*0\.55/);
    expect(conflictUi).toContain("Pushing local version...");
    expect(conflictUi).toContain("Pulling remote version...");
    expect(conflictUi).toContain("Saving remote copy...");
    expect(pullUi).toContain('confirmBtn.textContent = "Pulling..."');
    expect(pushUi).toContain('confirmBtn.textContent = "Pushing..."');
  });

  it("C5-MOBILE-004: primary conflict UX uses clear choices without SHA jargon", () => {
    const conflictUi = read("src/ui/conflictResolutionModal.ts");
    const primaryCopy = conflictUi.slice(
      conflictUi.indexOf("private renderConflictCard"),
      conflictUi.indexOf("const handleAction")
    );

    expect(primaryCopy).toContain('text: "Keep Local"');
    expect(primaryCopy).toContain('text: "Use Remote"');
    expect(primaryCopy).toContain('text: "Keep Both"');
    expect(primaryCopy).toContain("Both versions are preserved until you choose an action.");
    expect(primaryCopy).not.toMatch(/\bSHA\b/);
  });

  it("C5-MOBILE-005: Clear Token stays secondary, destructive, and confirmed", () => {
    const settings = read("src/settings.ts");
    const confirmation = read("src/ui/clearTokenConfirmModal.ts");

    expect(settings.indexOf("Advanced / Security")).toBeLessThan(settings.indexOf('setButtonText("Clear Token")'));
    expect(settings).toContain(".setWarning()");
    expect(settings).toContain("new ClearTokenConfirmModal");
    expect(confirmation).toContain('setButtonText("Cancel")');
    expect(confirmation).toContain('setButtonText("Clear Token")');
    expect(confirmation).toContain("This action cannot be undone");
  });
});
