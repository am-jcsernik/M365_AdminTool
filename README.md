# M365 Admin Reports

**Version 11.12.2** — see [CHANGELOG.md](CHANGELOG.md) for version history.

Read-only Microsoft 365 admin reporting tool with a web UI. Runs PowerShell
Graph SDK commands through a persistent session and renders results as
interactive tables.

**All operations are strictly READ-ONLY.** Mutating cmdlets are rejected
server-side, and `Invoke-MgGraphRequest` is permitted with `-Method GET` only.

Documentation: [CHANGELOG.md](CHANGELOG.md) · [PERMISSIONS.md](PERMISSIONS.md)
(per-report scope matrix) · [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## Quick Start — Local

```bash
# Prerequisites: Node.js 18+, PowerShell 7+, Microsoft.Graph modules
npm install
npm start
# → http://localhost:3365
```

## Quick Start — Docker

```bash
# Build (includes PowerShell 7 + all Graph modules)
docker build -t m365-admin-reports .

# Run
docker run -p 3365:3365 m365-admin-reports

# Or with docker-compose
docker-compose up -d
```

Open `http://localhost:3365`. In Docker, **device code auth** is used
automatically since there's no browser. The UI will display a URL and code —
open the URL on any device, enter the code, and sign in.

## Deploy to Azure Container Apps

```bash
# Build and push to Azure Container Registry
az acr build --registry <your-acr> --image m365-admin-reports:latest .

# Create Container App
az containerapp create \
  --name m365-reports \
  --resource-group <your-rg> \
  --image <your-acr>.azurecr.io/m365-admin-reports:latest \
  --target-port 3365 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 1
```

---

## What's Included

| Category | Reports |
|---|---|
| **Users** | All users, user details, disabled, guests, recently created, admin roles, stale accounts, unlicensed |
| **Groups** | All groups, security, distribution lists, M365 groups, members, owners, empty, dynamic |
| **Licenses** | SKU summary, service plans |
| **Exchange** | Shared mailboxes, forwarding rules |
| **Security** | CA policies, sign-in logs, failed sign-ins |
| **Tenant** | Org info, domains, devices |

## Features

- **Tenant Health dashboard** — at-a-glance tiles (users, guests, groups,
  devices, license utilization, CA posture) with deep links to reports;
  one fast aggregated Graph query, cached 5 minutes.
- **Audit Packs** — one-click curated bundles (Security Audit, License &
  Cost Review, Tenant Hygiene) with auto-snapshot of every result and
  bulk CSV export. Exchange-only reports skip gracefully when Exchange
  isn't connected.
- **Audit log** — every connection, report run, and snapshot operation is
  appended to `./M365AuditLog/audit-YYYY-MM.jsonl` (viewer + CSV export in
  the Debug panel).
- **Tenant picker** — copy `config.json.example` to `config.json` and list
  your tenants; a dropdown appears in the connect panel. Planned RBAC on
  top of this: see `RBAC-ROADMAP.md`.
- **Snapshots & diff** — save any report's results, then compare later runs:
  added / removed / changed rows with per-field before→after detail. Stored
  in `./M365Snapshots/` (JSON, one file per snapshot).

- **Field selection** — toggle which properties each report returns
- **Entity pickers** — searchable dropdowns for users/groups
- **Light/dark mode** — toggle in the header
- **CSV export** — one-click export to `./M365Reports/`
- **Device code auth** — works in containers with no browser
- **Debug tools** — session test, diagnostic logs, module detection

## Architecture

```
Browser ──HTTP──→ Express.js ──stdin/files──→ Persistent pwsh.exe
                  (Node.js)                   ├─ Microsoft.Graph SDK
                  port 3365                   └─ ExchangeOnlineManagement
```

Commands execute in a single persistent PowerShell process, serialized
through a FIFO job queue. The Graph connection survives across all commands.
Results pass through temp files (not stdout parsing), and every report run
captures all PowerShell streams (output/error/warning/information) in a
structured JSON envelope.

The report catalog is **server-owned** (`reports.js`). The browser sends only
`{ reportId, params, fields }`; the server builds and validates the command.
After editing `reports.js`, run `npm run lint` — with PowerShell on PATH it
AST-parses every command.

## Security posture

- Binds **127.0.0.1** by default; the UI (and its authenticated PowerShell
  session) is not reachable from the network. Set `HOST=0.0.0.0` only if you
  understand the exposure; Docker mode sets it inside the container.
- Read-only blocklist on every command; report parameters are stripped of
  PowerShell metacharacters; field selections are validated against each
  report's whitelist.
- No write scopes are ever requested from Graph.

## Docker Image Contents

- Ubuntu 22.04
- Node.js 20 LTS
- PowerShell 7
- Microsoft.Graph.Authentication, Users, Groups, Identity.DirectoryManagement,
  Identity.SignIns, Reports, DeviceManagement
- ExchangeOnlineManagement
- ~1.2 GB image size

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3365` | Server port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address — localhost-only by default |
| `DOCKER_MODE` | (unset) | Set to `1` to auto-enable device code auth and bind `0.0.0.0` |

## License

MIT
