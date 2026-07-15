# Implementation Plan — v12.0.0 Multi-User RBAC

> Executable blueprint for the design in `RBAC-ROADMAP.md` (ADR-0006). Concrete
> file-level changes, phase by phase. Ships as one major version — no partial
> enforcement in `main` (a half-wired gate is worse than none). Build on a
> `feature/v12-rbac` branch; local-first, then ACA.

## Guiding invariants

- **Default deny.** Every `/api/*` route is guarded; unknown/unmatched → 403.
- **Read-only stays read-only.** RBAC narrows access; it never grants new cmdlets.
  The `isSafe` guard and server-owned catalog are unchanged.
- **Two identities, always.** Acting user (Easy Auth) ≠ connection identity
  (per-tenant app SP). Both audited.
- **Local dev unchanged.** No Easy Auth header + not `DOCKER_MODE` → synthetic
  local admin, single implicit tenant, so `127.0.0.1:3365` still "just works".
- **Secrets only in Key Vault.** The `DATA_DIR` authZ store holds no cert/secret
  material — only tenantId, client ID, and a KV secret *reference*.

## New / changed files

| File | Change |
|---|---|
| `auth.js` *(new)* | Parse Easy Auth headers → `req.user` ({upn, oid, groups[]}); local-dev fallback. Express middleware. |
| `rbac.js` *(new)* | Load/save the authZ store; role model; `can(user, {tenant?, reportId?})` evaluator; admin check. |
| `tenants.js` *(new)* | Tenant registry (friendly name ↔ tenantId/clientId/KV ref); app-only connect command builder; per-tenant connection pool. |
| `keyvault.js` *(new)* | Fetch a cert from Key Vault via ACA managed identity (`@azure/identity` + `@azure/keyvault-secrets` / `-certificates`). |
| `server.js` | Wire middleware; add guards to existing routes; filter `/api/reports` + `/api/config`; add admin routes; repoint audit identity; replace connect routes' auth with per-tenant app-only. |
| `audit.js` | `setIdentityProvider` fed the acting user; add connection identity to detail. |
| `reports.js` | Add a small `reportAreaIndex` helper (reportId → category) for the report guard. |
| `public/index.html` | Tenant dropdown by friendly name; admin UI (tenants/roles/assignments/audit); hide reports the caller can't run. |
| `deploy/main.bicep` | Add Key Vault, managed identity + role assignment (KV secret get), env wiring; raise `maxReplicas`. |
| `docs/ARCHITECTURE.md`, `PERMISSIONS.md`, `README.md` | Update for the new identity/authZ/connection model + application (vs delegated) scopes. |

## AuthZ store schema (`DATA_DIR/access/rbac.json`)

```json
{
  "version": 1,
  "accessGroupId": "<entra-group-oid>",
  "adminGroupId": "<entra-group-oid>",
  "tenants": [
    { "id": "am", "name": "AM Consulting", "tenantId": "am.consulting",
      "clientId": "<app-reg-client-id>", "certSecret": "kv:am-report-cert" }
  ],
  "roles": [
    { "id": "am-readonly", "name": "AM Read-Only",
      "tenants": ["am"],
      "reports": { "areas": ["User Reports", "Licenses"], "ids": ["all-users"] } }
  ],
  "assignments": [
    { "principalType": "user",  "principal": "jim@am.consulting", "roles": ["am-readonly"] },
    { "principalType": "group", "principal": "<entra-group-oid>",  "roles": ["am-readonly"] }
  ]
}
```
- `tenants[].id` / `roles[].id` are stable slugs. `reports.areas` matches
  `reports.js` category names; `reports.ids` matches report IDs; `"*"` = all.
- Effective access = union of roles from the user's UPN + every group they're in.

## Phases

### Phase 0 — Infra prereqs (Azure, scripted under `deploy/`)
- Create **Key Vault**; grant the Container App's **managed identity** `get` on
  secrets/certificates.
- Create the Entra **access group** and **admin group**; capture their object IDs.
- For the first tenant: an Entra **app registration** with the required
  **application** permissions (User.Read.All, Group.Read.All, Directory.Read.All,
  Organization.Read.All, AuditLog.Read.All, Reports.Read.All, Policy.Read.All,
  RoleManagement.Read.All, Sites.Read.All, DeviceManagement*.Read.All, plus
  Exchange.ManageAsApp for EXO) + **admin consent**; generate a cert, upload to
  Key Vault, record the client ID + KV reference.
- **Exit:** managed identity can read the cert; app reg consented.

### Phase 1 — AuthN plumbing (`auth.js`, `audit.js`)
- `auth.js`: decode `X-MS-CLIENT-PRINCIPAL` (base64 JSON) + `-NAME`/`-ID` headers
  → `req.user = { upn, oid, groups, isAdmin }`; local-dev fallback identity.
- Middleware sets `req.user` before any route; **no enforcement yet** (log-only).
- Repoint `audit.js` identity provider to `() => req.user?.upn` (thread `req`);
  add connection identity to action detail.
- **Exit:** audit log shows the real acting user locally and in-container.

### Phase 2 — AuthZ store + engine (`rbac.js`)
- Load/validate/save `rbac.json` under `DATA_DIR/access/`; seed `tenants` from
  `config.json` on first run.
- `can(user, { tenant, reportId })`: default-deny; resolve roles via UPN + groups;
  check tenant membership and area/report allowlist. `isAdmin(user)` via admin group.
- Unit tests (default-deny, group union, area-vs-id, admin bypass).
- **Exit:** engine green in tests; still not wired to routes.

### Phase 3 — Enforcement (`server.js`)
- `requireAuth` (401 no identity) + `requireAccess` (403 not in access group) on
  all `/api/*`.
- **Tenant guard:** `/api/connect/graph`, `/api/connect/exchange` — requested
  tenant ∈ caller's allowed set.
- **Report guard:** `/api/run`, `/api/pack/run` — reportId (+ its area) allowed.
- **Catalog filter:** `/api/reports` and `/api/config` return only the caller's
  tenants/reports.
- **Scoped:** `/api/snapshots*`, `/api/diff`, `/api/export` to runnable reports.
- **Admin-only:** management routes + full `/api/audit`.
- Audit every allow **and** deny.
- **Exit:** a non-admin sees only granted tenants/reports; denies are 403 +
  audited; localhost fallback still full-access.

### Phase 4 — Connection rework (`tenants.js`, `keyvault.js`)
- Replace device-code connect with app-only cert connect per tenant:
  `Connect-MgGraph -TenantId -ClientId -Certificate`,
  `Connect-ExchangeOnline -AppId -Certificate -Organization`.
- **Per-tenant connection pool** keyed by tenant slug (retire the single global
  `connectionInfo`); device-code kept behind the local-dev fallback only.
- Fetch certs from Key Vault via managed identity at connect time.
- Raise `maxReplicas` once concurrent tenants validate.
- **Exit:** two users hit two tenants concurrently, unattended, no device code;
  cold start needs no re-auth.

### Phase 5 — Admin UI (`public/index.html`)
- Tenant dropdown by **friendly name** (from filtered `/api/config`).
- Admin panels: tenants (name/clientId/KV ref), roles (tenants + areas/reports),
  assignments (user/group → roles), audit viewer. Admin-gated in UI *and* server.
- **Exit:** an admin manages the whole model without editing JSON by hand.

### Phase 6 — Docs, tests, release
- Update `ARCHITECTURE.md`, `PERMISSIONS.md` (application vs delegated scopes),
  `README.md`; add admin + end-user docs.
- Integration test the guard matrix; lint; **bump to v12.0.0** with a
  `CHANGELOG` entry; deploy per `deploy/Deploy-ToAca.ps1`.

## Risks / watch-items
- **App-only ≠ user impersonation** — access is the app's granted permissions;
  narrow with Graph RBAC-for-Apps / EXO Application Access Policy if per-user
  least-privilege is required.
- **`X-MS-CLIENT-PRINCIPAL` spoofing** — trust these headers **only** behind Easy
  Auth (ACA strips client-supplied copies). Never trust them on the local bind;
  the fallback path must not read them.
- **Group claim size** — Entra emits `hasgroups`/overage when a user is in many
  groups; may require a Graph `memberOf` lookup at sign-in. Handle the overage.
- **Store contention** — serialize `rbac.json` writes (single-writer or file
  lock) so concurrent admin edits don't clobber.
- **Cert rotation** — reference KV by name (latest version) or add a re-fetch
  path so rotation doesn't require redeploy.
