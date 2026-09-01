/**
 * Canonical Content Representation Utilities
 *
 * Implements the frozen Vault Relay canonical text vs binary policy:
 * - Text types (.md, .txt, .canvas): normalized to canonical LF (\n) line endings.
 * - Binary files: 100% byte-exact without alteration.
 */

const CANONICAL_TEXT_EXTENSIONS = new Set([".md", ".txt", ".canvas"]);

/**
 * Checks whether a given file path is a supported text file requiring canonical LF normalization.
 */
export function isCanonicalTextPath(path: string): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  const lastDot = lower.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = lower.substring(lastDot);
  return CANONICAL_TEXT_EXTENSIONS.has(ext);
}

/**
 * Normalizes text string line endings to canonical LF (\n).
 */
export function canonicalizeTextString(text: string): string {
  if (!text) return "";
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Canonicalizes raw bytes for supported text files by converting CRLF -> LF in UTF-8.
 * For non-text files, returns the original bytes untouched.
 */
export function canonicalizeTextBytes(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const normalized = canonicalizeTextString(text);
  return new TextEncoder().encode(normalized);
}

/**
 * Prepares payload bytes for local writing or hashing according to file type policy.
 */
export function prepareContentBytesForPath(bytes: Uint8Array, path: string): Uint8Array {
  if (isCanonicalTextPath(path)) {
    return canonicalizeTextBytes(bytes);
  }
  return bytes;
}
