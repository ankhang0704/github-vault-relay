/**
 * Path Filtering and Exclusion Utilities
 *
 * Ensures system folders, Git metadata, and internal plugin state
 * are strictly excluded from scanning and syncing.
 */

const FALLBACK_CONFIG_DIR = [".", "obsidian"].join("");

/**
 * Returns default exclusion patterns, using the current vault configDir when provided.
 */
export function getDefaultExclusions(configDir?: string): string[] {
  const dir = configDir || FALLBACK_CONFIG_DIR;
  return [`${dir}/`, ".git/", "_fit/", ".trash/"];
}

export const DEFAULT_EXCLUSIONS: string[] = getDefaultExclusions();

/**
 * Normalizes a file path to standard posix format without leading/trailing slashes.
 */
export function normalizePath(path: string): string {
  if (!path) return "";
  let normalized = path.replace(/\\/g, "/").trim().normalize("NFC");
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
 * Ensures the live Obsidian config directory is excluded without discarding
 * persisted user rules. Existing settings may still contain older defaults.
 */
export function ensureConfigDirExcluded(exclusions: string[] | undefined, configDir?: string): string[] {
  const rules = Array.isArray(exclusions) ? exclusions.filter((rule): rule is string => typeof rule === "string") : [];
  if (rules.length === 0) return getDefaultExclusions(configDir);

  const configRule = getDefaultExclusions(configDir)[0];

  if (!rules.some((rule) => normalizePath(rule) === normalizePath(configRule))) {
    rules.push(configRule);
  }

  return rules;
}

/**
 * Parses a multiline text string of excluded paths into an array of clean rules.
 */
export function parseExclusionRules(text: string, configDir?: string): string[] {
  const defaults = getDefaultExclusions(configDir);
  if (!text) return [...defaults];

  const rules: string[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      rules.push(trimmed);
    }
  }

  // Ensure default critical internal paths are always preserved if not present
  for (const def of defaults) {
    if (!rules.some((r) => normalizePath(r) === normalizePath(def))) {
      rules.push(def);
    }
  }

  return rules;
}

/**
 * One-time migration for legacy exclusion configurations.
 * Removes the old plugin-owned root '_vault-relay/' or '_vault-relay' rule
 * because C4 now treats '_vault-relay/' as normal user content.
 * Preserves all other default and user-defined exclusion rules.
 */
export function migrateLegacyExclusions(exclusions: string[], configDir?: string): string[] {
  if (!Array.isArray(exclusions)) return getDefaultExclusions(configDir);
  return ensureConfigDirExcluded(exclusions.filter((rule) => {
    if (!rule || typeof rule !== "string") return false;
    const norm = normalizePath(rule);
    return norm !== "_vault-relay";
  }), configDir);
}
