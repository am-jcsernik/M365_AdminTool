# Project State
_Last updated: 2026-07-15 -- session 6_

## Current goal
**v12.1.3 SHIPPED and DEPLOYED — second-user credential-bleed fully closed and
validated live.** The Phase 4b app-only model is now proven end-to-end with a
real second user (dave@am.consulting) connecting successfully. This session:
(1) diagnosed + fixed the live "second user can't connect" failure — a **data**
misconfiguration in the RBAC store, not a code bug; (2) cleaned up the connect
card for the app-only hosted model; (3) hardened the Dockerfile against the
recurring module-COPY crash-loop. Both open PRs merged to `main`.

## Status
- [x] **Second-user connect failure diagnosed from ground truth.** Pulled the live
      RBAC store + audit log + Entra group membership via `az`. Root cause: the
      `am-full-read` role's assignment pointed at the **"M365 Admin Reports -
      Access"** group (`197dd092…`, which Dave is NOT in) instead of **"M365 Admin
      Reports - AM Full Read"** (`8c763eb0…`, which he is). His token carried none
      of the store's referenced groups → `hasToolAccess` = false → denied at the
      access gate ("Not authorized to use this tool") before any tenant logic.
      The role being *named* `am-full-read` while assigned to the *Access* group
      was the trap. (Not group-claim overage — Dave is in ~30 groups, under cutoff.)
- [x] **RBAC store repointed (LIVE, out-of-band).** Repointed the assignment
      `197dd092` → `8c763eb0` directly on the Azure Files store; original backed up
      to `access/rbac.json.bak-20260715-repoint`. `rbac.js` hot-reloads on mtime,
      so it took effect without a deploy. **Dave refreshed and connected — verified.**
- [x] **#1 Connect card app-only cleanup** (`public/index.html`). In `DOCKER_MODE`:
      hide the delegated-only controls (UPN, "Tenant ID", device-code checkbox,
      "Connect as Current User"); show only the tenant selector + Connect (disabled
      until a tenant is picked); connecting banner drops the browser-sign-in
      wording. Added a clear **"No access — ask an admin"** banner for the RBAC-gate
      case (the exact dead-end Dave hit) + a "no tenant granted" note. Localhost
      keeps the delegated fallback (reads `dockerMode` from `/api/health`).
- [x] **#2 Dockerfile crash-loop guard.** `COPY *.js ./` replaces the fragile
      per-file list (fell out of sync twice: ADR-0007 auth/rbac; v12.1.1 sessions).
      New `npm run lint:copy` (`scripts/lint-copy.js`) walks the `server.js`
      require() graph and fails if any module is unresolved or uncopied.
- [x] **Versioned + validated.** Bumped **12.1.3**; both changelogs updated.
      `npm test` 22/22; `npm run lint` + `lint:copy` green; Babel-transformed the
      JSX (no syntax errors); ran the 12.1.3 build locally (page serves, health OK).
- [x] **Deployed 12.1.3 to ACA** and verified (see below).
- [x] **Both PRs merged to `main`.** PR #1 (Phase 4b, `feature/v12-phase4b`) and
      PR #2 (this session, `fix/connect-card-apponly`). `main` @ `34217d5` now
      matches what is live.
- [x] **`/access/` added to `.gitignore`** — local runtime RBAC store (seeded
      under `DATA_DIR`, defaults to cwd in dev) must never be committed.

## Deploy — v12.1.3 LIVE (session 6)
- **URL:** https://m365-admin-reports.calmisland-95b7b76c.eastus2.azurecontainerapps.io
- Image `amm365acr.azurecr.io/m365-admin-reports:12.1.3` (also tagged `latest`),
  revision **`m365-admin-reports--0000007`**, single active revision, 100% traffic
  (old `--0000006` drained to 0), min 0 / max 1. RG `rg-m365admin`, eastus2.
- **Quick-roll deploy** (not the full script): `az acr build --no-logs -r amm365acr
  -t m365-admin-reports:12.1.3 .` then `az containerapp update -n
  m365-admin-reports -g rg-m365admin --image …:12.1.3`. Preserves Easy Auth / KV /
  storage config (avoids the full script's secret-rotation + revision restart).
- Revision came up **Healthy** with a replica — real-world proof the `COPY *.js`
  image ships every module (the crash-loop mode that killed 12.1.0 did not recur).

## Active context
- **Branch:** `main` @ `34217d5` (clean, synced with origin). No feature branch
  open. Remotes: `origin` (am-jcsernik), `personal` (arcenik86).
- **`gh` auth:** now has BOTH accounts; `am-jcsernik` is the active account (it is
  the collaborator on `origin`). `arcenik86` alone could not create PRs on origin
  ("must be a collaborator"). Git push uses SSH and works regardless.
- **RBAC store model (live):** accessGroupId `197dd092` (Access — currently empty,
  the future "who may open the tool" gate); adminGroupId `bb661e80`; tenant
  `am-consulting` (clientId `25407385…`, cert `kv:m365-report-am`, tenantId
  `50e2cd3f…`); role `am-full-read` (tenants `*`, reports `*`) assigned to the
  **AM Full Read** group `8c763eb0` (Dave). Note: `hasToolAccess` grants entry to
  any role-holder, so a role assignment alone lets a user in even if the Access
  group is empty.
- **Store/audit are on the Azure Files share** `amm365data/m365data`:
  `access/rbac.json`, `M365AuditLog/audit-YYYY-MM.jsonl`. Readable via
  `az storage file download` with the account key (non-secret metadata).

## Manual follow-ups still open
- **Exchange app-only** — assign the app SP an Exchange RBAC role via
  `deploy/Grant-ExoAppOnlyRole.ps1`, then Connect Exchange. Only if mailbox
  reports are needed. (Only Graph app-only is proven so far.)
- **Group-claim overage fallback** — `auth.js` flags overage; the Graph `memberOf`
  fallback is still not built. Needed only for users in enough groups (~150+ SAML /
  200+ JWT) that Entra drops the `groups` claim. Not hit yet.
- **Access group is empty** — decide whether to actually use `197dd092` as the
  gate (add members) or lean solely on role assignments for entry.

## Next session should start by
1. Confirm nothing regressed post-deploy; optionally have another non-admin user
   exercise the flow now that the UI is cleaner.
2. If mailbox reports are wanted: run `deploy/Grant-ExoAppOnlyRole.ps1` and
   validate app-only **Exchange** connect.
3. Optional UX: allow switching tenants after connect (the connect card, and thus
   the tenant selector, currently only shows while disconnected — a connected user
   must disconnect to switch). Consider a compact tenant switcher in the header.
4. Optional: build the group-claim overage `memberOf` fallback in `auth.js`.
5. Decide min-replicas (0 vs 1) — app-only has no device-code re-auth cost on cold
   start, but sessions still re-connect lazily; weigh latency vs cost.

## Open questions / watch-items
- **Multi-replica** needs ACA session affinity (sessions are per-replica in
  memory) — out of scope; `maxReplicas` stays 1.
- **Deploying from a branch** was done again this session (built 12.1.3 before PR
  #2 merged), then merged after. Fine, but keep merging promptly so `main` stays
  the live truth.
- Deploy secrets (ACR pw, storage key, Easy Auth secret) still print in the full
  deploy script's console output. Cosmetic; the quick-roll path above avoids it.
