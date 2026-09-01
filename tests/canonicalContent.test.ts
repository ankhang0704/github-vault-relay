import { describe, it, expect } from "vitest";
import {
  isCanonicalTextPath,
  canonicalizeTextString,
  canonicalizeTextBytes,
  prepareContentBytesForPath,
} from "../src/sync/canonicalContent";
import { calculateCanonicalGitBlobSha } from "../src/sync/hashUtils";

describe("Canonical Content & Line Endings (src/sync/canonicalContent.ts)", () => {
  it("recognizes supported text extensions (.md, .txt, .canvas)", () => {
    expect(isCanonicalTextPath("note.md")).toBe(true);
    expect(isCanonicalTextPath("Notes/Daily/2026-09-01.MD")).toBe(true);
    expect(isCanonicalTextPath("info.txt")).toBe(true);
    expect(isCanonicalTextPath("diagram.canvas")).toBe(true);

    expect(isCanonicalTextPath("image.png")).toBe(false);
    expect(isCanonicalTextPath("photo.JPG")).toBe(false);
    expect(isCanonicalTextPath("doc.pdf")).toBe(false);
    expect(isCanonicalTextPath("audio.mp3")).toBe(false);
    expect(isCanonicalTextPath("archive.zip")).toBe(false);
  });

  it("normalizes CRLF and standalone CR to canonical LF in strings and bytes", () => {
    const crlfText = "Line 1\r\nLine 2\r\nLine 3\r";
    const expected = "Line 1\nLine 2\nLine 3\n";

    expect(canonicalizeTextString(crlfText)).toBe(expected);

    const crlfBytes = new TextEncoder().encode(crlfText);
    const normalizedBytes = canonicalizeTextBytes(crlfBytes);
    const decoded = new TextDecoder().decode(normalizedBytes);

    expect(decoded).toBe(expected);
  });

  it("leaves binary byte arrays 100% untouched", () => {
    // Binary sequence containing 0x0D (CR) and 0x0A (LF) in binary context (e.g. PNG header 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A)
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const prepared = prepareContentBytesForPath(pngHeader, "image.png");

    expect(prepared).toEqual(pngHeader);
    expect(prepared.byteLength).toBe(8);
    expect(prepared[4]).toBe(0x0d);
    expect(prepared[5]).toBe(0x0a);
  });

  it("produces identical canonical Git blob SHA for CRLF and LF text files (REG-004)", async () => {
    const textLF = "# Header\n\nParagraph 1.\nParagraph 2.\n";
    const textCRLF = "# Header\r\n\r\nParagraph 1.\r\nParagraph 2.\r\n";

    const shaLF = await calculateCanonicalGitBlobSha(textLF, "note.md");
    const shaCRLF = await calculateCanonicalGitBlobSha(textCRLF, "note.md");

    expect(shaLF).toBe(shaCRLF);
  });
});
