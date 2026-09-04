# GitHub Vault Relay Documentation Index

Welcome to the documentation repository for **GitHub Vault Relay**. This index organizes documents by target audience and lifecycle stage.

---

## 👤 For Users
- **[Plugin User Guide & Overview](../README.md)**: Features, installation via BRAT or manual release assets, PAT setup, Unified Sync, and conflict resolution.
- **[Security Policy & Disclosure](../SECURITY.md)**: Supported versions, credential storage in SecretStorage, network surface, and responsible vulnerability disclosure.

---

## 💻 For Engineers & Contributors
- **[Project Source of Truth](PROJECT_SOURCE_OF_TRUTH.md)**: Canonical architectural summary, 6-state classifier rules, data models, verified metrics, and portfolio reference tables.
- **[System Architecture](ARCHITECTURE.md)**: Detailed system context, component diagrams, Unified Sync sequence, Safe Push Git object construction, conflict resolution state machine, and crash recovery lifecycle.
- **[Manual Test Matrix](MANUAL_TEST_MATRIX.md)**: Executable acceptance protocol (RT-01 through RT-22) for real Windows Desktop and iOS Mobile (BRAT) testing.
- **[Contributing Guidelines](../CONTRIBUTING.md)**: Development prerequisites, quality gate commands (`npm run verify`), safety invariants, and AI-assisted development policy.
- **[Changelog](../CHANGELOG.md)**: Chronological version history from 0.2.0 through 0.5.0 Release Candidate.

---

## 📜 Development History & Provenance
The documents in `docs/development-history/` preserve the chronological design decisions, exploratory audits, and verification checkpoints of prior milestones. 

> [!NOTE]
> **Historical Provenance Only**: These files are preserved as historical engineering records and audit trails. For the current authoritative technical specification, refer to [PROJECT_SOURCE_OF_TRUTH.md](PROJECT_SOURCE_OF_TRUTH.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

### Checkpoints
- **[2026-09-02 C3 Safety Freeze](development-history/checkpoints/2026-09-02-c3-freeze.md)**: Safe Push implementation and cache-safe ref reading.
- **[2026-09-03 C4 Implementation](development-history/checkpoints/2026-09-03-c4-implementation.md)**: Unified Sync, Connection Wizard, Conflict Resolution, and canonical internal storage migration.
- **[2026-09-04 C5 Production Hardening](development-history/checkpoints/2026-09-04-c5-production-hardening.md)**: Final MVP hardening, mutation lease locking, pull write journal recovery, failure injection, scale benchmarks, and 0.5.0 RC release.

### Audits
- **[2026-09-01 C1 Fit Reference Audit](development-history/audits/2026-09-01-c1-fit-reference-audit.md)**: Analysis of existing community plugins and mobile sync challenges.
- **[2026-09-01 C1 Multi-Reference Recon](development-history/audits/2026-09-01-c1-multi-reference-recon.md)**: Technical evaluation of Git Data API patterns and mobile constraints.
