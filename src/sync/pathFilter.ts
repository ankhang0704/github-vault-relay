/**
 * Path Filtering and Exclusion Utilities
 *
 * Ensures system folders, Git metadata, and internal plugin state
 * are strictly excluded from scanning and syncing.
 */

export const DEFAULT_EXCLUSIONS: string[] = [
  ".obsidian/",
  ".git/",
  "_fit/",
  "_vault-relay/",
];

/**
 * Normalizes a file path to standard posix format without leading/trailing slashes.
 */
export function normalizePath(path: string): string {
  if (!path) return "";
  let normalized = path.replace(/\\/g, "/").trim();
  // Remove leading './' or '/'
  normalized = normalized.replace(/^(\.\/|\/)+/, "");
  // Remove trailing '/'
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

/**
 * Checks if a given path matches any exclusion rule.
 * Rules ending in '/' match directories and all child paths.
 * Rules without '/' match exact paths or directory prefixes.
 */
export function isPathExcluded(filePath: string, exclusions: string[] = DEFAULT_EXCLUSIONS): boolean {
  const normalizedPath = normalizePath(filePath);
  if (!normalizedPath) return true;

  for (const rawRule of exclusions) {
    if (!rawRule) continue;
    const rule = rawRule.trim();
    if (!rule || rule.startsWith("#")) continue;

    const normalizedRule = normalizePath(rule);
    if (!normalizedRule) continue;

    // Matches exact path or directory children
    if (normalizedPath === normalizedRule || normalizedPath.startsWith(normalizedRule + "/")) {
      return true;
    }
  }

  return false;
}

/**
 * Parses a multiline text string of excluded paths into an array of clean rules.
 */
export function parseExclusionRules(text: string): string[] {
  if (!text) return [...DEFAULT_EXCLUSIONS];

  const rules: string[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      rules.push(trimmed);
    }
  }

  // Ensure default critical internal paths are always preserved if not present
  for (const def of DEFAULT_EXCLUSIONS) {
    if (!rules.some((r) => normalizePath(r) === normalizePath(def))) {
      rules.push(def);
    }
  }

  return rules;
}
