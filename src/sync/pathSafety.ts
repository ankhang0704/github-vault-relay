/**
 * Path Safety & Case Collision Detection
 *
 * Ensures remote repository paths are strictly validated before any local writes,
 * protecting against path traversal, reserved directory writes, and case collisions.
 */

import { DEFAULT_EXCLUSIONS, isPathExcluded, normalizePath } from "./pathFilter";

export interface PathValidationResult {
  valid: boolean;
  normalizedPath: string;
  reason?: string;
}

const RESERVED_PATH_PREFIXES = [
  ".obsidian",
  ".git",
  "_fit",
];

/**
 * Validates the safety of a path before allowing local filesystem operations.
 */
export function validatePathSafety(rawPath: string, exclusions = DEFAULT_EXCLUSIONS): PathValidationResult {
  if (!rawPath || typeof rawPath !== "string") {
    return { valid: false, normalizedPath: "", reason: "Path is empty or not a string." };
  }

  // Reject NUL characters
  if (rawPath.includes("\0")) {
    return { valid: false, normalizedPath: "", reason: "Path contains illegal NUL character." };
  }

  // Reject Windows drive letters (e.g. C:)
  if (/^[a-zA-Z]:/.test(rawPath)) {
    return { valid: false, normalizedPath: "", reason: "Absolute path with drive letter is forbidden." };
  }

  // Reject leading slash
  if (rawPath.startsWith("/") || rawPath.startsWith("\\")) {
    return { valid: false, normalizedPath: "", reason: "Leading slash is forbidden." };
  }

  const normalized = normalizePath(rawPath);
  if (!normalized) {
    return { valid: false, normalizedPath: "", reason: "Normalized path is empty." };
  }

  // Check path segments for directory traversal
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      return {
        valid: false,
        normalizedPath: normalized,
        reason: "Path contains directory traversal segment ('..' or '.').",
      };
    }
    if (!seg.trim()) {
      return {
        valid: false,
        normalizedPath: normalized,
        reason: "Path contains empty segment.",
      };
    }
  }

  // Reject reserved system / internal directories
  const firstSegment = segments[0].toLowerCase();
  for (const reserved of RESERVED_PATH_PREFIXES) {
    if (firstSegment === reserved.toLowerCase()) {
      return {
        valid: false,
        normalizedPath: normalized,
        reason: `Target path begins with reserved directory '${reserved}'.`,
      };
    }
  }

  // Check against exclusion rules
  if (isPathExcluded(normalized, exclusions)) {
    return {
      valid: false,
      normalizedPath: normalized,
      reason: "Path matches an active exclusion rule.",
    };
  }

  return { valid: true, normalizedPath: normalized };
}

/**
 * Detects case-insensitive collisions across a list of file paths.
 * Returns a map of lowercase path -> array of distinct original paths with that collision.
 */
export function detectCaseCollisions(paths: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const p of paths) {
    const norm = normalizePath(p);
    if (!norm) continue;
    const lower = norm.toLowerCase();
    const existing = map.get(lower) || [];
    if (!existing.includes(norm)) {
      existing.push(norm);
    }
    map.set(lower, existing);
  }

  const collisions = new Map<string, string[]>();
  for (const [lowerKey, pathList] of map.entries()) {
    if (pathList.length > 1) {
      collisions.set(lowerKey, pathList);
    }
  }

  return collisions;
}
