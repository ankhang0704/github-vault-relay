import { describe, expect, it } from "vitest";
import { App, Platform, PluginManifest, Setting } from "obsidian";
import VaultRelayPlugin from "../src/main";
import { GitHubClient } from "../src/github/githubClient";
import { VaultRelaySettingTab } from "../src/settings";
import { LocalFileStore } from "../src/sync/localFileStore";
import { PullEngine } from "../src/sync/pullEngine";
import { PushEngine } from "../src/sync/pushEngine";
import { SyncEngine } from "../src/sync/syncEngine";
import { StorageManager } from "../src/sync/storageManager";
import { calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { getDefaultExclusions } from "../src/sync/pathFilter";
import { classifySyncState } from "../src/sync/syncClassifier";

const manifest = {
  id: "github-vault-relay",
  name: "GitHub Vault Relay",
  version: "1.0.5",
  minAppVersion: "1.11.4",
  description: "Test",
  author: "Test",
} as PluginManifest;

function makePlugin(app: App): VaultRelayPlugin {
  const plugin = new VaultRelayPlugin(app, manifest);
  plugin.settings = {
    owner: "owner",
    repo: "repo",
    branch: "main",
    excludedPaths: getDefaultExclusions(app.vault.configDir),
  };
  return plugin;
}

describe("1.0.5 settings and hidden-path regressions", () => {
  it("SETTINGS-DECLARATIVE-001..004: keeps repository state visible and advanced controls conditional", async () => {
    const app = new App();
    const plugin = makePlugin(app);
    const tab = new VaultRelaySettingTab(app, plugin);
    const defs = tab.getSettingDefinitions() as unknown as Array<Record<string, unknown>>;
    const connection = defs.find((item) => item.heading === "Connection Wizard") as { items: Array<Record<string, unknown>> };
    const repository = connection.items.find((item) => item.name === "Repository") as {
      render: (setting: Setting, group: unknown) => void;
    };

    const loadingSetting = new Setting(tab.containerEl);
    repository.render(loadingSetting, {});
    expect(loadingSetting.descEl.textContent).toContain("Save a token");

    const advanced = defs.find((item) => item.heading === "Advanced / Security") as { items: Array<Record<string, unknown>> };
    const owner = advanced.items.find((item) => item.name === "Repository Owner") as { visible: () => boolean };
    expect(owner.visible()).toBe(false);

    const toggle = advanced.items.find((item) => item.name === "Advanced Settings") as {
      render: (setting: Setting, group: unknown) => void;
    };
    const toggleSetting = new Setting(tab.containerEl);
    toggle.render(toggleSetting, {});
    const toggleButton = toggleSetting.controlEl.children[0] as unknown as { onclick?: () => void | Promise<void> };
    await toggleButton.onclick?.();
    expect(owner.visible()).toBe(true);

    const internal = tab as unknown as {
      repositoryLoadState: "LOADED" | "ERROR";
      repositoryLoadError: string;
      discoveredRepos: Array<{ fullName: string; owner: string; name: string; defaultBranch: string; isPrivate: boolean }>;
    };
    internal.repositoryLoadState = "LOADED";
    internal.discoveredRepos = [{
      fullName: "owner/repo",
      owner: "owner",
      name: "repo",
      defaultBranch: "main",
      isPrivate: true,
    }];
    const loadedSetting = new Setting(tab.containerEl);
    repository.render(loadedSetting, {});
    expect(loadedSetting.controlEl.children[0].children).toHaveLength(1);

    internal.repositoryLoadState = "ERROR";
    internal.repositoryLoadError = "network unavailable";
    const errorSetting = new Setting(tab.containerEl);
    repository.render(errorSetting, {});
    expect(errorSetting.descEl.textContent).toContain("network unavailable");
    expect(plugin.settings.owner).toBe("owner");
    expect(plugin.settings.repo).toBe("repo");
  });

  it("HIDDEN-001/002/005/006/007/011: enumerates dot-folders once and preserves hidden deletes", async () => {
    const app = new App();
    const exclusions = getDefaultExclusions(app.vault.configDir);
    const store = new LocalFileStore(app, exclusions);
    const files = [
      "note.md",
      ".agents/rules/knowledge-base.md",
      ".vscode/settings.json",
      ".custom-user-folder/data.bin",
      "_vault-relay/user-note.md",
      ".obsidian/app.json",
      ".git/config",
      ".trash/deleted.md",
      "_fit/cache.dat",
    ];
    for (const path of files) await app.vault.adapter.writeBinary(path, new Uint8Array([1, 2, 3]).buffer);

    const paths = (await store.listFiles()).map((file) => file.path);
    expect(paths.filter((path) => path === ".agents/rules/knowledge-base.md")).toHaveLength(1);
    expect(paths).toEqual(expect.arrayContaining([
      "note.md",
      ".agents/rules/knowledge-base.md",
      ".vscode/settings.json",
      ".custom-user-folder/data.bin",
      "_vault-relay/user-note.md",
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      ".obsidian/app.json",
      ".git/config",
      ".trash/deleted.md",
      "_fit/cache.dat",
    ]));

    const configApp = new App();
    configApp.vault.configDir = ".my-config";
    await configApp.vault.adapter.writeBinary(".my-config/app.json", new Uint8Array([9]).buffer);
    await configApp.vault.adapter.writeBinary(".obsidian/user-folder.md", new Uint8Array([8]).buffer);
    const customPaths = (await new LocalFileStore(configApp, getDefaultExclusions(".my-config")).listFiles()).map((file) => file.path);
    expect(customPaths).not.toContain(".my-config/app.json");
    expect(customPaths).toContain(".obsidian/user-folder.md");

    const hiddenPath = ".agents/rules/delete-me.bin";
    const bytes = new Uint8Array([0, 255, 3, 7]);
    await store.writeBinary(hiddenPath, bytes.buffer);
    expect(new Uint8Array(await store.readBinary(hiddenPath))).toEqual(bytes);
    await store.move(hiddenPath, ".agents/rules/moved.bin");
    expect(await store.exists(hiddenPath)).toBe(false);
    expect(new Uint8Array(await store.readBinary(".agents/rules/moved.bin"))).toEqual(bytes);

    const sha = await calculateRawGitBlobSha(bytes);
    await StorageManager.saveState(app, {
      version: 2,
      files: {
        ".agents/rules/moved.bin": { localSha: sha, remoteSha: sha, syncedAt: Date.now() },
      },
    });
    const journal = await StorageManager.beginDeleteRecovery(app, ".agents/rules/moved.bin", sha, bytes.buffer);
    await StorageManager.deleteVaultFile(app, ".agents/rules/moved.bin");
    expect(await store.exists(".agents/rules/moved.bin")).toBe(false);
    expect(await app.vault.adapter.exists(".trash/.agents/rules/moved.bin")).toBe(true);
    await StorageManager.recoverInterruptedDeletes(app);
    expect(new Uint8Array(await store.readBinary(".agents/rules/moved.bin"))).toEqual(bytes);
    expect(await app.vault.adapter.exists(journal)).toBe(false);
  });

  it("HIDDEN-003/009/010: pulls remote hidden bytes, advances state only after verification, and repeats without mutation", async () => {
    const app = new App();
    const plugin = makePlugin(app);
    const path = ".agents/rules/knowledge-base.md";
    const bytes = new TextEncoder().encode("# exact hidden bytes\n");
    const sha = await calculateRawGitBlobSha(bytes);
    const client = {
      getBranch: async () => ({ commit: { sha: "commit-1", commit: { tree: { sha: "tree-1" } } } }),
      getTreeRecursive: async () => ({ truncated: false, tree: [{ path, type: "blob", sha, size: bytes.byteLength, mode: "100644" }] }),
      getRawBlobBytes: async () => bytes.buffer,
    } as unknown as GitHubClient;

    const pull = new PullEngine(app, plugin.settings, client);
    const first = await pull.executeSafePull();
    expect(first.status).toBe("PASS");
    expect(first.counts.pulledCreated).toBe(1);
    expect(new Uint8Array(await app.vault.adapter.readBinary(path))).toEqual(bytes);
    expect((await StorageManager.loadState(app)).files[path]).toBeDefined();

    const second = await new PullEngine(app, plugin.settings, client).executeSafePull();
    expect(second.status).toBe("PASS");
    expect(second.counts.unchanged).toBe(1);
    expect(second.counts.failed).toBe(0);
  });

  it("HIDDEN-004/010: local hidden files push as exact bytes and repeat as zero drift", async () => {
    const app = new App();
    const plugin = makePlugin(app);
    const path = ".agents/rules/local-note.md";
    const bytes = new TextEncoder().encode("local hidden note\n");
    await app.vault.adapter.writeBinary(path, bytes.buffer);

    let head = "commit-1";
    let remoteTree: Array<{ path: string; type: "blob"; sha: string; size: number }> = [];
    let uploadedBytes = new Uint8Array();
    const client = {
      getBranch: async () => ({ commit: { sha: head, commit: { tree: { sha: `tree-${head}` } } } }),
      getBranchRef: async () => ({ object: { sha: head } }),
      getTreeRecursive: async () => ({ truncated: false, sha: `tree-${head}`, tree: remoteTree }),
      createBlob: async (base64: string) => {
        const binary = atob(base64);
        uploadedBytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return { sha: await calculateRawGitBlobSha(uploadedBytes), url: "" };
      },
      createTree: async (items: Array<{ path: string; sha: string | null }>) => {
        remoteTree = items
          .filter((item): item is { path: string; sha: string } => !!item.sha)
          .map((item) => ({ path: item.path, type: "blob" as const, sha: item.sha, size: uploadedBytes.byteLength }));
        return { sha: "tree-2", url: "", tree: remoteTree };
      },
      createCommit: async () => ({ sha: "commit-2", url: "", tree: { sha: "tree-2" }, parents: [] }),
      updateBranchRef: async () => {
        head = "commit-2";
      },
    } as unknown as GitHubClient;

    const first = await new PushEngine(app, plugin.settings, client).executeSafePush();
    expect(first.status).toBe("PASS");
    expect(first.counts.pushedCreated).toBe(1);
    expect(uploadedBytes).toEqual(bytes);
    expect(remoteTree).toEqual([{ path, type: "blob", sha: await calculateRawGitBlobSha(bytes), size: bytes.byteLength }]);

    const second = await new SyncEngine(app, plugin.settings, client).generatePreview(true);
    expect(second.counts.UNCHANGED).toBe(1);
    expect(second.counts.LOCAL_ONLY).toBe(0);
  });

  it("HIDDEN-008: hidden content changes remain a conflict", () => {
    const path = ".agents/rules/conflict.md";
    const result = classifySyncState({
      localFiles: new Map([[path, { path, sha: "local-v2", size: 3 }]]),
      remoteBlobs: new Map([[path, { path, sha: "remote-v2", size: 3 }]]),
      state: {
        version: 2,
        files: { [path]: { localSha: "base", remoteSha: "base", syncedAt: 1 } },
      },
    });

    expect(result.items).toEqual([expect.objectContaining({ path, category: "POTENTIAL_CONFLICT" })]);
  });

  it("SETTINGS-DESKTOP-GIT: Desktop Git setting is strictly hidden on mobile and only visible when advanced settings are expanded on desktop", async () => {
    const app = new App();
    const plugin = makePlugin(app);
    const tab = new VaultRelaySettingTab(app, plugin);
    const defs = tab.getSettingDefinitions() as unknown as Array<Record<string, unknown>>;
    const advanced = defs.find((item) => item.heading === "Advanced / Security") as { items: Array<Record<string, unknown>> };
    const gitSetting = advanced.items.find((item) => item.name === "Desktop Git integration") as { visible: () => boolean };

    // Initially collapsed on Desktop -> hidden
    Platform.isDesktopApp = true;
    expect(gitSetting.visible()).toBe(false);

    // Expanded on Desktop -> visible
    const toggle = advanced.items.find((item) => item.name === "Advanced Settings") as {
      render: (setting: Setting, group: unknown) => void;
    };
    const toggleSetting = new Setting(tab.containerEl);
    toggle.render(toggleSetting, {});
    const toggleButton = toggleSetting.controlEl.children[0] as unknown as { onclick?: () => void | Promise<void> };
    await toggleButton.onclick?.();
    expect(gitSetting.visible()).toBe(true);

    // On Mobile (even if advanced is expanded) -> strictly hidden
    Platform.isDesktopApp = false;
    expect(gitSetting.visible()).toBe(false);

    // Reset back to Desktop for other tests
    Platform.isDesktopApp = true;
  });
});
