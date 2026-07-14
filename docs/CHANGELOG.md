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
  See root `CHANGELOG.md` and `docs/ARCHITECTURE.md` for detail.
- **Live ACA deploy performed and verified** (session 2). App v11.12.2 is live in
  **eastus2** (RG `rg-m365admin`): image in ACR `amm365acr`, Azure Files share
  `amm365data/m365data` for `DATA_DIR`, Entra Easy Auth (home tenant am.consulting)
  gating ingress, scale 0/1. Verified: browser → 302 Microsoft login, API → 401,
  and an in-app device-code Graph/Exchange connect succeeded end-to-end.

### Changed
- **`deploy/Deploy-ToAca.ps1` hardened** during the first live deploy:
  - Build with `az acr build --no-logs` to dodge the Windows client-side
    `UnicodeEncodeError` (colorama/cp1252 on a `→` in build logs) that aborted the
    deploy while the server-side build was actually succeeding.
  - Treat a clean `exit 0` build as success outright; only fall back to a tag
    check on non-zero exit.
  - New `-SkipBuild` switch to reuse an already-pushed image.
  - `-SkipBuild` tag check tolerates data-plane read failures
    (`CONNECTIVITY_CHALLENGE_ERROR`) instead of hard-failing (ACA pulls via ACR
    admin creds, so that read is not on the deploy's critical path).

## [0.1.0] -- 2026-07-14
### Added
- Project scaffolded: CLAUDE.md, docs/ (STATE, DECISIONS, ARCHITECTURE, CHANGELOG),
  .claude/commands/ (resume, wrap), git initialized.
