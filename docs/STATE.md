# Project State
_Last updated: 2026-07-14 -- session 3_

## Current goal
Build **v12 multi-user RBAC** (three access tiers: who may use the tool → which
tenants → which reports/areas), plus per-tenant app-only certificate auth. Design
is settled; Phases 0-4a are implemented and verified. Remaining: Phase 5 (admin
UI), Phase 4b (concurrent pool + scale), Phase 6 (docs/release/deploy).

## Status
- [x] **Design settled** (session 3): reuse Easy Auth for identity; Entra security
      group as the overall-access gate; in-tool named reusable roles scoping
      tenants + areas/reports; first-admin via an Entra admin group; app-only cert
      per tenant with certs in Key Vault (ACA managed identity). See ADR-0006 and
      `RBAC-ROADMAP.md` / `docs/PLAN-v12-rbac.md`.
- [x] **Phase 0 — infra provisioned & verified** (on `main`): Key Vault `amm365kv`,
      system-assigned identity on the app + KV Secrets User, Entra access/admin
      groups, per-tenant app-only app registration + KV cert, admin consent
      (13/13 app roles). Script: `deploy/Provision-RbacPhase0.ps1`.
- [x] **Phase 1 — AuthN plumbing** (`auth.js`): acting user from Easy Auth; dual
      identity in audit. 15/15.
- [x] **Phase 2 — authZ store + default-deny engine** (`rbac.js` + `reports.js`
      area index). 23/23.
- [x] **Phase 3 — route enforcement** (`server.js` guards). 19/19 (real-server).
- [x] **Phase 4a — app-only cert connection** (`keyvault.js`, `tenants.js`) +
      **Dockerfile COPY fix**. 20/20.
- [ ] **Phase 4b (deferred)** — concurrent per-tenant connection pool + lift
      `maxReplicas 1`. Needs live multi-tenant to validate.
- [ ] **Phase 5** — admin UI in `public/index.html` (tenant/role/assignment
      management + audit viewer; friendly-name tenant dropdown).
- [ ] **Phase 6** — docs, integration tests, bump to **v12.0.0** + deploy.

## Active context
- **Branch:** all v12 *code* is on **`feature/v12-rbac`** (Phases 1-4a). Phase 0
  infra tooling + design docs are on `main`. Remotes: `origin` (work,
  am-jcsernik), `personal`.
- **Phase 0 identifiers (for the RBAC store / env wiring):**
  - Key Vault `amm365kv` (eastus2, RBAC-auth mode)
  - App system-assigned identity principalId `0b7246b9-cd65-40d1-b399-32532e251aff`
  - Access group `197dd092-df14-4052-ac0e-f1382f701b68`
  - Admin group `bb661e80-e275-4e22-8a55-0615f5e7a4af`
  - App-only app (client) ID `25407385-9354-471d-8532-6ea147a00f42`; SP objectId
    `dea11da4-0294-4399-a983-75b54f83d946`
  - Certificate `kv:m365-report-am` (expires 2027-07-15)
- **Verification approach:** each phase has a throwaway harness (removed after
  running); Phases 3/4a boot the real server and drive HTTP. The live cert-based
  `Connect-MgGraph` is NOT locally verifiable (no MI / cert on the workstation) —
  first real exercise is at deploy.
- **RBAC store:** `DATA_DIR/access/rbac.json`, mtime-cached; seeds tenants from
  `config.json` and group ids from env on first run; default-deny.
- **Local dev is a full admin** (auth.js) so enforcement never locks out localhost.

## Manual follow-ups still open (Phase 0)
- Add members to the Entra **Access** and **Admin** groups.
- **Exchange app-only:** assign the app SP (`dea11da4…`) an Exchange RBAC role
  (e.g. View-Only Organization Management) in Exchange Online — manual EXO step.

## Next session should start by
1. **Phase 5 — admin UI** in `public/index.html`: tenant management (friendly
   name, tenantId, clientId, `kv:` cert ref), role definitions (tenants +
   areas/reports), user/group assignments, and the audit viewer — all admin-gated
   in UI *and* already gated server-side. Add the admin CRUD API routes it needs
   (guarded by `requireAdmin`), writing via `rbac.saveStore`.
2. Then **Phase 6**: set the container env (`KEY_VAULT_NAME`, `ADMIN_GROUP_ID`,
   `ACCESS_GROUP_ID`) — **without these + at least one admin, enabling
   enforcement locks everyone out** — seed the store, bump to v12.0.0, deploy,
   and validate the app-only connect live. Then tackle Phase 4b if concurrent
   multi-tenant is needed.

## Open questions / watch-items
- **Deploy-time lockout risk:** v12 enforcement requires the env group ids + a
  populated store before it goes live, or operators are 403'd.
- **Group-claim overage:** Entra truncates group claims for users in many groups;
  `auth.js` flags `groupsOverage` but the Graph `memberOf` fallback is not built
  yet (needed before relying on group-based rules at scale).
- **Local ACR data-plane read** still fails from this workstation
  (`CONNECTIVITY_CHALLENGE_ERROR`) — cosmetic for deploys (carried from session 2).
