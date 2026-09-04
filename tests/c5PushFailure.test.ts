/**
 * C5-PUSHFAIL: Push Engine Failure Injection Tests
 *
 * Simulates failures at every phase of Safe Push:
 * - preflight, blob upload, tree creation, commit creation,
 *   PATCH ref, post-ref verification, state save
 *
 * Verifies:
 * - no force push
 * - no false baseline
 * - uncertain remote success remains conservative
 */

import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import { PushEngine } from "../src/sync/pushEngine";
import { GitHubClient } from "../src/github/githubClient";
import { VaultRelaySettings, DEFAULT_SETTINGS } from "../src/settings";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";
import { StorageManager } from "../src/sync/storageManager";

function makeSettings(overrides?: Partial<VaultRelaySettings>): VaultRelaySettings {
  return { ...DEFAULT_SETTINGS, owner: "owner", repo: "repo", branch: "main", ...overrides };
}

describe("C5-PUSHFAIL: Push Failure Injection (C5-PUSHFAIL-001..015)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
  });

  async function setupPushableVault(): Promise<{ localSha: string; fileContent: Uint8Array }> {
    const fileContent = new TextEncoder().encode("local only content for push");
    const localSha = await calculateCanonicalGitBlobSha(fileContent, "new-note.md");
    await app.vault.createBinary("new-note.md", fileContent.buffer as ArrayBuffer);
    await StorageManager.saveState(app, {
      version: 1,
      lastSyncedCommitSha: "base_commit",
      lastSyncedAt: Date.now(),
      files: {},
    });
    return { localSha, fileContent };
  }

  function makePushClient(phaseFail: string): GitHubClient {
    let uploadedBlobSha: string | undefined;
    return new GitHubClient({
      token: "github_pat_test_pushfail",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        const url = params.url;
        const method = params.method || "GET";

        // Branch fetch (GET)
        if (url.includes("/branches/") && method === "GET") {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: {
              name: "main",
              commit: {
                sha: "base_commit",
                commit: { tree: { sha: "base_tree_sha" } },
              },
            },
            text: "",
          };
        }

        // Tree fetch (GET)
        if (url.includes("/git/trees/") && method === "GET") {
          if (url.includes("/git/trees/new_commit_sha") && uploadedBlobSha) {
            return {
              status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
              json: {
                sha: "new_tree_sha",
                tree: [{ path: "new-note.md", mode: "100644", type: "blob", sha: uploadedBlobSha }],
                truncated: false,
              },
              text: "",
            };
          }
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "base_tree_sha", tree: [], truncated: false },
            text: "",
          };
        }

        // Blob create (POST)
        if (url.includes("/git/blobs") && method === "POST") {
          if (phaseFail === "blob") {
            return {
              status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0),
              json: { message: "Internal Server Error" }, text: "",
            };
          }
          const body = params.body ? JSON.parse(params.body as string) : {};
          const blobSha = await calculateRawGitBlobSha(
            Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0))
          );
          uploadedBlobSha = blobSha;
          return {
            status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: blobSha, url: "https://api.github.com/blob" },
            text: "",
          };
        }

        // Tree create (POST)
        if (url.includes("/git/trees") && method === "POST") {
          if (phaseFail === "tree") {
            return {
              status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0),
              json: { message: "Tree creation failed" }, text: "",
            };
          }
          return {
            status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "new_tree_sha", tree: [], truncated: false },
            text: "",
          };
        }

        // Commit create (POST)
        if (url.includes("/git/commits") && method === "POST") {
          if (phaseFail === "commit") {
            return {
              status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0),
              json: { message: "Commit creation failed" }, text: "",
            };
          }
          return {
            status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: {
              sha: "new_commit_sha",
              message: "test",
              tree: { sha: "new_tree_sha" },
              parents: [{ sha: "base_commit" }],
            },
            text: "",
          };
        }

        // Ref update (PATCH)
        if (url.includes("/git/refs/") && method === "PATCH") {
          if (phaseFail === "ref") {
            return {
              status: 422, headers: {}, arrayBuffer: new ArrayBuffer(0),
              json: { message: "Update is not a fast forward" }, text: "",
            };
          }
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: {
              ref: "refs/heads/main",
              object: { sha: "new_commit_sha", type: "commit" },
            },
            text: "",
          };
        }

        // Ref verification (GET)
        if (url.includes("/git/ref/") && method === "GET") {
          if (phaseFail === "verify") {
            return {
              status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
              json: {
                ref: "refs/heads/main",
                object: { sha: "WRONG_SHA", type: "commit" },
              },
              text: "",
            };
          }
          if (phaseFail === "ref") {
            return {
              status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
              json: {
                ref: "refs/heads/main",
                object: { sha: "base_commit", type: "commit" },
              },
              text: "",
            };
          }
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: {
              ref: "refs/heads/main",
              object: { sha: "new_commit_sha", type: "commit" },
            },
            text: "",
          };
        }

        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
  }

  it("C5-PUSHFAIL-001: Preflight branch fetch failure → ABORTED, no mutation", async () => {
    await setupPushableVault();
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test_preflight",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => ({
        status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0),
        json: { message: "Server Error" }, text: "",
      }),
    });
    const engine = new PushEngine(app, settings, client);

    const report = await engine.executeSafePush();
    expect(report.status).toBe("ABORTED");
    expect(report.newCommitSha).toBeUndefined();
  });

  it("C5-PUSHFAIL-002: Blob upload failure → FAIL, no commit created", async () => {
    await setupPushableVault();
    const settings = makeSettings();
    const client = makePushClient("blob");
    const engine = new PushEngine(app, settings, client);

    const report = await engine.executeSafePush();
    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("Blob upload failed");
    expect(report.newCommitSha).toBeUndefined();
  });

  it("C5-PUSHFAIL-003: Tree creation failure → FAIL, no commit created", async () => {
    await setupPushableVault();
    const settings = makeSettings();
    const client = makePushClient("tree");
    const engine = new PushEngine(app, settings, client);

    const report = await engine.executeSafePush();
    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("Tree creation failed");
    expect(report.newCommitSha).toBeUndefined();
  });

  it("C5-PUSHFAIL-004: Commit creation failure → FAIL, no ref update", async () => {
    await setupPushableVault();
    const settings = makeSettings();
    const client = makePushClient("commit");
    const engine = new PushEngine(app, settings, client);

    const report = await engine.executeSafePush();
    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("Commit creation failed");
    expect(report.newCommitSha).toBeUndefined();
  });

  it("C5-PUSHFAIL-005: PATCH ref 422 (not fast-forward) → ABORTED, baseline unchanged", async () => {
    await setupPushableVault();
    const settings = makeSettings();
    const client = makePushClient("ref");
    const engine = new PushEngine(app, settings, client);

    const report = await engine.executeSafePush();
    expect(report.status).toBe("ABORTED");
    expect(report.summaryMessage).toContain("concurrency");

    // Baseline should not advance
    const state = await StorageManager.loadState(app);
    expect(state.lastSyncedCommitSha).toBe("base_commit");
  });

  it("C5-PUSHFAIL-006: Post-ref verification mismatch → FAIL, baseline NOT updated", async () => {
    await setupPushableVault();
    const settings = makeSettings();
    const client = makePushClient("verify");
    const engine = new PushEngine(app, settings, client);

    const report = await engine.executeSafePush();
    expect(report.status).toBe("FAIL");
    expect(report.summaryMessage).toContain("verification failed");

    // Baseline should not advance despite ref success
    const state = await StorageManager.loadState(app);
    expect(state.lastSyncedCommitSha).toBe("base_commit");
  });

  it("C5-PUSHFAIL-007: Force push parameter always false in PATCH body", async () => {
    await setupPushableVault();
    const settings = makeSettings();
    let patchBody: Record<string, unknown> | null = null;
    const client = new GitHubClient({
      token: "github_pat_test_forceflag",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        const method = params.method || "GET";
        if (method === "PATCH" && params.url.includes("/git/refs/")) {
          patchBody = params.body ? JSON.parse(params.body as string) : null;
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { ref: "refs/heads/main", object: { sha: "new_commit_sha", type: "commit" } },
            text: "",
          };
        }
        // Pass through other calls
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "base_commit", commit: { tree: { sha: "tree_sha" } } } },
            text: "",
          };
        }
        if (params.url.includes("/git/trees/") && method === "GET") {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_sha", tree: [], truncated: false },
            text: "",
          };
        }
        if (params.url.includes("/git/blobs") && method === "POST") {
          const body = params.body ? JSON.parse(params.body as string) : {};
          const sha = await calculateRawGitBlobSha(
            Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0))
          );
          return {
            status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha, url: "" }, text: "",
          };
        }
        if (params.url.includes("/git/trees") && method === "POST") {
          return {
            status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "new_tree", tree: [] }, text: "",
          };
        }
        if (params.url.includes("/git/commits") && method === "POST") {
          return {
            status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "new_commit_sha", message: "", tree: { sha: "new_tree" }, parents: [{ sha: "base_commit" }] },
            text: "",
          };
        }
        if (params.url.includes("/git/ref/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { ref: "refs/heads/main", object: { sha: "new_commit_sha", type: "commit" } },
            text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
    const engine = new PushEngine(app, settings, client);

    await engine.executeSafePush();

    expect(patchBody).toBeTruthy();
    expect(patchBody!.force).toBe(false);
  });

  it("C5-PUSHFAIL-008: Offline preflight → ABORTED immediately", async () => {
    await setupPushableVault();
    const originalNavigator = globalThis.navigator;
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        configurable: true,
        writable: true,
      });

      const settings = makeSettings();
      const client = new GitHubClient({
        token: "github_pat_test",
        owner: "owner", repo: "repo", branch: "main",
        requestFn: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" }),
      });
      const engine = new PushEngine(app, settings, client);

      const report = await engine.executeSafePush();
      expect(report.status).toBe("ABORTED");
      expect(report.summaryMessage).toContain("offline");
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    }
  });

  it("C5-PUSHFAIL-009: No eligible push items → PASS with no mutation", async () => {
    // All files unchanged
    const fileContent = new TextEncoder().encode("unchanged file");
    const sha = await calculateCanonicalGitBlobSha(fileContent, "notes/hello.md");
    await app.vault.createBinary("notes/hello.md", fileContent.buffer as ArrayBuffer);

    await StorageManager.saveState(app, {
      version: 1,
      lastSyncedCommitSha: "current_commit",
      lastSyncedAt: Date.now(),
      files: {
        "notes/hello.md": { localSha: sha, remoteSha: sha, syncedAt: Date.now() },
      },
    });

    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: {
              name: "main",
              commit: {
                sha: "current_commit",
                commit: { tree: { sha: "current_tree" } },
              },
            },
            text: "",
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: {
              sha: "current_tree",
              tree: [{ path: "notes/hello.md", type: "blob", sha, mode: "100644", size: fileContent.length }],
              truncated: false,
            },
            text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
    const engine = new PushEngine(app, settings, client);

    const report = await engine.executeSafePush();
    expect(report.status).toBe("PASS");
    expect(report.newCommitSha).toBeUndefined();
    expect(report.counts.pushedCreated).toBe(0);
    expect(report.counts.pushedUpdated).toBe(0);
  });

  it("C5-PUSHFAIL-010: Truncated remote tree → ABORTED before any mutation", async () => {
    await setupPushableVault();
    const settings = makeSettings();
    const client = new GitHubClient({
      token: "github_pat_test",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "base_commit", commit: { tree: { sha: "tree_sha" } } } },
            text: "",
          };
        }
        if (params.url.includes("/git/trees/")) {
          return {
            status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
            json: { sha: "tree_sha", tree: [], truncated: true },
            text: "",
          };
        }
        return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "" };
      },
    });
    const engine = new PushEngine(app, settings, client);

    const report = await engine.executeSafePush();
    expect(report.status).toBe("ABORTED");
    expect(report.summaryMessage).toContain("truncated");
    expect(report.newCommitSha).toBeUndefined();
  });

  it("C5-PUSHFAIL-011: blob failures at first, middle, and last never create a commit", async () => {
    for (const failedIndex of [0, 1, 2]) {
      const isolatedApp = new App();
      const entries = await Promise.all(
        ["a.md", "b.md", "c.md"].map(async (path) => {
          const bytes = new TextEncoder().encode(`local ${path}\n`);
          await isolatedApp.vault.createBinary(path, bytes.buffer as ArrayBuffer);
          return { path, bytes, sha: await calculateRawGitBlobSha(bytes) };
        })
      );
      const failedContent = new TextDecoder().decode(entries[failedIndex].bytes);
      let treeCreates = 0;
      let commitCreates = 0;
      let refUpdates = 0;
      const client = new GitHubClient({
        token: "github_pat_test_batch_failure",
        owner: "owner", repo: "repo", branch: "main",
        requestFn: async (params) => {
          const method = params.method || "GET";
          if (params.url.includes("/branches/") && method === "GET") {
            return {
              status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { name: "main", commit: { sha: "base_commit" } },
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
            const decoded = Buffer.from(body.content, "base64").toString("utf8");
            if (decoded === failedContent) {
              return {
                status: 500, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
                json: { message: "injected batch blob failure" },
              };
            }
            return {
              status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
              json: { sha: await calculateRawGitBlobSha(Buffer.from(body.content, "base64")) },
            };
          }
          if (params.url.includes("/git/trees") && method === "POST") treeCreates++;
          if (params.url.includes("/git/commits") && method === "POST") commitCreates++;
          if (params.url.includes("/git/refs/") && method === "PATCH") refUpdates++;
          throw new Error(`Unexpected mutation after blob failure: ${params.url}`);
        },
      });

      const report = await new PushEngine(isolatedApp, makeSettings(), client).executeSafePush();

      expect(report.status).toBe("FAIL");
      expect(treeCreates).toBe(0);
      expect(commitCreates).toBe(0);
      expect(refUpdates).toBe(0);
      expect((await StorageManager.loadState(isolatedApp)).lastSyncedCommitSha).toBeUndefined();
    }
  });

  it("C5-PUSHFAIL-012: lost PATCH response is recovered only from authoritative ref verification", async () => {
    const { localSha, fileContent } = await setupPushableVault();
    let currentRef = "base_commit";
    let commitCreates = 0;
    let refUpdates = 0;
    const client = new GitHubClient({
      token: "github_pat_test_lost_patch",
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
        if (params.url.includes("/git/trees/base_commit") && method === "GET") {
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: "base_tree", tree: [], truncated: false },
          };
        }
        if (params.url.includes("/git/blobs") && method === "POST") {
          return {
            status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: localSha },
          };
        }
        if (params.url.includes("/git/trees") && method === "POST") {
          return {
            status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: "new_tree" },
          };
        }
        if (params.url.includes("/git/commits") && method === "POST") {
          commitCreates++;
          return {
            status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: "new_commit", tree: { sha: "new_tree" }, parents: [{ sha: "base_commit" }] },
          };
        }
        if (params.url.includes("/git/refs/heads/main") && method === "PATCH") {
          refUpdates++;
          currentRef = "new_commit";
          throw new Error("connection reset after server accepted PATCH");
        }
        if (params.url.includes("/git/trees/new_commit") && method === "GET") {
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: {
              sha: "new_tree", truncated: false,
              tree: [{ path: "new-note.md", mode: "100644", type: "blob", sha: localSha, size: fileContent.byteLength }],
            },
          };
        }
        throw new Error(`Unhandled URL: ${params.url}`);
      },
    });

    const report = await new PushEngine(app, makeSettings(), client).executeSafePush();

    expect(report.status).toBe("PASS");
    expect(commitCreates).toBe(1);
    expect(refUpdates).toBe(1);
    expect((await StorageManager.loadState(app)).lastSyncedCommitSha).toBe("new_commit");
  });

  it("C5-PUSHFAIL-013: verified remote success plus state failure reports warning and keeps old baseline", async () => {
    await setupPushableVault();
    const originalWrite = app.vault.adapter.write;
    app.vault.adapter.write = async (target, data) => {
      if (target === `${StorageManager.getStateFilePath(app)}.tmp`) {
        throw new Error("injected state save failure");
      }
      await originalWrite(target, data);
    };

    const report = await new PushEngine(app, makeSettings(), makePushClient("")).executeSafePush();
    app.vault.adapter.write = originalWrite;

    expect(report.status).toBe("PASS_WITH_WARNINGS");
    expect(report.summaryMessage).toContain("could not be saved");
    expect((await StorageManager.loadState(app)).lastSyncedCommitSha).toBe("base_commit");
  });

  it("C5-PUSHFAIL-014: local edit after commit creation blocks branch ref update", async () => {
    const { localSha } = await setupPushableVault();
    let patchCount = 0;
    const client = new GitHubClient({
      token: "github_pat_test_local_race",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async (params) => {
        const method = params.method || "GET";
        if (params.url.includes("/branches/")) {
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { name: "main", commit: { sha: "base_commit" } },
          };
        }
        if (params.url.includes("/git/trees/") && method === "GET") {
          return {
            status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: "base_tree", tree: [], truncated: false },
          };
        }
        if (params.url.includes("/git/blobs") && method === "POST") {
          return {
            status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: localSha },
          };
        }
        if (params.url.includes("/git/trees") && method === "POST") {
          return {
            status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: "new_tree" },
          };
        }
        if (params.url.includes("/git/commits") && method === "POST") {
          const file = app.vault.getAbstractFileByPath("new-note.md");
          if (file) await app.vault.modify(file as never, "edited while push was in flight");
          return {
            status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0),
            json: { sha: "dangling_commit", tree: { sha: "new_tree" }, parents: [{ sha: "base_commit" }] },
          };
        }
        if (params.url.includes("/git/refs/") && method === "PATCH") patchCount++;
        throw new Error(`Unhandled URL: ${params.url}`);
      },
    });

    const report = await new PushEngine(app, makeSettings(), client).executeSafePush();

    expect(report.status).toBe("ABORTED");
    expect(report.summaryMessage).toContain("Local file changed during Push");
    expect(patchCount).toBe(0);
    expect((await StorageManager.loadState(app)).lastSyncedCommitSha).toBe("base_commit");
  });

  it("C5-PUSHFAIL-015: ambiguous mutation network failures are never retried blindly", async () => {
    let attempts = 0;
    const client = new GitHubClient({
      token: "github_pat_test_no_mutation_retry",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => {
        attempts++;
        throw new Error("response lost after mutation request");
      },
    });

    await expect(client.createCommit("message", "tree", ["parent"])).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});
