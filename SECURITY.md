# Security Policy

Vault Relay is a conservative GitHub bridge. The current supported release is `1.0.6`; older releases are not the active security baseline.

## Credential storage

- The active PAT is stored only in Obsidian `SecretStorage` under `github-vault-relay-pat`.
- The plugin does not use `data.json` or localStorage as a runtime fallback.
- Legacy SecretStorage/localStorage locations are considered only for one-time migration when secure storage is available, then purged after verification.
- Clear Token requires explicit confirmation and removes the secure credential plus legacy leftovers.
- Users should use a fine-grained PAT limited to the target repository with Contents: Read and write. Set an expiration date.

## Network and write surface

The plugin communicates directly with `https://api.github.com` through Obsidian `requestUrl()`. There is no relay server, telemetry, analytics, or crash-reporting endpoint.

Remote writes are limited to Git Data API operations:

- `POST /git/blobs`
- `POST /git/trees`
- `POST /git/commits`
- `PATCH /git/refs/heads/{branch}` with `force: false`

The implementation does not call GitHub `DELETE` endpoints or `PUT /contents`. A remote deletion is represented by a Git tree omission; the final-file case uses the canonical empty tree SHA.

## Integrity and concurrency controls

- Branch updates always use `force: false`; concurrent remote history changes cause the update to abort.
- Remote HEAD/ref and resulting tree/blob SHAs are checked before the local baseline advances.
- Non-idempotent mutation requests fail closed on connection loss; bounded retry behavior is used for safe reads.
- `MutationCoordinator` prevents concurrent sync mutations within one Obsidian app instance.
- `validatePathSafety()` rejects traversal, absolute paths, control paths, excluded paths, and unsafe collisions.
- Files above 25 MiB are skipped by the Vault Relay safety policy.
- Pull writes and local deletion use verified recovery journals. Local remote-delete handling goes through Obsidian's trash API.
- Ambiguous content/delete conflicts are preserved for explicit review.

## Token redaction

`src/security/redact.ts` redacts configured tokens, GitHub PAT patterns, bearer credentials, authorization headers, and token-like URL parameters from sanitized error messages. User-facing GitHub/UI error paths use the sanitizer.

Production diagnostic warnings and user-facing caught-error notices pass through `sanitizeErrorMessage()` before output. Focused closure tests cover token-bearing errors/objects and scan production diagnostics for direct caught-error logging.

## Threat model and non-guarantees

Vault Relay cannot protect a compromised device, malicious co-installed Obsidian plugin, compromised GitHub account/collaborator, or external force-push that removes history. It also cannot promise zero data loss in the presence of host filesystem corruption or credentials stolen outside the plugin.

The plugin does not provide a distributed transaction: a successful Pull is retained if a later Push fails. GitHub rate limits, network loss, repository permissions, and an unborn repository can also prevent a sync from completing.

## Reporting a vulnerability

Please use a private [GitHub Security Advisory](https://github.com/ankhang0704/github-vault-relay/security/advisories/new). Include the affected component, impact, and a minimal reproduction. Do not disclose credentials or sensitive vault content in a public issue.
