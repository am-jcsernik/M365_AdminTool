# Changelog -- M365_AdminTool

All notable changes to deliverables in this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [12.1.3] — 2026-07-15
### Changed
- **Hosted connect card is app-only.** In `DOCKER_MODE` the delegated-only
  controls (UPN box, "Tenant ID (local delegated only)", device-code checkbox,
  "Connect as Current User") are hidden — only the tenant selector + Connect
  remain, Connect is disabled until a tenant is picked, and the connecting banner
  drops the browser-sign-in wording. Delegated controls still show on localhost.
### Added
- **No-access / no-tenant messaging** — an authenticated-but-unauthorized caller
  sees a clear "No access, ask an admin" banner instead of a dead Connect button;
  a caller with access but no granted tenant sees a targeted note.
- **`npm run lint:copy`** — guards the require()→Dockerfile-COPY invariant.
### Fixed
- **Dockerfile now copies every module (`COPY *.js ./`)** — retires the fragile
  explicit list that crash-looped the image twice (ADR-0007; v12.1.1).

## [12.1.2] — 2026-07-15
### Fixed
- **App-only connect result capture (`raw: true`).** The app-only Graph/Exchange
  connect commands write to `__OUTFILE__` (substituted only in raw mode) but were
  run without `raw: true`, so `Connect-MgGraph -Certificate` succeeded yet
  produced no captured output — the server never set `graphConnected`, leaving
  every Run button disabled. Pre-existing since Phase 4a; first live app-only
  connect surfaced it. Both app-only calls now pass `raw: true`.

## [12.1.1] — 2026-07-15
### Fixed
- **Dockerfile `COPY` now ships `sessions.js`** — the 12.1.0 image omitted the new
  Phase 4b module and crash-looped on boot (MODULE_NOT_FOUND → ingress 404).
  12.1.1 is the first working Phase 4b image. (ADR-0007 Dockerfile-COPY hazard,
  recurred.)

## [12.1.0] — 2026-07-15
### Changed
- **v12 Phase 4b — per-tenant app-only session pool** (`feature/v12-phase4b`).
  Fixes a production shared-session credential bleed: a second user saw the tool
  connected as the admin and ran reports against the admin's delegated token.
  - **`sessions.js` (new):** per-tenant PowerShell session pool (own process,
    connection, FIFO queue, browse/dashboard caches, staged cert) replacing the
    single process-global session; lazy start + 30-min idle eviction.
  - **App-only enforced in `DOCKER_MODE`:** delegated/device-code connect refused
    (400); connection identity is always the app SP. Delegated is localhost-only.
  - **Tenant routed per request** through run/browse/pack/dashboard/connect;
    `rbac.can(user,{tenant})` re-checked server-side. New `GET /api/connection`;
    `/api/health` slimmed to liveness + PowerShell state.
  - **UI** sends the selected tenant slug on every data request.
### Added
- **Tamper-evident audit hash chain** (`audit.js`): `verifyAuditChain()` +
  `integrity` on `GET /api/audit`. `deploy/Grant-ExoAppOnlyRole.ps1` for the
  manual Exchange app-only RBAC step. Tests: `test/phase4b.sessions.test.js`
  (22/22 total).

## [12.0.0] — 2026-07-15
### Added
- **v12 multi-user RBAC** (one major version on `feature/v12-rbac`). Three access
  tiers: who may use the tool → which tenants → which reports/areas.
  - **Phase 0 (infra):** Key Vault, app managed identity, Entra access/admin
    groups, per-tenant app-only app registration + KV certificate + admin
    consent. Idempotent `deploy/Provision-RbacPhase0.ps1`; gated Bicep additions.
  - **Phase 1 (authN):** `auth.js` resolves the acting user from Easy Auth
    headers; audit records both the acting user and the connection identity.
  - **Phase 2 (authZ):** `rbac.js` default-deny engine + writable store
    (`DATA_DIR/access/rbac.json`); named reusable roles scoping tenants +
    areas/reports; `reports.js` area index.
  - **Phase 3 (enforcement):** per-request access gate + tenant/report guards on
    the API; `/api/reports` and `/api/config` filtered to the caller; admin-only
    `/api/audit`; every deny audited.
  - **Phase 4a (connection):** app-only certificate connect per tenant, cert
    fetched from Key Vault via the managed identity (`keyvault.js`, `tenants.js`);
    device code retained as default/fallback.
  - **Phase 5 (admin UI):** admin-gated **Access Control** panel in
    `public/index.html` (tenants, roles, assignments, bootstrap group ids) +
    `requireAdmin` CRUD API under `/api/admin/*`, writing atomically via
    `rbac.saveStore`; deletes cascade; `/api/config` exposes an `admin` flag.
  - **Phase 6 (release):** integration test suite (`test/`, `npm test`) covering
    the guard matrix offline; docs refreshed (`README.md`, `PERMISSIONS.md`,
    `docs/ARCHITECTURE.md`); bumped to **v12.0.0**.
  - **Deferred:** Phase 4b (concurrent per-tenant pool + `maxReplicas` lift) and
    the group-claim overage fallback.
- Initial project scaffold.

### Fixed
- **Dockerfile `COPY`** now includes `auth.js`, `rbac.js`, `tenants.js`,
  `keyvault.js` — without this the v12 image would crash on boot (server.js
  require()s them).
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
