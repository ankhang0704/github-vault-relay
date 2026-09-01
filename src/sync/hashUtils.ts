/**
 * Git Blob SHA Computation Utilities
 *
 * Implements standard Git blob SHA-1 calculation:
 * sha1("blob " + byteLength + "\0" + payload)
 *
 * Uses standard Web Crypto API (crypto.subtle) for 100% mobile compatibility
 * without external libraries or Node.js native crypto modules.
 */

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
 * Computes the exact Git blob SHA-1 for string or binary file content.
 * @param content String or binary data (ArrayBuffer / Uint8Array).
 * @returns 40-character lowercase hex SHA-1 string matching Git's blob hash.
 */
export async function calculateGitBlobSha(content: string | ArrayBuffer | Uint8Array): Promise<string> {
  let contentBytes: Uint8Array;

  if (typeof content === "string") {
    contentBytes = new TextEncoder().encode(content);
  } else if (content instanceof Uint8Array) {
    contentBytes = content;
  } else if (content instanceof ArrayBuffer) {
    contentBytes = new Uint8Array(content);
  } else {
    throw new Error("Invalid content type for Git SHA calculation. Expected string or binary buffer.");
  }

  const header = `blob ${contentBytes.byteLength}\0`;
  const headerBytes = new TextEncoder().encode(header);

  const fullPayload = new Uint8Array(headerBytes.byteLength + contentBytes.byteLength);
  fullPayload.set(headerBytes, 0);
  fullPayload.set(contentBytes, headerBytes.byteLength);

  // Use standard Web Crypto API available in Obsidian mobile/desktop and Node 16+
  const subtleCrypto = globalThis.crypto?.subtle;
  if (!subtleCrypto) {
    throw new Error("Web Crypto API (crypto.subtle) is not available in current environment.");
  }

  const hashBuffer = await subtleCrypto.digest("SHA-1", fullPayload);
  return bufferToHex(hashBuffer);
}
