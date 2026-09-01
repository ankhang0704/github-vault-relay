/**
 * Vault Relay File Size Safety Policy
 *
 * Enforces the 25 MiB mobile memory ceiling policy.
 * (Note: This is a Vault Relay safety policy to prevent iOS Jetsam OOM kills,
 * not the GitHub Git Data API platform limit which is 100 MB).
 */

export const MAX_SAFE_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MiB

/**
 * Checks if a given file size exceeds the Vault Relay 25 MiB mobile safety ceiling.
 */
export function isOversized(sizeBytes?: number): boolean {
  if (typeof sizeBytes !== "number" || isNaN(sizeBytes)) {
    return false;
  }
  return sizeBytes > MAX_SAFE_FILE_SIZE_BYTES;
}

/**
 * Formats a byte count into human-readable string.
 */
export function formatFileSize(bytes?: number): string {
  if (typeof bytes !== "number" || isNaN(bytes)) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
