# Project State
_Last updated: 2026-07-15 -- session 4_

## Current goal
**v12 multi-user RBAC is COMPLETE and DEPLOYED** (v12.0.0 live in ACA). Three
access tiers (who may use the tool → which tenants → which reports/areas) +
per-tenant app-only certificate auth. All phases done except the deferred
Phase 4b (concurrent connection pool). Remaining work is operational: populate
roles/assignments via the admin UI and validate the live app-only connect.

## Status
- [x] **Design** (ADR-0006) and **implementation choices** (ADR-0007) settled.
- [x] **Phase 0 — infra** (Key Vault `amm365kv`, app managed identity + KV
      Secrets User, Entra access/admin groups, per-tenant app-only app reg + cert
      + admin consent). `deploy/Provision-RbacPhase0.ps1`.
- [x] **Phase 1 — AuthN** (`auth.js`, Easy Auth acting user). 15/15.
- [x] **Phase 2 — authZ store + engine** (`rbac.js`). 23/23.
- [x] **Phase 3 — route enforcement** (`server.js`). 19/19.
- [x] **Phase 4a — app-only cert connect** (`keyvault.js`, `tenants.js`). 20/20.
- [ ] **Phase 4b (deferred)** — concurrent per-tenant connection pool + lift
      `maxReplicas 1`. Needs live multi-tenant to validate.
- [x] **Phase 5 — admin UI + API** (`public/index.html` Access Control panel;
      `requireAdmin` CRUD under `/api/admin/*`). Verified in-browser + curl.
- [x] **Phase 6 — tests, docs, release, deploy.** Integration suite
      (`test/rbac.guards.test.js`, `npm test`, **12/12**); docs (README,
      PERMISSIONS, ARCHITECTURE, CHANGELOGs); **v12.0.0**; deployed to ACA.

## Deploy — v12.0.0 LIVE (session 4)
- **URL:** https://m365-admin-reports.calmisland-95b7b76c.eastus2.azurecontainerapps.io
- Image `amm365acr.azurecr.io/m365-admin-reports:12.0.0` (digest `fb366906…`),
  revision `m365-admin-reports--0000001`, Healthy, restarted for the rotated
  Easy Auth secret. RG `rg-m365admin`, eastus2.
- Container env now wires `KEY_VAULT_NAME=amm365kv`,
  `ACCESS_GROUP_ID=197dd092…`, `ADMIN_GROUP_ID=bb661e80…` (deploy script +
  Bicep updated to pass these; `deployKeyVault=false` reuses the Phase-0 vault).
- **Lockout prerequisites fixed at deploy time (were open in STATE):**
  - Easy Auth app reg `edb8be95…`: `groupMembershipClaims` set to **SecurityGroup**
    (previously null — the token carried NO groups, so admin could never resolve).
  - **`jcsernik-adm@am.consulting` added to the admin group** `bb661e80…`
    (both Entra groups were empty). This is the sole in-tool admin so far.

## Active context
- **Branch:** `feature/v12-rbac`. Code committed (`0420f1d` Phases 5-6) and the
  deploy-script fix + this wrap follow. Remotes: `origin` (am-jcsernik), `personal`.
- **Not yet merged to `main`.** ADR-0007 planned v12 as one PR to `main`; the
  live deploy was built from the `feature/v12-rbac` working tree. Open a PR and
  merge when ready.
- **Phase 0 identifiers:** KV `amm365kv` (eastus2, RBAC mode); app identity
  principalId `0b7246b9-cd65-40d1-b399-32532e251aff`; access group
  `197dd092-df14-4052-ac0e-f1382f701b68`; admin group
  `bb661e80-e275-4e22-8a55-0615f5e7a4af`; app-only client
  `25407385-9354-471d-8532-6ea147a00f42` (SP `dea11da4…`); cert
  `kv:m365-report-am` (exp 2027-07-15). Easy Auth app reg `edb8be95…`.
- **RBAC store:** `DATA_DIR/access/rbac.json` on the Azure Files share
  (`amm365data/m365data`), mtime-cached, default-deny. On first v12 boot it
  seeds tenants from `config.json` + the group ids from env.
- **In-container admin is group/env-only** — there is no admin-via-assignment
  path, so admin depends on the Easy Auth `groups` claim carrying the admin
  group id (now enabled).

## Verify next (interactive — needs a real sign-in)
1. Sign in at the URL as **jcsernik-adm@am.consulting** → confirm the
   **Access Control** panel appears (proves group-claim admin works end-to-end).
2. In the panel, define tenant cert config for AM (clientId + `kv:m365-report-am`),
   create roles, and assign users/groups. Add members to the **access group**
   (still empty) or grant per-user roles.
3. Connect: with `KEY_VAULT_NAME` set, Graph/EXO connect should use **app-only
   cert** for a configured tenant — first live exercise of `Connect-MgGraph
   -Certificate` (unverifiable locally). Device code remains the fallback.

## Manual follow-ups still open
- **Access group is empty** — no one has tool access except the admin. Populate
  it or assign roles.
- **Exchange app-only:** assign the app SP (`dea11da4…`) an Exchange RBAC role
  (e.g. View-Only Organization Management) in Exchange Online — manual EXO step.
- **Merge `feature/v12-rbac` → `main`** via PR.

## Open questions / watch-items
- **App-only connect unverified live** — first real run happens when someone
  connects a cert-configured tenant in the deployed app.
- **Group-claim overage** — `auth.js` flags it but the Graph `memberOf` fallback
  isn't built; needed before group-based rules for users in many groups.
- **Phase 4b** — single in-memory session still caps `maxReplicas 1`.
- Local `*.azurecr.io` data-plane read still fails from this workstation
  (`CONNECTIVITY_CHALLENGE_ERROR`) — cosmetic for deploys.
