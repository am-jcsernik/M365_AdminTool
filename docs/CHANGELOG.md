# Changelog -- M365_AdminTool

All notable changes to deliverables in this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [Unreleased]
### Added
- Initial project scaffold.
- **App source brought under version control** and promoted as the tracked
  baseline (was an untracked working copy). Deliverable now versioned in the
  repo-root `CHANGELOG.md`, which is authoritative for the app.
- **Azure Container Apps deployment** support (app **v11.12.0 → v11.12.2**):
  `DATA_DIR` volume, fixed Dockerfile, `deploy/` artifacts (Bicep + PowerShell
  + guide), and device-code sign-in surfaced in the UI for Graph and Exchange.
  See root `CHANGELOG.md` and `docs/ARCHITECTURE.md` for detail. Local container
  validation complete; live ACA deploy not yet performed.

## [0.1.0] -- 2026-07-14
### Added
- Project scaffolded: CLAUDE.md, docs/ (STATE, DECISIONS, ARCHITECTURE, CHANGELOG),
  .claude/commands/ (resume, wrap), git initialized.
