import { describe, it, expect, beforeEach } from "vitest";
import { App, PluginManifest } from "obsidian";
import { MockElement } from "./__mocks__/obsidian";
import VaultRelayPlugin from "../src/main";
import { VaultRelaySettingTab } from "../src/settings";
import { clearStoredPat, getStoredPat, setStoredPat } from "../src/security/secretStore";

describe("Mobile UI Token Actions & Placement (UI-TOKEN-001..005)", () => {
  let app: App;
  let plugin: VaultRelayPlugin;
  const manifest: PluginManifest = {
    id: "github-vault-relay",
    name: "GitHub Vault Relay",
    version: "0.4.0",
    minAppVersion: "0.15.0",
    description: "Test",
    author: "Vault Relay Contributors",
  };

  beforeEach(async () => {
    app = new App();
    plugin = new VaultRelayPlugin(app, manifest);
    plugin.settings = {
      owner: "octocat",
      repo: "my-vault",
      branch: "main",
      excludedPaths: [".obsidian/", ".git/", "_fit/"],
      settingsVersion: 2,
    };
  });

  // UI-TOKEN-001: primary connection area has only Save & Connect
  it("UI-TOKEN-001: primary connection area has only Save & Connect", async () => {
    // Case 1: Token already stored
    await setStoredPat(app, "octocat", "my-vault", "github_pat_test123");

    const tab = new VaultRelaySettingTab(app, plugin);
    await tab.display();

    const container = tab.containerEl as unknown as MockElement;

    // Find the PAT setting item in the primary connection area
    const settingItems = container.findAll((el: MockElement) => el.hasClass("setting-item"));
    const patSetting = settingItems.find((item: MockElement) => {
      const nameEl = item.findAll((e: MockElement) => e.hasClass("setting-item-name"))[0];
      return nameEl && nameEl.textContent.includes("GitHub Fine-Grained PAT");
    });

    expect(patSetting).toBeDefined();

    // Check all buttons inside the primary PAT setting item
    const patButtons = patSetting!.findAll((el: MockElement) => el.tag === "button");
    expect(patButtons.length).toBe(1);
    expect(patButtons[0].textContent).toBe("Save & Connect");
    expect(patButtons[0].hasClass("mod-cta")).toBe(true);
    expect(patButtons[0].hasClass("mod-warning")).toBe(false);

    // Verify 44px mobile touch target minHeight
    expect(patButtons[0].style["minHeight"]).toBe("44px");

    // Case 2: No token stored
    await clearStoredPat(app, "octocat", "my-vault");
    await tab.display();

    const containerNoToken = tab.containerEl as unknown as MockElement;
    const settingItemsNoToken = containerNoToken.findAll((el: MockElement) => el.hasClass("setting-item"));
    const patSettingNoToken = settingItemsNoToken.find((item: MockElement) => {
      const nameEl = item.findAll((e: MockElement) => e.hasClass("setting-item-name"))[0];
      return nameEl && nameEl.textContent.includes("GitHub Fine-Grained PAT");
    });

    expect(patSettingNoToken).toBeDefined();
    const patButtonsNoToken = patSettingNoToken!.findAll((el: MockElement) => el.tag === "button");
    expect(patButtonsNoToken.length).toBe(1);
    expect(patButtonsNoToken[0].textContent).toBe("Save & Connect");
  });

  // UI-TOKEN-002: Clear Token exists only under Advanced/Security
  it("UI-TOKEN-002: Clear Token exists only under Advanced/Security", async () => {
    await setStoredPat(app, "octocat", "my-vault", "github_pat_test123");

    const tab = new VaultRelaySettingTab(app, plugin);
    await tab.display();

    const container = tab.containerEl as unknown as MockElement;

    // Find all Clear Token buttons across the entire settings tab
    const allButtons = container.findAll((el: MockElement) => el.tag === "button");
    const clearTokenButtons = allButtons.filter((b: MockElement) => b.textContent === "Clear Token");

    expect(clearTokenButtons.length).toBe(1);

    // Verify the Clear Token button is inside "Stored Credential" setting
    const storedCredSetting = container.findAll((el: MockElement) => el.hasClass("setting-item")).find((item: MockElement) => {
      const nameEl = item.findAll((e: MockElement) => e.hasClass("setting-item-name"))[0];
      return nameEl && nameEl.textContent.includes("Stored Credential");
    });

    expect(storedCredSetting).toBeDefined();
    const credButtons = storedCredSetting!.findAll((el: MockElement) => el.tag === "button");
    expect(credButtons.length).toBe(1);
    expect(credButtons[0].textContent).toBe("Clear Token");

    // Verify secondary / destructive styling (not CTA)
    expect(credButtons[0].hasClass("mod-warning")).toBe(true);
    expect(credButtons[0].hasClass("mod-cta")).toBe(false);

    // Verify 44px touch target
    expect(credButtons[0].style["minHeight"]).toBe("44px");

    // Verify heading preceding Stored Credential is "Advanced / Security"
    const headings = container.findAll((el: MockElement) => el.tag === "h3");
    const hasAdvSecHeading = headings.some((h: MockElement) => h.textContent.includes("Advanced / Security"));
    expect(hasAdvSecHeading).toBe(true);
  });

  // UI-TOKEN-003: Clear Token requires confirmation
  it("UI-TOKEN-003: Clear Token requires confirmation", async () => {
    await setStoredPat(app, "octocat", "my-vault", "github_pat_test123");

    const tab = new VaultRelaySettingTab(app, plugin);
    await tab.display();

    const container = tab.containerEl as unknown as MockElement;

    // Find Clear Token button
    const clearBtn = container
      .findAll((el: MockElement) => el.tag === "button")
      .find((b: MockElement) => b.textContent === "Clear Token");
    expect(clearBtn).toBeDefined();

    // Click Clear Token button: should trigger confirmation modal, NOT clear token directly
    if (clearBtn && clearBtn.onclick) {
      await clearBtn.onclick();
    }

    // Token must STILL exist in SecretStorage immediately after button tap
    const tokenStillPresent = await getStoredPat(app, "octocat", "my-vault");
    expect(tokenStillPresent).toBe("github_pat_test123");
  });

  // UI-TOKEN-004: clear removes SecretStorage credential
  it("UI-TOKEN-004: clear removes SecretStorage credential", async () => {
    await setStoredPat(app, "octocat", "my-vault", "github_pat_test123");
    plugin.settings.secretKey = "github-vault-relay-pat";

    const tab = new VaultRelaySettingTab(app, plugin);
    await tab.display();

    // Simulate modal confirm callback execution directly
    const { ClearTokenConfirmModal } = await import("../src/ui/clearTokenConfirmModal");

    const modal = new ClearTokenConfirmModal(app, async () => {
      await clearStoredPat(app, plugin.settings.owner, plugin.settings.repo);
      plugin.settings.secretKey = undefined;
      await plugin.saveSettings();
      await tab.display();
    });

    modal.onOpen();

    const modalContent = modal.contentEl as unknown as MockElement;

    // Verify modal has Cancel and Clear Token buttons with 44px minHeight
    const modalButtons = modalContent.findAll((el: MockElement) => el.tag === "button");
    expect(modalButtons.length).toBe(2);

    const cancelBtn = modalButtons.find((b: MockElement) => b.textContent === "Cancel");
    const confirmClearBtn = modalButtons.find((b: MockElement) => b.textContent === "Clear Token");
    expect(cancelBtn).toBeDefined();
    expect(confirmClearBtn).toBeDefined();
    expect(confirmClearBtn!.hasClass("mod-warning")).toBe(true);
    expect(confirmClearBtn!.style["minHeight"]).toBe("44px");

    // Execute confirmation
    if (confirmClearBtn && confirmClearBtn.onclick) {
      await confirmClearBtn.onclick();
    }

    // Verify token removed from SecretStorage
    const storedTokenAfter = await getStoredPat(app, "octocat", "my-vault");
    expect(storedTokenAfter).toBeNull();
    expect(plugin.settings.secretKey).toBeUndefined();

    // Verify repo and branch settings remain intact
    expect(plugin.settings.owner).toBe("octocat");
    expect(plugin.settings.repo).toBe("my-vault");
    expect(plugin.settings.branch).toBe("main");

    // Verify UI updated: Stored Credential now says "No token currently stored"
    const container = tab.containerEl as unknown as MockElement;
    const descEl = container.findAll((el: MockElement) => el.hasClass("setting-item-description")).find((d: MockElement) =>
      d.textContent.includes("No token currently stored in SecretStorage")
    );
    expect(descEl).toBeDefined();

    // Verify Clear Token button is no longer present in settings tab
    const clearBtnsAfter = container
      .findAll((el: MockElement) => el.tag === "button")
      .filter((b: MockElement) => b.textContent === "Clear Token");
    expect(clearBtnsAfter.length).toBe(0);
  });

  // UI-TOKEN-005: no connection/sync regression
  it("UI-TOKEN-005: no connection/sync regression", async () => {
    const tab = new VaultRelaySettingTab(app, plugin);
    await tab.display();

    const container = tab.containerEl as unknown as MockElement;

    // Enter token in text field
    const inputEl = container.findAll((el: MockElement) => el.tag === "input")[0];
    expect(inputEl).toBeDefined();

    // Save & Connect button
    const saveBtn = container
      .findAll((el: MockElement) => el.tag === "button")
      .find((b: MockElement) => b.textContent === "Save & Connect");
    expect(saveBtn).toBeDefined();

    // Simulate input change
    (tab as unknown as { tokenInputVal: string }).tokenInputVal = "github_pat_new_sync_test";

    // Click Save & Connect
    if (saveBtn && saveBtn.onclick) {
      await saveBtn.onclick();
    }

    // Token stored in SecretStorage
    const saved = await getStoredPat(app, "octocat", "my-vault");
    expect(saved).toBe("github_pat_new_sync_test");
  });
});
