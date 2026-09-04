import { describe, expect, it } from "vitest";
import { App, PluginManifest } from "obsidian";
import VaultRelayPlugin from "../src/main";
import { GitHubClient } from "../src/github/githubClient";
import { DEFAULT_SETTINGS, VaultRelaySettings } from "../src/settings";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { PushEngine } from "../src/sync/pushEngine";
import { SyncEngine } from "../src/sync/syncEngine";
import { SyncProgressEvent } from "../src/sync/progressTypes";
import { SyncPreviewModal } from "../src/ui/syncPreviewModal";
import { SyncPreviewReport } from "../src/sync/syncTypes";
import { UnifiedSyncEngine } from "../src/sync/unifiedSyncEngine";

interface FixtureEntry {
  path: string;
  bytes: Uint8Array;
  sha: string;
}

function makeSettings(): VaultRelaySettings {
  return { ...DEFAULT_SETTINGS, owner: "owner", repo: "repo", branch: "main" };
}

async function createMixedFixture(app: App, count: number): Promise<FixtureEntry[]> {
  const extensions = ["md", "txt", "canvas", "png", "jpg", "pdf", "bin"];
  const entries: FixtureEntry[] = [];
  for (let index = 0; index < count; index++) {
    const extension = extensions[index % extensions.length];
    const path = `folder-${index % 20}/file-${String(index).padStart(4, "0")}.${extension}`;
    const bytes = new TextEncoder().encode(`fixture-${index}-${extension}\n`);
    await app.vault.createBinary(path, bytes.buffer as ArrayBuffer);
    entries.push({ path, bytes, sha: await calculateCanonicalGitBlobSha(bytes, path) });
  }
  return entries;
}

function makeReadOnlyClient(entries: FixtureEntry[], calls?: { head: number; tree: number }): GitHubClient {
  return new GitHubClient({
    token: "github_pat_test_scale",
    owner: "owner",
    repo: "repo",
    branch: "main",
    requestFn: async (params) => {
      if (params.url.includes("/branches/")) {
        if (calls) calls.head++;
        return {
          status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "scale_commit", commit: { tree: { sha: "scale_tree" } } } },
        };
      }
      if (params.url.includes("/git/trees/")) {
        if (calls) calls.tree++;
        return {
          status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "scale_tree",
            truncated: false,
            tree: entries.map((entry) => ({
              path: entry.path,
              mode: "100644",
              type: "blob",
              sha: entry.sha,
              size: entry.bytes.byteLength,
            })),
          },
        };
      }
      throw new Error(`Unhandled URL: ${params.url}`);
    },
  });
}

const manifest: PluginManifest = {
  id: "github-vault-relay",
  name: "GitHub Vault Relay",
  version: "0.5.0",
  minAppVersion: "0.15.0",
  description: "test",
  author: "test",
};

describe("C5-SCALE: real engine and lifecycle measurements", () => {
  it("C5-SCALE-006: 100/500/1000 mixed-file Preview, render, and Unified planning stay bounded", async () => {
    const metrics: Array<Record<string, number>> = [];
    for (const count of [100, 500, 1000]) {
      const app = new App();
      const settings = makeSettings();
      const entries = await createMixedFixture(app, count);
      const client = makeReadOnlyClient(entries);
      const engine = new SyncEngine(app, settings, client);
      const heapBefore = process.memoryUsage().heapUsed;
      const inventoryStart = performance.now();
      expect(app.vault.getFiles()).toHaveLength(count);
      const inventoryMs = performance.now() - inventoryStart;

      const previewStart = performance.now();
      const report = await engine.generatePreview(true);
      const previewWallMs = performance.now() - previewStart;

      const plugin = new VaultRelayPlugin(app, manifest);
      plugin.settings = settings;
      const modal = new SyncPreviewModal(app, plugin);
      const renderable = modal as unknown as {
        report: SyncPreviewReport;
        renderReport: () => void;
      };
      renderable.report = report;
      const renderStart = performance.now();
      renderable.renderReport();
      const renderMs = performance.now() - renderStart;
      modal.contentEl.empty();

      const unifiedStart = performance.now();
      const unified = await new UnifiedSyncEngine(app, settings, client).executeSync();
      const unifiedPlanningMs = performance.now() - unifiedStart;
      const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

      expect(report.items).toHaveLength(count);
      expect(report.counts.UNCHANGED).toBe(count);
      expect(report.timings?.totalMs).toBeGreaterThanOrEqual(0);
      expect(previewWallMs).toBeLessThan(15_000);
      expect(renderMs).toBeLessThan(15_000);
      expect(unifiedPlanningMs).toBeLessThan(15_000);
      expect(heapDeltaBytes).toBeLessThan(256 * 1024 * 1024);
      expect(unified.status).toBe("PASS");

      metrics.push({
        files: count,
        inventoryMs: Number(inventoryMs.toFixed(2)),
        remoteHeadMs: report.timings?.remoteHeadMs || 0,
        remoteTreeMs: report.timings?.remoteTreeMs || 0,
        localScanAndHashMs: report.timings?.localScanMs || 0,
        classificationMs: report.timings?.classificationMs || 0,
        previewWallMs: Number(previewWallMs.toFixed(2)),
        renderMs: Number(renderMs.toFixed(2)),
        unifiedPlanningMs: Number(unifiedPlanningMs.toFixed(2)),
        heapDeltaBytes,
      });
    }
    console.info(`[C5-PERF] scale=${JSON.stringify(metrics)}`);
  }, 60_000);

  it("C5-SCALE-007: 10/50/100-file pushes use one commit and monotonic exact progress", async () => {
    const metrics: Array<Record<string, number>> = [];
    for (const count of [10, 50, 100]) {
      const app = new App();
      const settings = makeSettings();
      const entries = await createMixedFixture(app, count);
      let currentRef = "batch_base";
      let treeItems: Array<{ path: string; mode: string; type: "blob"; sha: string }> = [];
      let treeCreates = 0;
      let commitCreates = 0;
      let refUpdates = 0;
      const client = new GitHubClient({
        token: "github_pat_test_batch",
        owner: "owner", repo: "repo", branch: "main",
        requestFn: async (params) => {
          const method = params.method || "GET";
          if (params.url.includes("/git/ref/heads/main") && method === "GET") {
            return {
              status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { ref: "refs/heads/main", object: { sha: currentRef, type: "commit" } },
            };
          }
          if (params.url.includes("/branches/") && method === "GET") {
            return {
              status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { name: "main", commit: { sha: currentRef } },
            };
          }
          if (params.url.includes("/git/trees/batch_commit") && method === "GET") {
            return {
              status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { sha: "batch_tree", tree: treeItems, truncated: false },
            };
          }
          if (params.url.includes("/git/trees/") && method === "GET") {
            return {
              status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { sha: "base_tree", tree: [], truncated: false },
            };
          }
          if (params.url.includes("/git/blobs") && method === "POST") {
            const body = JSON.parse(params.body as string) as { content: string };
            return {
              status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { sha: await calculateRawGitBlobSha(Buffer.from(body.content, "base64")) },
            };
          }
          if (params.url.includes("/git/trees") && method === "POST") {
            treeCreates++;
            const body = JSON.parse(params.body as string) as { tree: typeof treeItems };
            treeItems = body.tree;
            return {
              status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { sha: "batch_tree" },
            };
          }
          if (params.url.includes("/git/commits") && method === "POST") {
            commitCreates++;
            return {
              status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { sha: "batch_commit", tree: { sha: "batch_tree" }, parents: [{ sha: "batch_base" }] },
            };
          }
          if (params.url.includes("/git/refs/heads/main") && method === "PATCH") {
            refUpdates++;
            currentRef = "batch_commit";
            return {
              status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { ref: "refs/heads/main", object: { sha: currentRef, type: "commit" } },
            };
          }
          throw new Error(`Unhandled URL: ${params.url}`);
        },
      });
      const progress: SyncProgressEvent[] = [];
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const report = await new PushEngine(app, settings, client).executeSafePush((event) => progress.push(event));
      const durationMs = performance.now() - started;
      const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
      const uploads = progress.filter((event) => event.phase === "UPLOADING");

      expect(report.status).toBe("PASS");
      expect(report.counts.pushedCreated).toBe(count);
      expect(treeItems).toHaveLength(count);
      expect(treeCreates).toBe(1);
      expect(commitCreates).toBe(1);
      expect(refUpdates).toBe(1);
      expect(uploads.map((event) => event.completed)).toEqual(
        Array.from({ length: count }, (_, index) => index + 1)
      );
      expect(uploads.every((event) => event.total === count)).toBe(true);
      expect(heapDeltaBytes).toBeLessThan(256 * 1024 * 1024);
      metrics.push({
        files: count,
        durationMs: Number(durationMs.toFixed(2)),
        heapDeltaBytes,
        commits: commitCreates,
        refUpdates,
      });
      expect(entries).toHaveLength(count);
    }
    console.info(`[C5-PERF] batch=${JSON.stringify(metrics)}`);
  }, 60_000);

  it("C5-SCALE-008: 100 Preview cycles retain only live file hashes", async () => {
    const app = new App();
    const entries = await createMixedFixture(app, 100);
    const calls = { head: 0, tree: 0 };
    const engine = new SyncEngine(app, makeSettings(), makeReadOnlyClient(entries, calls));
    const heapBefore = process.memoryUsage().heapUsed;

    for (let cycle = 0; cycle < 100; cycle++) {
      const report = await engine.generatePreview();
      expect(report.items).toHaveLength(100);
    }

    expect(engine.localHashCacheSize).toBe(100);
    expect(calls).toEqual({ head: 100, tree: 100 });
    expect(Math.max(0, process.memoryUsage().heapUsed - heapBefore)).toBeLessThan(128 * 1024 * 1024);
  }, 60_000);

  it("C5-SCALE-009: 100 no-change Sync cycles complete without mutation or retained lock", async () => {
    const app = new App();
    const settings = makeSettings();
    const calls = { head: 0, tree: 0 };
    const client = makeReadOnlyClient([], calls);
    const engine = new UnifiedSyncEngine(app, settings, client);

    for (let cycle = 0; cycle < 100; cycle++) {
      expect((await engine.executeSync()).status).toBe("PASS");
      expect(engine.isRunning).toBe(false);
    }

    expect(calls).toEqual({ head: 100, tree: 100 });
  }, 60_000);

  it("C5-SCALE-010: constructing engines does not multiply vault event listeners", () => {
    const app = new App();
    let listenerRegistrations = 0;
    (app.vault as unknown as { on: () => void }).on = () => { listenerRegistrations++; };
    const client = makeReadOnlyClient([]);

    for (let index = 0; index < 100; index++) {
      new SyncEngine(app, makeSettings(), client);
    }

    expect(listenerRegistrations).toBe(0);
  });
});
