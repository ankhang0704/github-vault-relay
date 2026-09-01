# Vault Relay Agent Rules

## Mission
Vault Relay is a conservative mobile GitHub-backed Obsidian vault sync plugin.
Data integrity and explicit failure are more important than convenience.

## Quality Gates
A task/checkpoint is NOT complete unless:
- `npm run lint` => PASS, 0 warnings
- `npm run typecheck` => PASS
- `npm run test` => PASS
- `npm run build` => PASS
- `npm run verify` => PASS

## No Hidden Debt
Never:
- suppress lint/type errors just to pass
- weaken rules to hide failures
- use `|| true`
- use CI `continue-on-error`
- exclude broken production files
- silently leave lint warnings
- claim PASS with known failing verification

## Safety Invariants
Preserve the current Vault Relay safety model:
- no force push
- no silent overwrite
- preserve conflicts
- revalidate remote HEAD before writes
- deletion remains deferred until explicitly approved
- `.obsidian/`, `.git/`, `_fit/`, `_vault-relay/` remain excluded by default
- manual sync must be proven before auto-sync
- PAT must never appear in logs/errors
- no Node-only runtime APIs on mobile
- no native Git/isomorphic-git unless explicitly approved

## Scope Discipline
Do not implement future checkpoints unless explicitly requested.
Do not opportunistically refactor unrelated working code.
Prefer small, auditable changes.

## Verification Honesty
Reports must distinguish:
- **PASS**
- **FAIL**
- **NOT RUN**
- **BLOCKED**

Never infer PASS from code inspection alone when an executable verification exists.
