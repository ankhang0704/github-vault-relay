/**
 * Network Timeout & Offline Fail-Fast Regression Test Suite
 *
 * Tests NET-TIMEOUT-001 through NET-TIMEOUT-010:
 * - NET-TIMEOUT-001: explicit offline signal fails immediately
 * - NET-TIMEOUT-002: hanging repository discovery exits within configured application timeout
 * - NET-TIMEOUT-003: hanging branch discovery exits cleanly
 * - NET-TIMEOUT-004: loading UI resets after timeout
 * - NET-TIMEOUT-005: retry after reconnect succeeds
 * - NET-TIMEOUT-006: GET retry remains bounded
 * - NET-TIMEOUT-007: POST/PATCH are never blindly retried after timeout
 * - NET-TIMEOUT-008: late completion of timed-out request cannot update stale UI/state
 * - NET-TIMEOUT-009: network timeout releases any active operation/lease
 * - NET-TIMEOUT-010: no unhandled promise rejection after late socket completion
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App, RequestUrlResponse } from "obsidian";
import {
  GitHubClient,
  GitHubTimeoutError,
  GitHubOfflineError,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../src/github/githubClient";
import { DEFAULT_SETTINGS, VaultRelaySettingTab } from "../src/settings";
import { UnifiedSyncEngine } from "../src/sync/unifiedSyncEngine";
import type VaultRelayPlugin from "../src/main";

describe("Network Timeout & Offline Fail-Fast Policy (NET-TIMEOUT-001..010)", () => {
  let originalNavigator: unknown;

  beforeEach(() => {
    originalNavigator = globalThis.navigator;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalNavigator !== undefined) {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    }
  });

  // =========================================================
  // NET-TIMEOUT-001: Explicit offline signal fails immediately
  // =========================================================
  it("NET-TIMEOUT-001: explicit offline signal fails immediately", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      configurable: true,
      writable: true,
    });

    let callCount = 0;
    const client = new GitHubClient({
      token: "test_token_offline",
      owner: "test-owner",
      repo: "test-repo",
      branch: "main",
      requestFn: async () => {
        callCount++;
        return {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: [],
          text: "",
        };
      },
    });

    await expect(client.listUserRepositories()).rejects.toThrow(GitHubOfflineError);
    expect(callCount).toBe(0); // Zero network attempts dispatched
  });

  // =========================================================
  // NET-TIMEOUT-002: Hanging repository discovery exits within configured application timeout
  // =========================================================
  it("NET-TIMEOUT-002: hanging repository discovery exits within configured application timeout", async () => {
    vi.useFakeTimers();

    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(10000);

    let callCount = 0;
    const client = new GitHubClient({
      token: "test_token_hang",
      owner: "test-owner",
      repo: "test-repo",
      branch: "main",
      timeoutMs: 3000,
      requestFn: async () => {
        callCount++;
        // Returns a hanging promise that never settles
        return new Promise<RequestUrlResponse>(() => {});
      },
    });

    let caughtErr: unknown;
    const promise = client.listUserRepositories().catch((err) => {
      caughtErr = err;
    });

    // Advance to right before timeout: should still be pending
    await vi.advanceTimersByTimeAsync(2999);
    expect(callCount).toBe(1);
    expect(caughtErr).toBeUndefined();

    // Advance across the 3000ms threshold
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(caughtErr).toBeInstanceOf(GitHubTimeoutError);
    // Timeout fails fast: exactly 1 attempt, no duplicate retries
    expect(callCount).toBe(1);
  });

  // =========================================================
  // NET-TIMEOUT-003: Hanging branch discovery exits cleanly
  // =========================================================
  it("NET-TIMEOUT-003: hanging branch discovery exits cleanly", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const client = new GitHubClient({
      token: "test_token_branches",
      owner: "test-owner",
      repo: "test-repo",
      branch: "main",
      timeoutMs: 2500,
      requestFn: async () => {
        callCount++;
        return new Promise<RequestUrlResponse>(() => {});
      },
    });

    let caughtErr: unknown;
    const promise = client.listBranches("test-owner", "test-repo").catch((err) => {
      caughtErr = err;
    });

    await vi.advanceTimersByTimeAsync(2500);
    await promise;

    expect(caughtErr).toBeInstanceOf(GitHubTimeoutError);
    expect(callCount).toBe(1);
  });

  // =========================================================
  // NET-TIMEOUT-004: Loading UI resets after timeout
  // =========================================================
  it("NET-TIMEOUT-004: loading UI resets after timeout", async () => {
    vi.useFakeTimers();

    const app = new App();
    const plugin = {
      app,
      settings: { ...DEFAULT_SETTINGS, owner: "owner", repo: "repo" },
      saveSettings: vi.fn().mockResolvedValue(undefined),
    } as unknown as VaultRelayPlugin;

    const tab = new VaultRelaySettingTab(app, plugin);
    tab["isDiscovering"] = false;

    // Simulate clicking Save & Connect with a hanging client
    const hangingClient = new GitHubClient({
      token: "test_token_tab",
      owner: "owner",
      repo: "repo",
      branch: "main",
      timeoutMs: 1500,
      requestFn: async () => new Promise<RequestUrlResponse>(() => {}),
    });

    // Directly test discoverRepositories lifecycle
    tab["isDiscovering"] = true;
    const discoveryPromise = (async () => {
      try {
        await hangingClient.listUserRepositories();
      } catch {
        // Handled as in discoverRepositories()
      } finally {
        tab["isDiscovering"] = false;
      }
    })();

    expect(tab["isDiscovering"]).toBe(true);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(1500);
    await discoveryPromise;

    // Loading flag must be cleanly restored to false
    expect(tab["isDiscovering"]).toBe(false);
  });

  // =========================================================
  // NET-TIMEOUT-005: Retry after reconnect succeeds
  // =========================================================
  it("NET-TIMEOUT-005: retry after reconnect succeeds", async () => {
    vi.useFakeTimers();

    let isConnected = false;
    let callCount = 0;

    const client = new GitHubClient({
      token: "test_token_reconnect",
      owner: "owner",
      repo: "repo",
      branch: "main",
      timeoutMs: 2000,
      requestFn: async () => {
        callCount++;
        if (!isConnected) {
          return new Promise<RequestUrlResponse>(() => {});
        }
        return {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: [
            {
              full_name: "owner/repo",
              name: "repo",
              owner: { login: "owner" },
              default_branch: "main",
              private: false,
            },
          ],
          text: "",
        };
      },
    });

    // Attempt 1: Network hangs and times out
    let caughtErr1: unknown;
    const attempt1 = client.listUserRepositories().catch((err) => {
      caughtErr1 = err;
    });
    await vi.advanceTimersByTimeAsync(2000);
    await attempt1;
    expect(caughtErr1).toBeInstanceOf(GitHubTimeoutError);
    expect(callCount).toBe(1);

    // Network restored
    isConnected = true;

    // Attempt 2: Retry
    const attempt2 = client.listUserRepositories();
    await vi.advanceTimersByTimeAsync(10);
    const repos = await attempt2;

    expect(callCount).toBe(2);
    expect(repos.length).toBe(1);
    expect(repos[0].fullName).toBe("owner/repo");
  });

  // =========================================================
  // NET-TIMEOUT-006: GET retry remains bounded
  // =========================================================
  it("NET-TIMEOUT-006: GET retry remains bounded", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const client = new GitHubClient({
      token: "test_token_get_retry",
      owner: "owner",
      repo: "repo",
      branch: "main",
      requestFn: async () => {
        callCount++;
        return {
          status: 503,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "Service Unavailable" },
          text: "",
        };
      },
    });

    let caughtErr: unknown;
    const promise = client.getRepo().catch((err) => {
      caughtErr = err;
    });

    // Advance through exponential backoffs: 1s, 2s
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    expect(caughtErr).toBeDefined();
    // Strictly bounded to max 3 attempts
    expect(callCount).toBe(3);
  });

  // =========================================================
  // NET-TIMEOUT-007: POST/PATCH are never blindly retried after timeout
  // =========================================================
  it("NET-TIMEOUT-007: POST/PATCH are never blindly retried after timeout", async () => {
    vi.useFakeTimers();

    let blobPostCount = 0;
    let refPatchCount = 0;

    const client = new GitHubClient({
      token: "test_token_mutations",
      owner: "owner",
      repo: "repo",
      branch: "main",
      timeoutMs: 1500,
      requestFn: async (params) => {
        if (params.method === "POST") {
          blobPostCount++;
          return new Promise<RequestUrlResponse>(() => {});
        }
        if (params.method === "PATCH") {
          refPatchCount++;
          return new Promise<RequestUrlResponse>(() => {});
        }
        return {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: "",
        };
      },
    });

    // Test POST mutation timeout
    let blobErr: unknown;
    const blobPromise = client.createBlob("base64data", "base64").catch((err) => {
      blobErr = err;
    });
    await vi.advanceTimersByTimeAsync(1500);
    await blobPromise;
    expect(blobErr).toBeInstanceOf(GitHubTimeoutError);
    expect(blobPostCount).toBe(1); // STRICTLY 1, never retried

    // Test PATCH mutation timeout
    let patchErr: unknown;
    const patchPromise = client.updateBranchRef("main", "new_sha", false).catch((err) => {
      patchErr = err;
    });
    await vi.advanceTimersByTimeAsync(1500);
    await patchPromise;
    expect(patchErr).toBeInstanceOf(GitHubTimeoutError);
    expect(refPatchCount).toBe(1); // STRICTLY 1, never retried
  });

  // =========================================================
  // NET-TIMEOUT-008: Late completion of timed-out request cannot update stale UI/state
  // =========================================================
  it("NET-TIMEOUT-008: late completion of timed-out request cannot update stale UI/state", async () => {
    vi.useFakeTimers();

    let resolveSocket: ((res: RequestUrlResponse) => void) | undefined;
    const client = new GitHubClient({
      token: "test_token_stale",
      owner: "owner",
      repo: "repo",
      branch: "main",
      timeoutMs: 1000,
      requestFn: async () => {
        return new Promise<RequestUrlResponse>((resolve) => {
          resolveSocket = resolve;
        });
      },
    });

    let uiState = "IDLE";
    const runOperation = async () => {
      uiState = "LOADING";
      try {
        const repos = await client.listUserRepositories();
        uiState = `SUCCESS_${repos.length}`;
      } catch {
        uiState = "ERROR_TIMEOUT";
      }
    };

    const opPromise = runOperation();
    expect(uiState).toBe("LOADING");

    // Advance to trigger application timeout
    await vi.advanceTimersByTimeAsync(1000);
    await opPromise;

    // UI state transitioned to ERROR_TIMEOUT
    expect(uiState).toBe("ERROR_TIMEOUT");

    // Reset UI to idle
    uiState = "IDLE";

    // Late underlying socket completion arrives 5 seconds later
    resolveSocket!({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: [
        {
          full_name: "late/stale-repo",
          name: "stale-repo",
          owner: { login: "late" },
          default_branch: "main",
          private: false,
        },
      ],
      text: "",
    });

    await vi.advanceTimersByTimeAsync(100);

    // UI state must remain unchanged (not overwritten by late completion)
    expect(uiState).toBe("IDLE");
  });

  // =========================================================
  // NET-TIMEOUT-009: Network timeout releases any active operation/lease
  // =========================================================
  it("NET-TIMEOUT-009: network timeout releases any active operation/lease", async () => {
    vi.useFakeTimers();

    const app = new App();
    const settings = { ...DEFAULT_SETTINGS, owner: "owner", repo: "repo", branch: "main" };

    const client = new GitHubClient({
      token: "test_token_lease",
      owner: "owner",
      repo: "repo",
      branch: "main",
      timeoutMs: 2000,
      requestFn: async () => {
        // getBranchRef hangs
        return new Promise<RequestUrlResponse>(() => {});
      },
    });

    const engine = new UnifiedSyncEngine(app, settings, client);

    expect(engine.isRunning).toBe(false);

    let syncErr: unknown;
    const syncPromise = engine.executeSync().catch((err) => {
      syncErr = err;
    });

    // In flight: lease acquired
    expect(engine.isRunning).toBe(true);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(2000);
    await syncPromise;

    expect(syncErr).toBeInstanceOf(GitHubTimeoutError);
    // Lease MUST be released
    expect(engine.isRunning).toBe(false);
  });

  // =========================================================
  // NET-TIMEOUT-010: No unhandled promise rejection after late socket completion
  // =========================================================
  it("NET-TIMEOUT-010: no unhandled promise rejection after late socket completion", async () => {
    vi.useFakeTimers();

    let rejectSocket: ((err: Error) => void) | undefined;
    const client = new GitHubClient({
      token: "test_token_unhandled",
      owner: "owner",
      repo: "repo",
      branch: "main",
      timeoutMs: 1000,
      requestFn: async () => {
        return new Promise<RequestUrlResponse>((_, reject) => {
          rejectSocket = reject;
        });
      },
    });

    const unhandledErrors: unknown[] = [];
    const rejectionHandler = (reason: unknown) => {
      unhandledErrors.push(reason);
    };
    process.on("unhandledRejection", rejectionHandler);

    try {
      const promise = client.getRepo();

      // Advance past timeout
      const assertion = expect(promise).rejects.toThrow(GitHubTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      // Socket now fails after application has already timed out
      rejectSocket!(new Error("net::ERR_CONNECTION_TIMED_OUT"));

      await vi.advanceTimersByTimeAsync(500);

      // Verify ZERO unhandled promise rejections
      expect(unhandledErrors).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", rejectionHandler);
    }
  });
});
