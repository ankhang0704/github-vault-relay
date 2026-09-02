import { describe, it, expect, vi } from "vitest";
import { GitHubClient, normalizeRepoConfig } from "../src/github/githubClient";
import { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { calculateRawGitBlobSha } from "../src/sync/hashUtils";

describe("GitHub Client C2 Hardening & Safety (src/github/githubClient.ts)", () => {
  it("normalizes various repo input formats correctly (slug, full url, .git)", () => {
    expect(normalizeRepoConfig("ankhang0704", "github-vault-relay")).toEqual({
      owner: "ankhang0704",
      repo: "github-vault-relay",
    });
    expect(normalizeRepoConfig("", "ankhang0704/github-vault-relay")).toEqual({
      owner: "ankhang0704",
      repo: "github-vault-relay",
    });
    expect(normalizeRepoConfig("", "https://github.com/ankhang0704/github-vault-relay.git")).toEqual({
      owner: "ankhang0704",
      repo: "github-vault-relay",
    });
    expect(normalizeRepoConfig("ankhang0704", "github-vault-relay.git")).toEqual({
      owner: "ankhang0704",
      repo: "github-vault-relay",
    });
  });

  it("proves GitHubClient contains ONLY allowed Git Data write methods and ZERO destructive methods (C3-020)", () => {
    const proto = GitHubClient.prototype as unknown as Record<string, unknown>;
    // Allowed C3 Git Data write primitives
    expect(typeof proto.createBlob).toBe("function");
    expect(typeof proto.createTree).toBe("function");
    expect(typeof proto.createCommit).toBe("function");
    expect(typeof proto.updateBranchRef).toBe("function");

    // Strictly forbidden destructive write methods
    expect(proto.deleteFile).toBeUndefined();
    expect(proto.deleteBlob).toBeUndefined();
    expect(proto.deleteTree).toBeUndefined();
    expect(proto.deleteCommit).toBeUndefined();
    expect(proto.deleteBranch).toBeUndefined();
    expect(proto.deleteRef).toBeUndefined();
    expect(proto.forcePush).toBeUndefined();
    expect(proto.putFile).toBeUndefined();
  });

  it("aborts immediately when device is offline without network timeouts (REG-008)", async () => {
    const hasNavigator = typeof globalThis.navigator !== "undefined";
    const originalDescriptor = hasNavigator
      ? Object.getOwnPropertyDescriptor(globalThis.navigator, "onLine") ||
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.navigator), "onLine")
      : undefined;

    try {
      if (!hasNavigator) {
        Object.defineProperty(globalThis, "navigator", {
          value: { onLine: false },
          configurable: true,
          writable: true,
        });
      } else {
        Object.defineProperty(globalThis.navigator, "onLine", {
          value: false,
          configurable: true,
        });
      }

      const client = new GitHubClient({
        token: "github_pat_test",
        owner: "octocat",
        repo: "notes",
        branch: "main",
      });

      await expect(client.getRepo()).rejects.toThrow(/Device is offline/i);
    } finally {
      if (!hasNavigator) {
        delete (globalThis as unknown as { navigator?: unknown }).navigator;
      } else if (originalDescriptor) {
        Object.defineProperty(globalThis.navigator, "onLine", originalDescriptor);
      } else {
        delete (globalThis.navigator as unknown as { onLine?: boolean }).onLine;
      }
    }
  });

  it("handles HTTP 429 Rate Limit by respecting Retry-After and succeeding on retry (REG-007)", async () => {
    let callCount = 0;
    const fakeRequestFn = vi.fn(async (_params: RequestUrlParam): Promise<RequestUrlResponse> => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 429,
          headers: { "retry-after": "0" },
          arrayBuffer: new ArrayBuffer(0),
          json: { message: "API rate limit exceeded" },
          text: '{"message":"API rate limit exceeded"}',
        };
      }
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { id: 123, name: "notes", full_name: "octocat/notes", default_branch: "main", private: false },
        text: "{}",
      };
    });

    const client = new GitHubClient({
      token: "github_pat_test",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: fakeRequestFn,
    });

    const repo = await client.getRepo();
    expect(repo.name).toBe("notes");
    expect(callCount).toBe(2);
  });

  it("downloads raw blob and validates cryptographic Git SHA integrity (C2-007)", async () => {
    const rawContent = "Hello from GitHub remote file!\n";
    const rawBytes = new TextEncoder().encode(rawContent);
    const expectedSha = await calculateRawGitBlobSha(rawBytes);

    const base64Content = btoa(rawContent);

    const fakeRequestFn = vi.fn(async (): Promise<RequestUrlResponse> => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {
        sha: expectedSha,
        size: rawBytes.byteLength,
        content: base64Content,
        encoding: "base64",
      },
      text: "{}",
    }));

    const client = new GitHubClient({
      token: "github_pat_test",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: fakeRequestFn,
    });

    const downloadedBytes = await client.getRawBlobBytes(expectedSha, rawBytes.byteLength);
    expect(downloadedBytes).toEqual(rawBytes);

    // Test mismatch integrity detection
    const fakeTamperedRequestFn = vi.fn(async (): Promise<RequestUrlResponse> => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {
        sha: expectedSha,
        size: 5,
        content: btoa("tampered"),
        encoding: "base64",
      },
      text: "{}",
    }));

    const tamperedClient = new GitHubClient({
      token: "github_pat_test",
      owner: "octocat",
      repo: "notes",
      branch: "main",
      requestFn: fakeTamperedRequestFn,
    });

    await expect(tamperedClient.getRawBlobBytes(expectedSha, 5)).rejects.toThrow(
      /Integrity verification failed/i
    );
  });

  it("rejects downloading oversized blob exceeding 25 MiB mobile safety ceiling (REG-003)", async () => {
    const client = new GitHubClient({
      token: "github_pat_test",
      owner: "octocat",
      repo: "notes",
      branch: "main",
    });

    const oversizedBytes = 26 * 1024 * 1024; // 26 MiB
    await expect(client.getRawBlobBytes("1234567890123456789012345678901234567890", oversizedBytes)).rejects.toThrow(
      /Vault Relay 25 MiB safety policy/i
    );
  });
});
