# Contributing to GitHub Vault Relay

Vault Relay is a conservative, user-triggered GitHub bridge for Obsidian mobile and desktop. When state is ambiguous, preserve it and make the failure explicit.

## Prerequisites and gates

- Node.js 20.x or 22.x LTS
- npm 10+

```bash
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
npm run verify
```

`npm run verify` is the canonical gate: zero ESLint warnings/errors, a clean TypeScript check, passing Vitest tests, and a successful production build.

## Safety invariants

1. Branch updates use `force: false`; never add force-push behavior.
2. Remote writes use Git Data API blobs, trees, commits, and refs; do not add GitHub `DELETE` or `PUT /contents` calls.
3. Sync remains explicitly user-triggered; no background daemon or sync-on-save.
4. Active PAT storage remains Obsidian `SecretStorage` under `github-vault-relay-pat`.
5. Content and deletion conflicts are preserved until explicit resolution.
6. Do not introduce Node-only runtime APIs or native Git/isomorphic-git dependencies into the plugin runtime.
7. Preserve the 25 MiB file policy, path validation, remote ref revalidation, recovery journals, and baseline-after-verification ordering.
8. Keep internal storage under `${app.vault.configDir}/github-vault-relay/`; root `_vault-relay/` is user-owned content.

## Feature freeze

Do not submit background/scheduled sync, sync-on-save, implicit/unverified deletion, alternative Git hosts, native Git, or isomorphic-git. Contributions should target correctness, recovery, performance, security, accessibility, or documentation.

## AI-assisted engineering and ownership

The maintainer/product owner owns problem definition, requirements, scope, product decisions, direction given to agents, manual testing, acceptance/rejection, and release decisions.

Engineering may be AI-assisted for architecture exploration, implementation/refactoring, test generation, audits, and documentation drafting. Every result still requires human review and the same executable gates as any other contribution. Do not infer maintainer ownership of a technical decision merely from file authorship; point to the implementation, tests, explicit decision record, or history when making that claim.

## Documentation changes

Use current source/tests/manifest as evidence. Keep historical checkpoint numbers labeled as historical. Do not claim real-device PASS from automated tests; update [the manual matrix](docs/MANUAL_TEST_MATRIX.md) only after a physical run.

## Security reports

Do not open a public issue with vulnerability details. Use the private process in [SECURITY.md](SECURITY.md).
