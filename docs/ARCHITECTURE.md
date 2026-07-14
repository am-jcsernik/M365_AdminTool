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
- **Ingress gate** — Entra **Easy Auth**, restricted to the home tenant. This
  is the access gate until app-level RBAC (v12) exists; see `RBAC-ROADMAP.md`.
- **Graph/EXO auth** — in-container **device-code** flow (`-UseDeviceAuthentication`,
  triggered by `DOCKER_MODE`); the operator reads the code from container logs.
  Independent of the ingress identity, so an operator can connect into a client
  tenant after authenticating at the gate.
- **Scale** — `minReplicas 0` (scale-to-zero) / `maxReplicas 1`. The single cap
  is required because the authenticated session is one in-memory `pwsh` process;
  cold starts require re-running the device-code connect. Durable state on the
  Azure Files volume survives.
- **Storage** — an Azure Files share linked to the environment and mounted at
  `DATA_DIR` (`/app/data`).

## Key constraints & assumptions

- **Read-only.** `isSafe` blocklists mutating cmdlets; `Invoke-MgGraphRequest`
  is GET-only (single exception: POST to the Graph `search/query` endpoint).
- **No raw PowerShell from the client.** Commands are built server-side only.
- **Localhost by default.** `HOST`/`DOCKER_MODE` widen the bind; network
  exposure is gated by Easy Auth until RBAC ships.
- **Graph/EXO HTTP failures are terminating** — report code wraps calls in
  try/catch and returns an `ERROR` row, never a dead job.
- Windows dev workstation; OneDrive-redirected Documents require
  `[Environment]::GetFolderPath('MyDocuments')`.

## Open architectural questions

- **v12 RBAC** — OIDC sign-in + config-based authz + HTTPS as one unit. Once it
  lands, app-level authorization can layer *inside* the Easy Auth gate (or
  replace it). See `RBAC-ROADMAP.md`.
- **Per-tenant app-only (certificate) Graph auth** — the robust successor to the
  device-code model for unattended/multi-tenant cloud operation. Removes the
  cold-start re-auth and the single-replica constraint.
- **Historical Search** (`Start-HistoricalSearch`) — async; needs a submit/poll
  state machine that doesn't fit the current synchronous job queue.

> Cross-link to `DECISIONS.md` as these resolve.
