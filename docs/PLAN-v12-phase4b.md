# Implementation Plan — v12 Phase 4b: per-tenant app-only session pool

> Completes the deferred Phase 4b from `docs/PLAN-v12-rbac.md`. Fixes the
> shared-session credential bleed found in production (a second user saw the
> tool "connected as" the admin, and their reports ran against the admin's
> delegated token). Direction chosen by the operator: **app-only per tenant**
> (ADR-0006 model), with the tool's own hardened audit log as the system of
> record for "who".
>
> Target version: **v12.1.0** (minor — adds concurrent per-tenant sessions +
> audit hardening; in-container behavior change but no local API break).
> Branch: `feature/v12-phase4b`.

## Root cause (confirmed in code)

Everything is process-global:
- one `pwsh` process (`psProc`), started at boot — `server.js`;
- one `connectionInfo` shared by all callers;
- one FIFO queue serializing all jobs through that single stdin.

What is live in production is a **delegated device-code** session, so the admin's
personal token sits in the shared session and every user's reports execute as the
admin. Root fix: retire delegated auth server-side (in-container) in favor of
**app-only certificate** connections, and key sessions per tenant so nobody's
personal token is ever server-side.

## Guiding decisions

1. **App-only is mandatory in `DOCKER_MODE`.** Delegated/device-code connect is
   refused in-container; it remains only the localhost-dev fallback. The
   connection identity becomes the app SP — never a person.
2. **Sessions are keyed per tenant slug**, not per user. Under app-only the
   connection is not tied to a human, so all users authorized for a tenant safely
   share that tenant's app-only session. Cost is bounded by number of tenants
   (2–3), not users.
3. **`maxReplicas` stays 1.** Sessions are in-memory per replica; a single replica
   handles all tenants concurrently. Scaling >1 replica is a separate future
   capacity step and would require ACA **session affinity** (documented, not done
   here).
4. **Per-tenant FIFO preserved.** One stdin per tenant session ⇒ commands within a
   tenant still serialize (keeps the no-interleave invariant). Concurrency is
   *across* tenants.
5. **The tool's own audit log is hardened** to become the authoritative "who"
   record (app-only attributes to the SP in the M365 unified log).

## Design — session pool

New module **`sessions.js`** owns the per-tenant pwsh lifecycle (unit-testable in
isolation; keeps `server.js` manageable).

```
TenantSession {
  slug, tenantId, clientId,
  psProc, psAlive, starting,
  connectionInfo { graphConnected, exchangeConnected, account, tenantId, clientId },
  jobQueue[], activeJobId,
  certPath,            // staged cert temp file (for cleanup on evict/disconnect)
  lastUsedAt,
}
// pool: Map<tenantSlug, TenantSession>
```

- `getSession(slug)` — lazy-create + start the pwsh for a tenant.
- `runInSession(slug, cmd, jobId, opts)` / `pumpQueue(slug)` / `executeInSession` —
  the current single-session functions, parameterized by session.
- `evictIdle()` — sweep on an interval; kill pwsh + unlink `certPath` + drop from
  pool when `lastUsedAt` older than `IDLE_MS` (default 30 min).
- Global `jobs` Map stays (jobId is unique) for `/api/job/:jobId` lookups.
- Local-dev path uses a single implicit session (keyed `"local"`) with the
  existing delegated device-code flow — localhost behavior unchanged.

## Request routing (which session?)

Every report/browse/pack request must name its tenant. The UI already has a
tenant dropdown; it will send the selected tenant slug. Server resolves
`session = pool.get(slug)`, re-checks `rbac.can(user, { tenant: slug, ... })`,
and runs in that session; 409 if the tenant isn't connected.

## File-level changes

| File | Change |
|---|---|
| `sessions.js` *(new)* | Per-tenant session pool + pwsh lifecycle (moved out of server.js), idle eviction, app-only connect orchestration. |
| `server.js` | Replace global `psProc`/`connectionInfo`/queue with the pool. Connect routes: **refuse delegated in `DOCKER_MODE`**; app-only only. Add `tenant` to `/api/run`, `/api/browse/*`, `/api/pack/run`, dashboard; route to the tenant session. `/api/health` reports the caller's selected-tenant status (admin: all sessions). Disconnect/restart operate per tenant. |
| `audit.js` | Hardening: **hash chain** (`prevHash` per entry), explicit `connection` detail (clientId + tenant), `correlationId` per run. Back-compat read. |
| `public/index.html` | Send selected tenant with every data request; per-tenant connection banner ("Connected: <app> · tenant AM"); status polling keyed to selected tenant. |
| `deploy/main.bicep` | `maxReplicas` stays 1; add a comment/TODO for session affinity when scaling. Env already wired. |
| `test/` | New: pool routing (two tenants concurrent), `DOCKER_MODE` refuses delegated, per-tenant guard, audit hash-chain integrity. Extend the existing guard-matrix suite. |
| `docs/ARCHITECTURE.md`, `PLAN-v12-rbac.md`, `PERMISSIONS.md`, `README.md`, `CHANGELOG.md` | Update the connection/identity model; mark Phase 4b done; audit-log format note; version bump. |

## Behavior changes to flag

- In-container, a user can no longer connect delegated-as-themselves. Every tenant
  they select must be **app-only configured** (cert in Key Vault). Today only AM
  is configured, so only AM works until GP/EMVCo are onboarded.
- The "Connected as <person>" banner becomes "Connected: <app> · <tenant>".

## Build sequence (shippable increments)

1. [x] **`sessions.js` + pool wiring**, local-dev unchanged. Existing 12/12 green.
2. [x] **App-only gate:** delegated refused in `DOCKER_MODE`; connect → tenant
   session. Kills the bleed.
3. [x] **Route `tenant` through** run/browse/pack/dashboard + `GET /api/connection`
   + UI (selected slug injected on every request).
4. [x] **Audit hardening** (hash chain + `verifyAuditChain` + connection detail on
   report runs). `correlationId` not added — the hash chain + tenant/connection
   detail already give per-action traceability; revisit if reconciling to Graph
   telemetry becomes a need.
5. [x] **Idle eviction** (30 min) + staged-cert cleanup on evict/disconnect.
6. [x] **Tests** (`test/phase4b.sessions.test.js`, 22/22), **docs, v12.1.0**.
   Deploy pending operator go-ahead.

## Status: code complete on `feature/v12-phase4b`

All steps implemented and tested offline. Not yet exercised against live Graph/
EXO (needs the deployed app-only path). Known follow-ups: switch-tenant-after-
connect UI (currently requires disconnect); multi-replica needs session affinity.

## Risks / watch-items

- **Selected-tenant trust:** the tenant slug is client-supplied; always re-check
  `rbac.can(user, { tenant })` server-side (never trust the client's choice).
- **EXO app-only** still needs the manual `New-ManagementRoleAssignment` step
  (`deploy/Grant-ExoAppOnlyRole.ps1`) per tenant before Exchange reports work.
- **Cert rotation:** sessions cache a staged cert; eviction + re-fetch on next
  connect picks up a rotated cert without redeploy.
- **Memory:** ~250–400 MB per active tenant session; fine for 2–3 tenants on one
  replica. Revisit sizing before onboarding many tenants.
- **Multi-replica later:** requires ACA session affinity (sessions are
  replica-local); out of scope here.
