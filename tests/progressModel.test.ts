import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import { PullEngine } from "../src/sync/pullEngine";
import { PushEngine } from "../src/sync/pushEngine";
import { GitHubClient } from "../src/github/githubClient";
import { SyncProgressEvent, getPhaseLabel } from "../src/sync/progressTypes";
import { calculateCanonicalGitBlobSha, calculateRawGitBlobSha } from "../src/sync/hashUtils";

describe("Truthful Operation Progress Model (PROGRESS-001..006)", () => {
  let app: App;
  const settings = {
    owner: "octocat",
    repo: "notes",
    branch: "main",
    excludedPaths: [],
  };

  beforeEach(() => {
    app = new App();
  });

  it("PROGRESS-001: Safe Pull emits PLANNING, DOWNLOADING with file counts, UPDATING_STATE, COMPLETE", async () => {
    const fileContent = "# Note Title\nContent body\n";
    const remoteSha = await calculateCanonicalGitBlobSha(fileContent, "file1.md");
    const events: SyncProgressEvent[] = [];

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c", commit: { tree: { sha: "t" } } } },
        };
      }
      if (params.url.includes("/git/trees/t")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "t",
            truncated: false,
            tree: [{ path: "file1.md", mode: "100644", type: "blob", sha: remoteSha, size: fileContent.length }],
          },
        };
      }
      if (params.url.includes("/git/blobs")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: remoteSha, size: fileContent.length, encoding: "base64", content: Buffer.from(fileContent).toString("base64") },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const pullEngine = new PullEngine(app, settings, client);

    await pullEngine.executeSafePull((evt) => events.push(evt));

    const phases = events.map((e) => e.phase);
    expect(phases).toContain("PLANNING");
    expect(phases).toContain("DOWNLOADING");
    expect(phases).toContain("UPDATING_STATE");
    expect(phases).toContain("COMPLETE");

    const dlEvent = events.find((e) => e.phase === "DOWNLOADING");
    expect(dlEvent?.total).toBe(1);
    expect(dlEvent?.completed).toBe(1);
    expect(dlEvent?.currentPath).toBe("file1.md");
  });

  it("PROGRESS-002: Safe Push emits PLANNING, UPLOADING, CREATING_TREE, CREATING_COMMIT, UPDATING_REF, COMPLETE", async () => {
    const fileContent = "hello push\n";
    await app.vault.create("push-me.md", fileContent);
    const expectedSha = await calculateRawGitBlobSha(new TextEncoder().encode(fileContent));
    const events: SyncProgressEvent[] = [];

    const fakeRequestFn = vi.fn(async (params: { url: string; method?: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c_base", commit: { tree: { sha: "t_base" } } } },
        };
      }
      if (params.url.includes("/git/trees/sha_c_new")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "sha_c_new", truncated: false, tree: [{ path: "push-me.md", mode: "100644", type: "blob", sha: expectedSha, size: fileContent.length }] },
        };
      }
      if (params.url.includes("/git/trees") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "sha_t_new" },
        };
      }
      if (params.url.includes("/git/trees/")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "t_base", truncated: false, tree: [] },
        };
      }
      if (params.url.includes("/git/blobs") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: expectedSha },
        };
      }
      if (params.url.includes("/git/commits") && params.method === "POST") {
        return {
          status: 201,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { sha: "sha_c_new" },
        };
      }
      if (params.url.includes("/git/refs/heads/main") && params.method === "PATCH") {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "sha_c_new" } },
        };
      }
      if (params.url.includes("/git/ref/heads/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "sha_c_new" } },
        };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const pushEngine = new PushEngine(app, settings, client);

    await pushEngine.executeSafePush((evt) => events.push(evt));
        const phases = events.map((e) => e.phase);
    expect(phases).toContain("PLANNING");
    expect(phases).toContain("UPLOADING");
    expect(phases).toContain("CREATING_TREE");
    expect(phases).toContain("CREATING_COMMIT");
    expect(phases).toContain("UPDATING_REF");
    expect(phases).toContain("COMPLETE");
  });

  it("PROGRESS-005: Phase labels are descriptive and human-readable", () => {
    expect(getPhaseLabel("SCANNING")).toContain("Scanning");
    expect(getPhaseLabel("DOWNLOADING")).toContain("Downloading");
    expect(getPhaseLabel("UPLOADING")).toContain("Uploading");
    expect(getPhaseLabel("CREATING_COMMIT")).toContain("commit");
    expect(getPhaseLabel("COMPLETE")).toContain("complete");
  });
  it("PROGRESS-003: Unified Sync emits continuous progress events spanning Pull and Push", async () => {
    const { UnifiedSyncEngine } = await import("../src/sync/unifiedSyncEngine");
    const events: SyncProgressEvent[] = [];

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c_sync", commit: { tree: { sha: "t_sync" } } } },
        };
      }
      if (params.url.includes("/git/trees/t_sync")) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: "t_sync", truncated: false, tree: [] } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const unified = new UnifiedSyncEngine(app, settings, client);

    await unified.executeSync((evt) => events.push(evt));
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("SCANNING");
    expect(phases).toContain("COMPLETE");
  });

  it("PROGRESS-004: Failed operation emits failure progress and retains exact failing phase", async () => {
    const events: SyncProgressEvent[] = [];
    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        throw new Error("Network timeout connecting to GitHub");
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const pullEngine = new PullEngine(app, settings, client);

    const report = await pullEngine.executeSafePull((evt) => events.push(evt));
    expect(report.status).toBe("FAIL");

    // Must have emitted at least PLANNING phase before failure
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].phase).toBe("PLANNING");
    // Did NOT emit COMPLETE on failure
    expect(events.some((e) => e.phase === "COMPLETE")).toBe(false);
  });

  it("PROGRESS-006: Progress file count completed is monotonic during downloads and uploads", async () => {
    const fileContent1 = "content 1";
    const fileContent2 = "content 2";
    const sha1 = await calculateCanonicalGitBlobSha(fileContent1, "f1.md");
    const sha2 = await calculateCanonicalGitBlobSha(fileContent2, "f2.md");
    const events: SyncProgressEvent[] = [];

    const fakeRequestFn = vi.fn(async (params: { url: string }) => {
      if (params.url.includes("/branches/main")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: { name: "main", commit: { sha: "c2", commit: { tree: { sha: "t2" } } } },
        };
      }
      if (params.url.includes("/git/trees/t2")) {
        return {
          status: 200,
          headers: {},
          text: "",
          arrayBuffer: new ArrayBuffer(0),
          json: {
            sha: "t2",
            truncated: false,
            tree: [
              { path: "f1.md", mode: "100644", type: "blob", sha: sha1, size: fileContent1.length },
              { path: "f2.md", mode: "100644", type: "blob", sha: sha2, size: fileContent2.length },
            ],
          },
        };
      }
      if (params.url.includes("/git/blobs/" + sha1)) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: sha1, size: fileContent1.length, encoding: "utf-8", content: fileContent1 } };
      }
      if (params.url.includes("/git/blobs/" + sha2)) {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: { sha: sha2, size: fileContent2.length, encoding: "utf-8", content: fileContent2 } };
      }
      throw new Error("Unhandled: " + params.url);
    });

    const client = new GitHubClient({ token: "tok", owner: "octocat", repo: "notes", branch: "main", requestFn: fakeRequestFn });
    const pullEngine = new PullEngine(app, settings, client);

    await pullEngine.executeSafePull((evt) => events.push(evt));

    const dlEvents = events.filter((e) => e.phase === "DOWNLOADING");
    expect(dlEvents.length).toBe(2);
    expect(dlEvents[0].completed).toBe(1);
    expect(dlEvents[1].completed).toBe(2);
    expect(dlEvents[0].completed).toBeLessThanOrEqual(dlEvents[1].completed);
  });
});
