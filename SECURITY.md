# Security Policy

GitHub Vault Relay is designed with a defense-in-depth, conservative security architecture tailored for running within the sandboxed mobile environment of Obsidian Mobile (iOS/Android) as well as Obsidian Desktop.

---

## 🛡️ Supported Versions

| Version | Supported | Status |
| :--- | :--- | :--- |
| **0.7.x** | :white_check_mark: | Active Release Candidate (pre-release) |
| **0.6.x** | :white_check_mark: | Supported pre-release |
| **< 0.6.0** | :x: | Deprecated preview builds |

---

## 🔑 Credential Storage & Lifecycle

1. **Obsidian SecretStorage Only**:
   - The GitHub Personal Access Token (PAT) is stored exclusively in Obsidian's secure credential storage (`App.secretStorage`) under the canonical key:
     ```
     github-vault-relay-pat
     ```
   - **Zero Plaintext Persistence**: The token is never written to plugin configuration (`data.json`), browser `localStorage`, or session storage.
2. **Automatic Legacy Token Migration**:
   - Earlier versions that used legacy keys (`vault-relay-pat` or `vault-relay:pat`) are automatically migrated into the canonical key on startup, after which the legacy entry is permanently deleted.
3. **Confirmed Credential Purge**:
   - The **Clear Token** action is isolated in the Advanced / Security section and requires explicit two-step modal confirmation (`ClearTokenConfirmModal`). Upon confirmation, credentials are removed from `SecretStorage` and memory.
4. **Token Revocation Guidance**:
   - If you suspect your device or token has been compromised, immediately revoke the token in GitHub:
     **GitHub** -> **Settings** -> **Developer settings** -> **Personal access tokens** -> Select token -> **Revoke / Delete**.

---

## 🔒 Principle of Least Privilege (PAT Permissions)

We strongly recommend configuring a GitHub **Fine-Grained Personal Access Token**:
- **Repository Access**: *Only select repositories* -> Select your specific Obsidian vault repository only.
- **Repository Permissions**:
  - **Contents**: `Access: Read and write` (Metadata read access is automatically granted).
- **Expiration**: Set a sensible expiration date (e.g., 90 days or 1 year) according to your personal threat model.

Classic PATs with scope `repo` are technically supported by GitHub, but provide broader permissions than Vault Relay requires.

---

## 🌐 Network & Endpoint Surface

1. **Strict Endpoint Restriction**:
   - Vault Relay communicates exclusively with GitHub's official HTTPS API:
     ```
     https://api.github.com
     ```
   - No third-party servers, no metrics relays, no crash telemetry, and no intermediate proxies.
2. **Approved Remote Write Endpoints Only**:
   - Vault Relay mutates the remote repository strictly via the low-level Git Data API:
     - `POST /repos/{owner}/{repo}/git/blobs` (upload raw note blobs)
     - `POST /repos/{owner}/{repo}/git/trees` (assemble commit tree with `base_tree`)
     - `POST /repos/{owner}/{repo}/git/commits` (create immutable Git commit; references canonical empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904` directly when all files are removed)
     - `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` (update branch ref with `force: false`)
3. **Forbidden Endpoints (Enforced by Quality Gates)**:
   - **Zero `DELETE` Endpoints**: Vault Relay contains 0 calls to GitHub `DELETE` endpoints. Deletions remain deferred.
   - **Zero `PUT /contents` Endpoints**: Vault Relay never uses the monolithic Contents API that could overwrite whole files blindly.

---

## 🛡️ Concurrency & Integrity Invariants

1. **Zero Force Push (`force: false`)**:
   - Every branch ref update strictly sets `force: false`. If the remote branch HEAD has advanced since the last scan (e.g. from an external Git commit), GitHub rejects the ref update, and Vault Relay aborts safely (`REMOTE_CHANGED_DURING_PUSH`).
2. **Authoritative Post-Write Verification**:
   - Before local sync state is updated, Vault Relay performs an independent authoritative `GET` check on the branch ref to verify that GitHub's authoritative ref matches the newly created commit.
3. **Fail-Closed Git Mutation Requests**:
   - HTTP automatic retries are strictly confined to idempotent `GET` requests (max 3). Non-idempotent mutations (`POST`, `PATCH`) fail closed immediately on connection loss to prevent duplicate commits or ambiguous remote states.
4. **Local Mutation Lease Lock**:
   - A runtime `MutationCoordinator` enforces mutual exclusion across Safe Pull, Safe Push, Unified Sync, and Conflict Resolution to prevent race conditions within the Obsidian application instance.
5. **Path Traversal Defenses**:
   - `validatePathSafety()` verifies all relative file paths, blocking path traversal sequences (`..`), leading slashes, absolute paths, and operating system control paths.
6. **25 MiB Safety Ceiling**:
   - Individual files exceeding 25 MiB are skipped with an informative notification to protect mobile sandboxes from out-of-memory terminations (iOS Jetsam) and bandwidth exhaustion.
7. **Automatic Token Redaction**:
   - All network errors, notification toasts, and console logs pass through `redactTokens()` to scrub PAT patterns (`github_pat_*`, `ghp_*`, `Bearer *`).

---

## ⚠️ Threat Model & Explicit Non-Guarantees

Security requires transparency about what software **cannot** protect against:

1. **Compromised Host Device**:
   - If your mobile device or computer is compromised with malware, keyloggers, rootkits, or unauthorized physical access, attackers can access files or device credentials.
2. **Co-existing Malicious Obsidian Plugins**:
   - In Obsidian, all installed plugins run in the same JavaScript execution context. A malicious third-party plugin could inspect shared memory or DOM nodes. Only install community plugins you trust.
3. **External Git Writers & Upstream Compromise**:
   - If an authorized collaborator or compromised machine pushes malicious content directly to GitHub via native Git, Vault Relay will safely pull those files according to normal sync rules.
4. **Excessive User-Granted Permissions**:
   - If you create a classic PAT with `admin:repo_hook` or `delete_repo` scopes, Vault Relay will not use those permissions, but your token remains exposed to greater risk if compromised elsewhere.
5. **No Absolute Zero Data Loss Guarantee**:
   - Vault Relay prioritizes safety and explicit failure over silent guesswork. However, simultaneous out-of-band force pushes from external Git clients or hardware filesystem corruption can cause data loss outside Vault Relay's control.

---

## 🚨 Reporting a Vulnerability

We welcome responsible security disclosures. If you identify a potential security vulnerability in GitHub Vault Relay:

1. **Preferred Method**: Submit a private report via **GitHub Security Advisories**:
   [https://github.com/ankhang0704/github-vault-relay/security/advisories/new](https://github.com/ankhang0704/github-vault-relay/security/advisories/new)
2. **Alternative Method**: If GitHub Private Advisories are unavailable, open an issue requesting a private security contact without disclosing vulnerability details publicly.
3. **Information to Include**:
   - Clear description of the vulnerability and affected components
   - Minimal reproduction steps or proof-of-concept
   - Assessment of impact on mobile or desktop users
4. **Response Timeline**:
   - Maintainer will acknowledge report within 48 hours.
   - Verified vulnerabilities will be patched in a tracked security release candidate before public disclosure.
