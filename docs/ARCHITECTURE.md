# Architecture -- M365_AdminTool

> Update this whenever the design changes. Keep it the single source of truth for
> "how the system is shaped." Keep volatile status out of here (that's STATE.md).

## Overview

M365 Admin Reports is a **read-only** Microsoft 365 admin reporting web app.
A Node.js/Express backend serves a single-file React frontend (`public/index.html`,
Babel-standalone, no build step) and drives one persistent PowerShell 7 session
that runs Microsoft Graph and Exchange Online cmdlets. The client never submits
raw PowerShell — it sends `{reportId, params, fields}` and the command is built
server-side from a fixed catalog. The app runs locally on `127.0.0.1:3365` by
default and containerizes cleanly for Azure Container Apps.

## Components

- **`server.js`** — Express server: PowerShell session lifecycle, the FIFO job
  queue, file-based IPC, the `isSafe` read-only guard, and all `/api/*` routes.
  Version comes from `package.json` via `require` (never hardcoded).
- **`reports.js`** — server-owned report catalog (49 reports, 8 categories) +
  `buildCommand(report, fields, params)`: field whitelist and parameter
  sanitizing.
- **`packs.js`** — audit-pack definitions (param-free report bundles).
- **`snapshots.js`** — point-in-time report snapshots + the diff engine.
- **`audit.js`** — append-only JSONL audit log with an identity-provider hook.
- **`public/index.html`** — the entire frontend (dense `React.createElement`).
- **`scripts/lint-reports.js`** — structural + `isSafe` + PowerShell-AST lint.

### PowerShell IPC

Commands are marshalled to the persistent `pwsh` session via temp files in the
OS temp dir (`<tmp>/m365-admin-reports/<jobId>.ps1`) with results returned as
`.out` / `.err` / `.done` sidecars, serialized through the job queue. Temp
scratch is intentionally ephemeral and separate from durable state.

## Data / control flow

```
Browser ──HTTP──▶ Express (/api/*) ──▶ Job queue ──▶ pwsh session ──▶ Graph/EXO
   ▲                   │                                   │
   └── JSON envelope ◀─┴──── .out/.err/.done (temp IPC) ◀──┘

Durable state (DATA_DIR): M365Snapshots/ M365AuditLog/ M365Logs/ M365Reports/
```

## Persistent state — `DATA_DIR`

All durable state is written under `DATA_DIR`, which defaults to
`process.cwd()` (unchanged local behavior) and is set to a mounted volume in a
container:

| Dir | Owner | Purpose |
|-----|-------|---------|
| `M365Snapshots/` | `snapshots.js` | report snapshots + diff source |
| `M365AuditLog/`  | `audit.js`     | append-only JSONL audit trail |
| `M365Logs/`      | `server.js`    | `console-YYYY-MM.log` (stdout is ephemeral) |
| `M365Reports/`   | `server.js`    | exported CSVs |

Ephemeral IPC scratch stays in the OS temp dir and is deliberately **not** under
`DATA_DIR`.

## Deployment shape — Azure Container Apps

Target: a single long-running **Container App** (not a Job). See `deploy/`
(`main.bicep`, `Deploy-ToAca.ps1`, `README.md`).

- **Image** — Ubuntu 22.04 + Node 20 + PowerShell 7 + the Graph/EXO modules
  (`Dockerfile`, `DOCKER_MODE=1`, non-root user, `/api/health` HEALTHCHECK).
- **Ingress** — external, target port 3365, TLS terminated at the platform edge
  (`allowInsecure=false`); the app itself speaks plain HTTP inside the env.
- **Ingress gate** — Entra **Easy Auth**, restricted to the home tenant. This is
  the *outer* gate (who reaches the app); **v12 RBAC** enforces authorization
  *inside* it (which tenants/reports each caller may use). See below.
- **Graph/EXO auth** — **app-only certificate** per tenant (v12 Phase 4a), with
  the cert fetched from Key Vault via the Container App's managed identity at
  connect time; in-container **device-code** remains the fallback (and the
  admin-bootstrap path). Both are independent of the ingress identity, so an
  operator/app can connect into a client tenant after passing the gate.
- **Scale** — `minReplicas 0` (scale-to-zero) / `maxReplicas 1`. The single cap
  remains until the concurrent per-tenant connection pool ships (v12 **Phase 4b**,
  deferred): the authenticated session is still one in-memory `pwsh` process.
  Durable state on the Azure Files volume survives cold starts.
- **Storage** — an Azure Files share linked to the environment and mounted at
  `DATA_DIR` (`/app/data`).

## Authentication & authorization — v12 RBAC

Three access tiers, default-deny throughout (ADR-0006/0007; `docs/PLAN-v12-rbac.md`):

1. **Who may open the tool** — Entra **Easy Auth** at the ingress, plus an
   in-tool **access gate**: the caller must be in a designated Entra *access
   group* OR hold at least one role assignment. Everyone else gets 403.
2. **Which tenants** — role assignments scope the caller to specific tenants
   (or `*`). The tenant dropdown and connect routes are filtered/guarded to that set.
3. **Which reports** — roles grant reports by **area** (category) and/or
   individual **report id** (or `*`). `/api/reports`, `/api/run`, packs,
   snapshots, diff and export are all filtered/guarded to the allowed set.

Components:
- **`auth.js`** — resolves the acting user from the `X-MS-CLIENT-PRINCIPAL*`
  Easy Auth headers (trusted only when present; never on the local bind, where a
  synthetic full-admin identity is used). Flags group-claim overage.
- **`rbac.js`** — the writable store (`DATA_DIR/access/rbac.json`, non-secret
  metadata only; mtime-cached, atomic writes) and the default-deny engine
  (`can(user, {tenant?, reportId?})`, `isAdmin`, `hasToolAccess`, `allowedTenants`).
- **`server.js`** — a `/api` access gate + per-route tenant/report guards +
  admin-only management routes (`/api/admin/*`, `requireAdmin`). Every deny is audited.
- **`public/index.html`** — an admin-gated **Access Control** panel (tenants,
  roles, assignments, bootstrap group ids); non-admins never see it and are
  refused server-side regardless.

**Two identities on every action:** the *acting user* (Easy Auth) and the
*connection identity* (the per-tenant app service principal), both recorded in
the audit log. App-only auth acts *as the app* (bounded by its granted
application permissions), not as the user — see `PERMISSIONS.md`.

**Deploy-time invariant:** enforcement requires the bootstrap group ids
(`ACCESS_GROUP_ID`/`ADMIN_GROUP_ID` env → seeded into the store) and at least one
admin/assignment *before* it goes live, or every operator is 403'd. The admin UI
(or `Provision-RbacPhase0.ps1`) populates this.

## Key constraints & assumptions

- **Read-only.** `isSafe` blocklists mutating cmdlets; `Invoke-MgGraphRequest`
  is GET-only (single exception: POST to the Graph `search/query` endpoint).
- **No raw PowerShell from the client.** Commands are built server-side only.
- **Localhost by default.** `HOST`/`DOCKER_MODE` widen the bind; network
  exposure is gated by Easy Auth at the edge and v12 RBAC inside the app.
- **Graph/EXO HTTP failures are terminating** — report code wraps calls in
  try/catch and returns an `ERROR` row, never a dead job.
- Windows dev workstation; OneDrive-redirected Documents require
  `[Environment]::GetFolderPath('MyDocuments')`.

## Open architectural questions

- **v12 RBAC — SHIPPED** (v12.0.0). See the section above and ADR-0006/0007.
- **Per-tenant app-only (certificate) Graph auth — SHIPPED (Phase 4a).** Still
  open: **Phase 4b** — the concurrent per-tenant connection pool that retires the
  single in-memory session and lifts `maxReplicas 1`; deferred until live
  multi-tenant traffic can validate it.
- **Group-claim overage fallback** — `auth.js` flags overage but the Graph
  `memberOf` lookup is not built yet; needed before relying on group-based rules
  for users in many groups.
- **Historical Search** (`Start-HistoricalSearch`) — async; needs a submit/poll
  state machine that doesn't fit the current synchronous job queue.

> Cross-link to `DECISIONS.md` as these resolve.
