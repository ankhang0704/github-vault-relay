import { describe, it, expect } from "vitest";
import { calculateGitBlobSha } from "../src/sync/hashUtils";

describe("Git Blob SHA Calculation (hashUtils)", () => {
  it("calculates correct Git SHA for empty file (known Git constant)", async () => {
    const sha = await calculateGitBlobSha("");
    // Standard Git empty blob SHA: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
    expect(sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("calculates correct Git SHA for 'hello world\\n'", async () => {
    const sha = await calculateGitBlobSha("hello world\n");
    // Standard Git blob SHA for 'hello world\n': 3b18e512dba79e4c8300dd08aeb37f8e728b8dad
    expect(sha).toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
  });

  it("calculates matching Git SHA for string and equivalent Uint8Array", async () => {
    const text = "# Obsidian Vault Note\n\nThis is a sync test note.";
    const textSha = await calculateGitBlobSha(text);

    const binary = new TextEncoder().encode(text);
    const binarySha = await calculateGitBlobSha(binary);

    const arrayBufferSha = await calculateGitBlobSha(binary.buffer);

    expect(textSha).toBe(binarySha);
    expect(binarySha).toBe(arrayBufferSha);
    expect(textSha).toHaveLength(40);
  });
});
