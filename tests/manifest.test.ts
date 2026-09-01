import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";
import pkg from "../package.json";

describe("Plugin Identity & Manifest Integrity", () => {
  it("has exact community-safe plugin ID 'github-vault-relay'", () => {
    expect(manifest.id).toBe("github-vault-relay");
    expect(pkg.name).toBe("github-vault-relay");
  });

  it("has official plugin name 'GitHub Vault Relay'", () => {
    expect(manifest.name).toBe("GitHub Vault Relay");
  });

  it("is enabled for mobile (isDesktopOnly: false)", () => {
    expect(manifest.isDesktopOnly).toBe(false);
  });

  it("has matching version with package.json", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("has non-empty description and minAppVersion", () => {
    expect(manifest.description).toBe(
      "A conservative GitHub bridge for Obsidian Mobile — without running Git on the phone."
    );
    expect(typeof manifest.minAppVersion).toBe("string");
    expect(manifest.minAppVersion.length).toBeGreaterThan(0);
  });
});
