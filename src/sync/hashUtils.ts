/**
 * Git Blob SHA Computation Utilities
 *
 * Implements standard Git blob SHA-1 calculation:
 * sha1("blob " + byteLength + "\0" + payload)
 *
 * Uses standard Web Crypto API (crypto.subtle) for 100% mobile compatibility
 * without external libraries or Node.js native crypto modules.
 */

import { isCanonicalTextPath, canonicalizeTextBytes, canonicalizeTextString } from "./canonicalContent";

/**
 * Converts an ArrayBuffer or Uint8Array to a lowercase hex string.
 */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Converts input content into a clean Uint8Array.
 */
export function contentToUint8Array(content: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  throw new Error("Invalid content type for Git SHA calculation. Expected string or binary buffer.");
}

/**
 * Computes the exact RAW Git blob SHA-1 for string or binary file content without any transformation.
 * @param content String or binary data (ArrayBuffer / Uint8Array).
 * @returns 40-character lowercase hex SHA-1 string matching Git's blob hash.
 */
export async function calculateGitBlobSha(content: string | ArrayBuffer | Uint8Array): Promise<string> {
  const contentBytes = contentToUint8Array(content);

  const header = `blob ${contentBytes.byteLength}\0`;
  const headerBytes = new TextEncoder().encode(header);

  const fullPayload = new Uint8Array(headerBytes.byteLength + contentBytes.byteLength);
  fullPayload.set(headerBytes, 0);
  fullPayload.set(contentBytes, headerBytes.byteLength);

  const subtleCrypto = globalThis.crypto?.subtle;
  if (!subtleCrypto) {
    throw new Error("Web Crypto API (crypto.subtle) is not available in current environment.");
  }

  const hashBuffer = await subtleCrypto.digest("SHA-1", fullPayload);
  return bufferToHex(hashBuffer);
}

/**
 * Alias for calculateGitBlobSha to emphasize raw calculation.
 */
export const calculateRawGitBlobSha = calculateGitBlobSha;

/**
 * Computes the canonical Git blob SHA for a path:
 * - For supported text files (.md, .txt, .canvas), normalizes CRLF -> LF before hashing.
 * - For binary files, hashes raw bytes directly.
 */
export async function calculateCanonicalGitBlobSha(
  content: string | ArrayBuffer | Uint8Array,
  path: string
): Promise<string> {
  if (isCanonicalTextPath(path)) {
    if (typeof content === "string") {
      const canonicalText = canonicalizeTextString(content);
      return calculateGitBlobSha(canonicalText);
    }
    const rawBytes = contentToUint8Array(content);
    const canonicalBytes = canonicalizeTextBytes(rawBytes);
    return calculateGitBlobSha(canonicalBytes);
  }
  return calculateGitBlobSha(content);
}
