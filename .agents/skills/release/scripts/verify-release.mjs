#!/usr/bin/env node

/**
 * Pre-release synchronization and integrity checker.
 * Validates that all metadata, manifests, lockfiles, and security documentation
 * agree on the target release version before tagging and releasing.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const rootDir = process.cwd();

function readJson(file) {
  const fullPath = resolve(rootDir, file);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${file}`);
  }
  return JSON.parse(readFileSync(fullPath, "utf8"));
}

function readText(file) {
  const fullPath = resolve(rootDir, file);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${file}`);
  }
  return readFileSync(fullPath, "utf8");
}

const errors = [];

try {
  const pkg = readJson("package.json");
  const targetVersion = pkg.version;
  console.log(`[verify-release] Target version: ${targetVersion}`);

  // 1. package-lock.json
  const lock = readJson("package-lock.json");
  if (lock.version !== targetVersion) {
    errors.push(`package-lock.json root version (${lock.version}) does not match package.json (${targetVersion})`);
  }
  if (lock.packages && lock.packages[""] && lock.packages[""].version !== targetVersion) {
    errors.push(`package-lock.json packages[""].version (${lock.packages[""].version}) does not match package.json (${targetVersion})`);
  }

  // 2. manifest.json
  const manifest = readJson("manifest.json");
  if (manifest.version !== targetVersion) {
    errors.push(`manifest.json version (${manifest.version}) does not match package.json (${targetVersion})`);
  }

  // 3. versions.json
  const versions = readJson("versions.json");
  if (!versions[targetVersion]) {
    errors.push(`versions.json is missing entry for version ${targetVersion}`);
  } else if (versions[targetVersion] !== manifest.minAppVersion) {
    errors.push(`versions.json["${targetVersion}"] (${versions[targetVersion]}) does not match manifest.minAppVersion (${manifest.minAppVersion})`);
  }

  // 4. SECURITY.md
  const security = readText("SECURITY.md");
  const securityMatch = security.match(/current supported release is `([^`]+)`/);
  if (!securityMatch) {
    errors.push("SECURITY.md missing 'current supported release is `...`' clause");
  } else if (securityMatch[1] !== targetVersion) {
    errors.push(`SECURITY.md supported release (${securityMatch[1]}) does not match package.json (${targetVersion})`);
  }

  // 5. README.md badge and baseline
  const readme = readText("README.md");
  const badgeRegex = new RegExp(`badge/version-${targetVersion.replace(/\./g, "\\.")}-blue\\.svg`);
  if (!badgeRegex.test(readme)) {
    errors.push(`README.md version badge does not reflect version ${targetVersion}`);
  }
  const baselineRegex = new RegExp(`Release:\\s*\`${targetVersion.replace(/\./g, "\\.")}\``);
  if (!baselineRegex.test(readme)) {
    errors.push(`README.md canonical baseline does not reflect Release \`${targetVersion}\``);
  }

  if (errors.length > 0) {
    console.error("\n[verify-release] ❌ Verification failed with errors:");
    errors.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }

  console.log("[verify-release] ✅ All metadata and documentation files are strictly synchronized!");
} catch (err) {
  console.error(`[verify-release] ❌ Fatal error: ${err.message}`);
  process.exit(1);
}
