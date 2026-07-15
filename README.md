# M365 Admin Reports

**Version 12.0.0** — see [CHANGELOG.md](CHANGELOG.md) for version history.

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
- **Multi-user access control (v12)** — three-tier, default-deny RBAC: who may
  open the tool → which tenants → which reports. Managed in-app by admins (no
  JSON editing). See "Access control" below.
- **Tenant picker** — admins define tenants in the Access Control panel (or seed
  from `config.json`); each user picks from a friendly-name dropdown limited to
  the tenants their roles grant.
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
- **v12 RBAC** adds application-level authorization *inside* the ingress gate:
  Entra Easy Auth decides who reaches the app; RBAC decides which tenants and
  reports each caller may use (default-deny). See below and `PERMISSIONS.md`.

## Access control (v12 RBAC)

Three tiers, all **default-deny** (nothing is granted until an admin grants it):

1. **Who may open the tool** — membership in an Entra *access group*, or holding
   any role assignment.
2. **Which tenants** — roles scope a user/group to specific tenants (or all).
3. **Which reports** — roles grant reports by area (category) and/or by
   individual report, or all.

**Identity** comes from Azure Container Apps **Easy Auth** (`X-MS-CLIENT-PRINCIPAL*`
headers). On `localhost` (no Easy Auth, not Docker) the caller is a synthetic
full admin, so local development is unchanged.

### For admins

Sign in as a member of the Entra **admin group** (bootstrapped via
`ADMIN_GROUP_ID`). An **Access Control** panel appears at the top of the page:

- **Tenants** — friendly name, tenant id, app-registration client id, and the
  Key Vault cert reference (`kv:<secret-name>`) used for app-only connect.
- **Roles** — a named, reusable grant: a tenant scope (all or a set) and a report
  scope (all, whole areas, and/or individual reports).
- **Assignments** — map a user (UPN) or an Entra group (object id) to roles.
  Effective access is the union of all roles from the user's UPN and their groups.
- **Bootstrap Groups** — the access-group and admin-group object ids.

Every change is written to `DATA_DIR/access/rbac.json` and audited. The store
holds only non-secret metadata (ids and a `kv:` cert reference) — never key
material. First-time setup can also be scripted with
`deploy/Provision-RbacPhase0.ps1`.

> **Deploy-time lockout warning:** once enforcement is live, the bootstrap group
> ids and at least one admin/assignment must exist first, or every operator is
> refused (403). Set `ACCESS_GROUP_ID`/`ADMIN_GROUP_ID` and seed the store before
> exposing the app.

### For end users

1. Open the app URL and sign in at the Microsoft prompt (Easy Auth).
2. If you have access, pick your **tenant** from the dropdown and connect.
3. You will see only the reports your roles allow. If you see nothing or get
   "Not authorized", ask an admin to grant you a role. Access is read-only.

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
| `DATA_DIR` | working dir | Durable state root (RBAC store, audit log, snapshots, exports) — mount a volume in the container |
| `ACCESS_GROUP_ID` | (unset) | Entra *access group* object id (v12 RBAC); seeded into the store on first run |
| `ADMIN_GROUP_ID` | (unset) | Entra *admin group* object id (v12 RBAC); members get the in-tool admin role |
| `KEY_VAULT_NAME` | (unset) | Key Vault holding per-tenant certs; when set, app-only certificate connect is preferred over device code |

## License

MIT
