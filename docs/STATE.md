# Project State
_Last updated: 2026-07-15 -- session 5_

## Current goal
**v12 Phase 4b — per-tenant app-only session pool — SHIPPED and DEPLOYED**
(v12.1.2 live in ACA). Closes the production shared-session credential bleed:
a second user saw the tool "connected as" the admin and ran reports against the
admin's delegated token. The tool now keys a PowerShell session per tenant,
enforces app-only certificate auth in-container (delegated refused), and hardens
the audit log with a hash chain. **Validated live** — app-only Graph connect
works and the connection identity is the app SP, not a person.

## Status
- [x] **Root cause confirmed** — v11's single process-global session/connection/
      queue; a live *delegated* session put the admin's token in front of everyone.
- [x] **`sessions.js` (new)** — per-tenant pool: own pwsh, connectionInfo, FIFO
      queue, browse/dashboard caches, staged cert; lazy start + 30-min idle evict.
- [x] **App-only enforced in `DOCKER_MODE`** — delegated/device-code connect
      refused (400); connection identity is always the app SP. Delegated survives
      only as the localhost-dev fallback.
- [x] **Tenant routed per request** — run/browse/pack/dashboard/connect resolve
      the caller's tenant and re-check `rbac.can(user,{tenant})` server-side.
      New `GET /api/connection`; `/api/health` slimmed to liveness + PS state.
- [x] **Audit hash chain** (`audit.js`) — `verifyAuditChain()`; `integrity` on
      `GET /api/audit`; connection identity recorded on report runs.
- [x] **UI** — selected tenant slug injected on every request; per-tenant
      connection banner; tenant selector by slug.
- [x] **Tests** — `test/phase4b.sessions.test.js` (delegated refusal, per-tenant
      routing/authz, audit integrity + tamper detection). `npm test` **22/22**.
- [x] **Deployed** v12.1.2 to ACA; **live app-only connect confirmed** (banner
      reads "AM Consulting (app-only)").

## Deploy — v12.1.2 LIVE (session 5)
- **URL:** https://m365-admin-reports.calmisland-95b7b76c.eastus2.azurecontainerapps.io
- Image `amm365acr.azurecr.io/m365-admin-reports:12.1.2`, revision
  `m365-admin-reports--0000006`, single active revision, **min 0 / max 1**
  (scale-to-zero). RG `rg-m365admin`, eastus2. Easy Auth app reg `edb8be95…`
  (secret rotated during deploy; revision restarted).
- **Two deploy-time bugs found and fixed (both first surfaced live):**
  1. **Dockerfile `COPY` omitted `sessions.js`** → image crash-looped
     (MODULE_NOT_FOUND) → 0 replicas → 404. Fixed in **v12.1.1** (`a6b47d3`).
     Recurrence of the ADR-0007 COPY hazard.
  2. **App-only connect ran without `raw: true`** → `Connect-MgGraph -Certificate`
     succeeded but its `__OUTFILE__` result was never captured, so `graphConnected`
     never set and Run buttons stayed disabled. Fixed in **v12.1.2** (`60bc80c`).
     Pre-existing since Phase 4a (never live-tested until now).

## Active context
- **Branch:** `feature/v12-phase4b`. Commits: `bf8d992` (Phase 4b),
  `a6b47d3` (v12.1.1 Docker fix), `60bc80c` (v12.1.2 raw-capture fix), plus this
  wrap. **Not yet merged to `main`.** Remotes: `origin`, `personal`.
- **Tenant slug is `am-consulting`** (not `am`) — the store id for AM Consulting.
  clientId `25407385-9354-471d-8532-6ea147a00f42`, cert `kv:m365-report-am`,
  tenantId `50e2cd3f-026a-42af-8e33-cc360a602f0d`.
- **Phase 4b identifiers** (unchanged from Phase 0): KV `amm365kv`; access group
  `197dd092…`; admin group `bb661e80…`; app SP `dea11da4…`.
- **Deploy friction:** the background deploy's output got truncated 3× by
  task teardown between turns (the build/Bicep completed anyway; verify via live
  Azure state, not the log). `az containerapp update --image <tag>` is the quick
  way to roll an image without a full script run.

## Manual follow-ups still open
- **Second-user test** — the exact original scenario: a non-admin signs in +
  connects AM, should see the app identity (not the admin) and only their reports.
  Not yet done.
- **Exchange app-only** — assign the app SP an Exchange RBAC role via
  `deploy/Grant-ExoAppOnlyRole.ps1`, then Connect Exchange. Only if mailbox
  reports are needed.
- **Merge `feature/v12-phase4b` → `main`** (v12.0.0 was merged; 4b is not).

## Next session should start by
1. **Merge `feature/v12-phase4b` → main** via PR (carries v12.1.2).
2. **Connect-card UI cleanup** — remove the vestigial delegated controls (UPN box,
   device-code checkbox, "Connect as current user") for the app-only hosted model;
   keep the tenant selector + Connect. Consider making the tenant selector
   available after connect (switch-tenant currently needs disconnect).
3. **Harden the Dockerfile** so a new module can't crash-loop again — either
   `COPY *.js ./` or a lint check that every `require("./x")` has a matching COPY.
4. Decide **min-replicas** (0 vs 1) — app-only means no device-code re-auth cost
   on cold start, but sessions still re-connect lazily; weigh latency vs cost.
5. Optional: second-user validation; Exchange app-only enablement.

## Open questions / watch-items
- **Multi-replica** needs ACA session affinity (sessions are per-replica in
  memory) — out of scope; `maxReplicas` stays 1.
- **Group-claim overage** — `auth.js` flags it; Graph `memberOf` fallback still
  not built (needed for users in many groups).
- Deploy secrets (ACR pw, storage key, Easy Auth secret) print in the deploy
  script's console output — they land in the local temp task-output file. Cosmetic
  but worth quieting.
