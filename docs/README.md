# GitHub Vault Relay Documentation Index

This index points to the current `1.0.4` documentation baseline. Current source, tests, manifest, and `main` take precedence over historical checkpoint notes.

---

## 👤 For Users
- **[Plugin User Guide & Overview](../README.md)**: Features, installation via BRAT or manual release assets, PAT setup, Unified Sync, and conflict resolution.
- **[Security Policy & Disclosure](../SECURITY.md)**: Supported versions, credential storage in SecretStorage, network surface, and responsible vulnerability disclosure.

---

## 💻 For Engineers & Contributors
- **[Project Source of Truth](PROJECT_SOURCE_OF_TRUTH.md)**: Current identity, ten classifier states, baseline semantics, evidence, ownership wording, and closure status.
- **[Engineering Notes](ENGINEERING_NOTES.md)**: Maintainer study guide explaining Git objects, GitHub APIs, concurrency, conflicts, deletion, recovery, storage, and implementation-backed Q&A.
- **[System Architecture](ARCHITECTURE.md)**: Current components, Unified Sync sequence, Git object construction, conflict resolution, deletion/move ordering, and recovery lifecycle.
- **[Manual Test Matrix](MANUAL_TEST_MATRIX.md)**: Real Windows/iOS acceptance protocol. Rows remain `NOT RUN` until physically executed and recorded.
- **[Contributing Guidelines](../CONTRIBUTING.md)**: Development prerequisites, quality gate commands (`npm run verify`), safety invariants, and AI-assisted development policy.
- **[Changelog](../CHANGELOG.md)**: Chronological release history through `1.0.4`; older test totals are historical snapshots.

---

## 📜 Development History & Provenance
The documents in `docs/development-history/` preserve the chronological design decisions, exploratory audits, and verification checkpoints of prior milestones. 

> [!NOTE]
> **Historical Provenance Only**: These files are preserved as historical engineering records and audit trails. For the current authoritative technical specification, refer to [PROJECT_SOURCE_OF_TRUTH.md](PROJECT_SOURCE_OF_TRUTH.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

### Checkpoints
- **[2026-09-02 C3 Safety Freeze](development-history/checkpoints/2026-09-02-c3-freeze.md)**: Safe Push implementation and cache-safe ref reading.
- **[2026-09-03 C4 Implementation](development-history/checkpoints/2026-09-03-c4-implementation.md)**: Unified Sync, Connection Wizard, Conflict Resolution, and canonical internal storage migration.
- **[2026-09-04 C5 Production Hardening](development-history/checkpoints/2026-09-04-c5-production-hardening.md)**: Final MVP hardening, mutation lease locking, pull write journal recovery, failure injection, scale benchmarks, and 0.5.0 RC release.
- **[2026-09-05 C6 Safe Delete & Move Semantics](development-history/checkpoints/2026-09-05-c6-safe-delete-move.md)**: Three-way deletion classifier, ordered pull moves, single-commit move batching, delete recovery, and 0.6.0 RC release.
- **[2026-09-06 C7 Release Readiness & Empty-Tree Closure](development-history/checkpoints/2026-09-06-c7-release-readiness.md)**: Canonical empty tree closure, zero-file convergence, first file creation, 0.7.0 RC release.

### Audits
- **[2026-09-01 C1 Fit Reference Audit](development-history/audits/2026-09-01-c1-fit-reference-audit.md)**: Analysis of existing community plugins and mobile sync challenges.
- **[2026-09-01 C1 Multi-Reference Recon](development-history/audits/2026-09-01-c1-multi-reference-recon.md)**: Technical evaluation of Git Data API patterns and mobile constraints.
