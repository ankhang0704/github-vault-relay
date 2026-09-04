/**
 * C5-SEC: Security Final Audit Tests
 *
 * Verifies:
 * - PAT = SecretStorage only
 * - no plaintext PAT persistence
 * - no force:true anywhere in production source
 * - no DELETE endpoint usage
 * - no PUT /contents endpoint
 * - no localStorage writes for PAT
 * - token redaction in all error paths
 * - remote write surface restricted to approved Git Data API endpoints
 * - no internal-path escape
 * - updateBranchRef rejects force=true
 */

import { describe, it, expect, beforeEach } from "vitest";
import { App } from "obsidian";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { GitHubClient } from "../src/github/githubClient";
import { redactTokens, sanitizeErrorMessage } from "../src/security/redact";
import {
  CANONICAL_SECRET_KEY,
  getStoredPat,
  setStoredPat,
  clearStoredPat,
  getActiveStorageBackend,
} from "../src/security/secretStore";
import { validatePathSafety } from "../src/sync/pathSafety";

// Helper: recursively find all .ts files in a directory
function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory() && entry !== "node_modules" && entry !== ".git" && entry !== "tests") {
        results.push(...findTsFiles(fullPath));
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore
  }
  return results;
}

describe("C5-SEC: Security Final Audit (C5-SEC-001..013)", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
    if (typeof globalThis.localStorage !== "undefined") {
      globalThis.localStorage.clear();
    }
  });

  it("C5-SEC-001: Production source has zero force:true in Git ref updates", () => {
    const srcFiles = findTsFiles(join(process.cwd(), "src"));
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Skip comments (JSDoc, //, etc.)
        if (line.startsWith("*") || line.startsWith("//") || line.startsWith("/*")) {
          continue;
        }
        // Allow the guard: if (force) { throw ... }
        // Disallow: force: true in any body object
        if (line.includes("force: true") && !line.includes("throw") && !line.includes("if (force)")) {
          // Check wider context for the safety guard
          const contextStart = Math.max(0, i - 5);
          const context = lines.slice(contextStart, i + 3).join("\n");
          if (!context.includes("throw") && !context.includes("if (force)")) {
            throw new Error(`Found 'force: true' in ${file} at line ${i + 1}: ${line}`);
          }
        }
      }
    }
  });

  it("C5-SEC-002: Production source has zero DELETE endpoint calls", () => {
    const srcFiles = findTsFiles(join(process.cwd(), "src"));
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf-8");
      // Should not have method: "DELETE" in any API call
      if (content.includes('method: "DELETE"') || content.includes("method: 'DELETE'")) {
        throw new Error(`Found DELETE method in ${file}`);
      }
    }
  });

  it("C5-SEC-003: Production source has zero PUT /contents endpoint", () => {
    const srcFiles = findTsFiles(join(process.cwd(), "src"));
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf-8");
      if (content.includes("/contents/") && content.includes("PUT")) {
        throw new Error(`Found PUT /contents usage in ${file}`);
      }
    }
  });

  it("C5-SEC-004: updateBranchRef programmatically rejects force=true", async () => {
    const client = new GitHubClient({
      token: "github_pat_test_force",
      owner: "owner", repo: "repo", branch: "main",
      requestFn: async () => ({
        status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {}, text: "",
      }),
    });

    await expect(client.updateBranchRef("main", "sha123", true)).rejects.toThrow(
      /force ref updates are strictly forbidden/i
    );
  });

  it("C5-SEC-005: Token redaction covers github_pat_*, ghp_*, Bearer patterns", () => {
    const sensitiveMsg = "Error: auth failed with github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 and ghp_ABC123DEF456GHI789JKL012MNO345PQR678 and Bearer my-secret-token";
    const redacted = redactTokens(sensitiveMsg);
    expect(redacted).not.toContain("github_pat_ABC");
    expect(redacted).not.toContain("ghp_ABC");
    expect(redacted).not.toContain("my-secret-token");
    expect(redacted).toContain("[REDACTED_TOKEN]");
  });

  it("C5-SEC-006: sanitizeErrorMessage redacts specific token from Error objects", () => {
    const specificToken = "github_pat_MY_SPECIFIC_SECRET_TOKEN_12345678901234";
    const error = new Error(`Connection failed: token ${specificToken} is invalid`);
    const safe = sanitizeErrorMessage(error, specificToken);
    expect(safe).not.toContain(specificToken);
    expect(safe).toContain("[REDACTED_TOKEN]");
  });

  it("C5-SEC-007: PAT stored only in SecretStorage, not in data.json or localStorage", async () => {
    const testToken = "github_pat_SECURE_STORAGE_ONLY_TEST_12345678901234";
    await setStoredPat(app, "owner", "repo", testToken);

    // Verify it's in SecretStorage
    const retrieved = await getStoredPat(app, "owner", "repo");
    expect(retrieved).toBe(testToken);

    // Verify localStorage is clean
    expect(globalThis.localStorage.getItem(CANONICAL_SECRET_KEY)).toBeNull();
    expect(globalThis.localStorage.getItem("vault-relay-pat")).toBeNull();
    expect(globalThis.localStorage.getItem("vault-relay:pat")).toBeNull();
  });

  it("C5-SEC-008: Clear Token removes from SecretStorage and purges localStorage", async () => {
    const testToken = "github_pat_CLEARABLE_TOKEN_12345678901234567890";
    await setStoredPat(app, "owner", "repo", testToken);

    // Put a fake legacy entry in localStorage
    globalThis.localStorage.setItem("vault-relay:pat", "should_be_purged");

    await clearStoredPat(app, "owner", "repo");

    // SecretStorage should be empty
    const afterClear = await getStoredPat(app, "owner", "repo");
    expect(afterClear).toBeNull();

    // localStorage should be purged
    expect(globalThis.localStorage.getItem("vault-relay:pat")).toBeNull();
  });

  it("C5-SEC-009: getActiveStorageBackend returns SECRET_STORAGE when available", () => {
    const backend = getActiveStorageBackend(app);
    expect(backend).toBe("SECRET_STORAGE");
  });

  it("C5-SEC-010: Path traversal blocked by validatePathSafety", () => {
    expect(validatePathSafety("../etc/passwd").valid).toBe(false);
    expect(validatePathSafety("notes/../../../etc/hosts").valid).toBe(false);
    expect(validatePathSafety(".obsidian/plugins/evil").valid).toBe(false);
    expect(validatePathSafety(".git/config").valid).toBe(false);
    expect(validatePathSafety("_fit/some.md").valid).toBe(false);
    expect(validatePathSafety("C:\\Windows\\system32\\cmd.exe").valid).toBe(false);
    expect(validatePathSafety("/absolute/path").valid).toBe(false);
    expect(validatePathSafety("normal/notes/hello.md").valid).toBe(true);
    // "./hidden" normalizes to "hidden" which is valid — this is correct behavior
  });

  it("C5-SEC-011: No production source writes to localStorage for any PAT purpose", () => {
    const srcFiles = findTsFiles(join(process.cwd(), "src"));
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content, `localStorage write found in ${file}`).not.toMatch(/localStorage\s*\.\s*setItem\s*\(/);
    }
  });

  it("C5-SEC-012: Remote write endpoints are exactly the approved Git Data API paths", async () => {
    const writes: Array<{ method: string; path: string; body?: string }> = [];
    const client = new GitHubClient({
      token: "github_pat_endpoint_inventory_12345678901234567890",
      owner: "owner",
      repo: "repo",
      branch: "main",
      requestFn: async (params) => {
        writes.push({ method: params.method || "GET", path: new URL(params.url).pathname, body: params.body as string | undefined });
        if (params.url.endsWith("/git/blobs")) {
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "blob" }, text: "" };
        }
        if (params.url.endsWith("/git/trees")) {
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "tree", tree: [] }, text: "" };
        }
        if (params.url.endsWith("/git/commits")) {
          return { status: 201, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { sha: "commit", tree: { sha: "tree" }, parents: [] }, text: "" };
        }
        return {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { ref: "refs/heads/main", object: { sha: "commit", type: "commit" } },
          text: "",
        };
      },
    });

    await client.createBlob("content");
    await client.createTree([], "base-tree");
    await client.createCommit("message", "tree", ["parent"]);
    await client.updateBranchRef("main", "commit", false);

    expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /repos/owner/repo/git/blobs",
      "POST /repos/owner/repo/git/trees",
      "POST /repos/owner/repo/git/commits",
      "PATCH /repos/owner/repo/git/refs/heads/main",
    ]);
    expect(JSON.parse(writes[3].body || "{}")).toEqual({ sha: "commit", force: false });
  });

  it("C5-SEC-013: production bundle contains no secret or forbidden persistence/write surface", () => {
    const bundlePath = join(process.cwd(), "main.js");
    if (!existsSync(bundlePath)) {
      execSync("node esbuild.config.mjs production", { stdio: "pipe" });
    }
    const bundle = readFileSync(bundlePath, "utf8");

    expect(bundle).not.toMatch(/localStorage\s*\.\s*setItem\s*\(/);
    expect(bundle).not.toMatch(/sessionStorage\s*\.\s*setItem\s*\(/);
    expect(bundle).not.toContain('method:"DELETE"');
    expect(bundle).not.toContain('method:"PUT"');
    expect(bundle).not.toContain("/contents/");
    expect(bundle).not.toMatch(/github_pat_[A-Za-z0-9_]{30,}/);
    expect(bundle).not.toMatch(/ghp_[A-Za-z0-9]{30,}/);
    expect(bundle).toContain("/git/blobs");
    expect(bundle).toContain("/git/trees");
    expect(bundle).toContain("/git/commits");
    expect(bundle).toContain("/git/refs/heads/");
    expect(bundle).toContain("SecretStorage");
  });
});
