import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    ignores: [
      "main.js",
      "main.js.map",
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".obsidian/**",
      "_vault-relay/**",
      "_fit/**",
      "*.config.mjs",
      "*.config.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      obsidianmd,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["src/**/*.{ts,js}"],
    plugins: {
      obsidianmd,
    },
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/unbound-method": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "obsidianmd/no-static-styles-assignment": "error",
      "obsidianmd/prefer-create-el": "warn",
      "obsidianmd/hardcoded-config-path": "warn",
      "obsidianmd/prefer-file-manager-trash-file": "warn",
      "obsidianmd/prefer-window-timers": "warn",
      "obsidianmd/no-global-this": "warn",
      "obsidianmd/settings-tab/no-manual-html-headings": "error",
      "obsidianmd/settings-tab/no-problematic-settings-headings": "error",
      "obsidianmd/settings-tab/require-display": "warn",
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
      "obsidianmd/settings-tab/prefer-update-over-display": "warn",
      "obsidianmd/settings-tab/no-deprecated-display": "warn",
      "obsidianmd/commands/no-command-in-command-id": "warn",
      "obsidianmd/commands/no-command-in-command-name": "warn",
      "obsidianmd/commands/no-default-hotkeys": "warn",
      "obsidianmd/commands/no-plugin-id-in-command-id": "warn",
      "obsidianmd/commands/no-plugin-name-in-command-name": "warn",
      "obsidianmd/vault/iterate": "warn",
      "obsidianmd/detach-leaves": "error",
      "obsidianmd/editor-drop-paste": "warn",
      "obsidianmd/no-forbidden-elements": "error",
      "obsidianmd/no-sample-code": "error",
      "obsidianmd/no-tfile-tfolder-cast": "warn",
      "obsidianmd/object-assign": "warn",
      "obsidianmd/platform": "error",
      "obsidianmd/prefer-get-language": "warn",
      "obsidianmd/prefer-abstract-input-suggest": "warn",
      "obsidianmd/prefer-active-doc": "off",
      "obsidianmd/regex-lookbehind": "error",
      "obsidianmd/sample-names": "error",
      "obsidianmd/ui/sentence-case": "off",
      "obsidianmd/no-plugin-as-component": "error",
      "obsidianmd/no-view-references-in-plugin": "error",
      "obsidianmd/no-unsupported-api": "error",
      "obsidianmd/prefer-instanceof": "warn",
      "obsidianmd/no-nodejs-modules": "warn",

    },
  },
  {
    plugins: {
      obsidianmd,
    },
    rules: {
      "obsidianmd/validate-manifest": "warn",
      "obsidianmd/validate-license": "warn",
    },
  },
  {
    files: ["tests/**/*.{ts,js}"],
    rules: {
      "no-console": "off",
    },
  }
);
