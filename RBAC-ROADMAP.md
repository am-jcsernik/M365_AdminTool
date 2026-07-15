# RBAC Roadmap — Multi-User Access Control (planned: v12)

> **Status:** design settled 2026-07-14 (session 3). This supersedes the original
> config-file sketch. The three access tiers, identity source, connection model,
> and storage decisions below are locked; see `docs/DECISIONS.md` (v12 ADR) for
> the record. Implementation sequencing is at the end.

## Goal

Turn the tool's trust model from "single admin on localhost" into a "small
multi-user service" with **three tiers of access control**, all administered from
within the tool's own UI:

1. **Overall access** — who may open the tool at all.
2. **Tenant scope** — which configured tenants each user may report against.
3. **Report scope** — which areas (categories) and/or individual reports each
   user may run.

Because this changes the trust model, it lands as one coherent major version
(**v12.0.0**) — shipping it piecemeal would create a false sense of security.

## Decisions (session 3)

| Decision | Choice |
|---|---|
| Identity source (authN) | **Reuse Easy Auth** — read the identity ACA already validates from `X-MS-CLIENT-PRINCIPAL-*` headers. No in-app OIDC. |
| Overall-access gate | Membership in a designated **Entra security group**. |
| Inner authorization | **In-tool RBAC** with **named, reusable roles**; a role bundles `{tenants, areas/reports}` and is assigned to users. Admin-managed in the UI. |
| First-admin bootstrap | A designated **Entra admin group** auto-grants the in-tool admin role. |
| Tenant definition | Admin defines tenants **in the UI** (friendly name → tenantId + app registration + certificate); users pick from a **friendly-name dropdown**. Who sees which tenant is part of the role assignment. |
| Connection model | **App-only certificate per tenant** — unattended, concurrent, no cold-start re-auth. Retires the shared device-code session (kept only as a local-dev fallback). |
| Certificate storage | **Azure Key Vault**; ACA reads via **managed identity**. Secrets never on disk or in the UI store. |
| Report granularity | **Area + report level** — allow by category (e.g. all Exchange) or by specific report IDs. |

## Two identities, always distinct

- **Acting user** — the signed-in operator (from Easy Auth). Determines *what
  they are allowed to do*. This is now the audit identity.
- **Connection identity** — the per-tenant app service principal (app-only cert).
  Determines *what the tool reports as* against Graph/EXO.

Both are recorded on every audited action. Today `audit.js`'s identity provider
returns `connectionInfo.account`; under v12 it returns the **acting user**, and
the connection identity is carried in the action detail.

## Architecture

### Authentication (outer gate)
- Easy Auth (already live at the ACA edge) authenticates every request and passes
  the validated identity in `X-MS-CLIENT-PRINCIPAL-ID` / `-NAME` headers plus a
  base64 `X-MS-CLIENT-PRINCIPAL` claims blob (includes group claims).
- **General-access gate:** caller must be a member of the configured Entra
  *access* group. Enforced either by scoping Easy Auth to the group, or by the
  app validating the group claim (belt-and-suspenders). Non-members → 403.
- **Local-dev fallback:** when `DOCKER_MODE` is unset and no Easy Auth header is
  present, the server injects a synthetic local admin identity so localhost
  development is unchanged.

### Authorization (inner, in-tool RBAC)
A default-deny engine evaluated server-side on every request:

- **Roles** — named, reusable: `{ id, name, tenants: [tenantId…] | "*",
  reports: { areas: [category…] | "*", ids: [reportId…] } }`.
- **Assignments** — map an Entra user (UPN) *or* Entra group to one or more roles.
  Group assignments let access follow directory membership.
- **Admins** — members of the Entra admin group get the built-in admin role:
  manage tenants/roles/assignments and read the full audit log.
- **Effective access** — union of all roles the caller holds (via UPN + group
  membership). No matching role → no access.

### Authorization store
- A **writable JSON store on `DATA_DIR`** (the Azure Files mount) — e.g.
  `DATA_DIR/access/rbac.json` — holding `tenants[]`, `roles[]`, `assignments[]`,
  and the admin-group reference. UI-managed; survives restarts alongside other
  durable state.
- **No secrets in this store.** Tenant entries hold only non-secret metadata
  (friendly name, tenantId, app/client ID, **Key Vault secret reference** for the
  cert). The certificate itself lives only in Key Vault.
- The static `config.json` `tenants[]` remains a seed/import source; the live
  authZ state is the JSON store.

### Connection model (app-only cert per tenant)
- Each tenant has an Entra **app registration** with the needed **application**
  permissions (admin-consented) and a certificate in **Key Vault**.
- ACA uses a **managed identity** with `get` on the Key Vault secret to load the
  cert at connect time.
- Graph: `Connect-MgGraph -TenantId … -ClientId … -Certificate …`.
  Exchange: `Connect-ExchangeOnline -AppId … -Certificate… -Organization …`.
- **Per-tenant connections are pooled**, not one shared in-memory session — this
  is what enables concurrent multi-user/multi-tenant and removes the
  `maxReplicas 1` cap and the cold-start device-code re-auth from ADR-0003/0005.
- **Report scope note:** app-only auth does not "log in as" a user; it acts as the
  app and *targets* a specified user/mailbox per operation. Access is bounded by
  the app's granted application permissions, optionally narrowed with Graph
  **RBAC for Applications** / Exchange **Application Access Policy**.

### Enforcement points (real routes in `server.js`)
1. **Auth + group middleware** on all `/api/*` — resolve acting user from Easy
   Auth; 401 if unauthenticated, 403 if not in the access group.
2. **Tenant guard** on `/api/connect/graph` and `/api/connect/exchange` — the
   requested tenant must be in the caller's allowed set.
3. **Report guard** on `/api/run` and `/api/pack/run` — the reportId (and its
   area) must be in the caller's allowlist.
4. **Catalog filtering** — `/api/reports` and `/api/config` (tenant list) return
   only what the caller may see, so the UI shows just their tenants/reports.
5. **Snapshot / diff / export guards** — `/api/snapshots*`, `/api/diff`,
   `/api/export` scoped to reports the caller can run.
6. **Admin-only routes** — tenant/role/assignment management + full `/api/audit`.
7. **Audit every allow *and* deny** with the acting user + connection identity.

### HTTPS
TLS already terminates at the ACA edge (`allowInsecure=false`), so the original
"ship self-signed HTTPS" concern is satisfied in the deployed shape. It remains a
consideration only for any off-ACA/direct-exposure deployment.

## Implementation sequencing (v12.0.0)

- **Phase 0 — Infra prereqs.** Key Vault + ACA managed identity with secret `get`;
  the Entra *access* group and *admin* group; per-tenant app registrations
  (application permissions + admin consent + cert uploaded to Key Vault).
- **Phase 1 — AuthN plumbing.** Parse Easy Auth headers → `req.user`; group gate;
  repoint `audit.js` identity to the acting user; local-dev fallback identity.
- **Phase 2 — AuthZ store + engine.** The `DATA_DIR/access/rbac.json` store; role
  model + assignments; default-deny evaluation with tenant + area/report filters.
- **Phase 3 — Enforcement.** Middleware + per-route guards; filter `/api/reports`
  and `/api/config` by caller.
- **Phase 4 — Connection rework.** App-only cert connect per tenant from Key
  Vault; pooled per-tenant connections; retire the shared device-code session
  (keep as local fallback); lift `maxReplicas` once validated.
- **Phase 5 — Admin UI.** Tenant management (friendly name, app/client ID, cert
  reference), role definitions, user/group assignments, audit viewer.
- **Phase 6 — Docs, tests, release.** Update `ARCHITECTURE.md`, `PERMISSIONS.md`
  (application vs delegated scopes), end-user + admin docs; bump to **v12.0.0**
  with `CHANGELOG` entry; deploy.

## What exists today as groundwork

- **Audit log** (`audit.js`) — append-only JSONL with an identity-provider hook,
  ready to carry the acting identity.
- **Server-owned report catalog** — clients submit report IDs, never commands, so
  per-role area/report allowlists are a simple server-side filter.
- **Configured tenants** (`config.json` → `tenants[]`) — seed for the tenant list.
- **Easy Auth** — the outer identity gate is already deployed (ADR-0003).
