# RBAC Roadmap — Multi-User Access Control (planned: v12)

## Goal

An admin of this utility configures which Entra ID users and/or directory
roles may use the tool, and which configured tenants each may report
against. This changes the tool's trust model from "single admin on
localhost" to "small multi-user service," so it must land as one coherent
major version — shipping it piecemeal would create a false sense of
security.

## What exists today (v11.2.0) as groundwork

- **Audit log** (`audit.js`) — append-only JSONL of every consequential
  action with timestamp and client IP. Once sign-in exists, entries gain
  the acting identity. Auditing before authorization is deliberate:
  accountability is the prerequisite for shared access.
- **Configured tenants** (`config.json` → `tenants[]`) — the tenant picker.
  The future `access` section maps identities to these tenant entries.
- **Server-owned report catalog** — clients cannot submit commands, only
  report IDs; per-user report allowlists become a simple filter.
- **Localhost binding** — until RBAC ships, network exposure stays off by
  default.

## Design

### Authentication
- Register an Entra app ("M365 Admin Reports") in the home tenant;
  OpenID Connect authorization-code flow (`openid profile email`), server
  session cookie (httpOnly, SameSite=Lax). No passwords stored, ever.
- The signed-in identity is *who is using the tool*; the PowerShell
  session's Graph connection remains *what the tool reports as*. These are
  distinct and both recorded in the audit log.

### Authorization model (config.json)
```json
{
  "tenants": [
    { "id": "am", "name": "AM Consulting", "tenantId": "am.consulting", "default": true }
  ],
  "access": {
    "admins": ["jim@am.consulting"],
    "rules": [
      { "principal": "jcsernik-adm@am.consulting", "type": "user",
        "tenants": ["am"], "reports": "*" },
      { "principal": "Global Reader", "type": "entraRole",
        "tenants": ["am"], "reports": ["all-users", "license-summary"] }
    ]
  }
}
```
- `admins` — may edit config through the (future) admin UI and read the
  full audit log.
- `rules` — first-match-wins; `type: user` matches UPN, `type: entraRole`
  matches the user's directory roles (read via Graph at sign-in, cached
  for the session). `reports` is `"*"` or a report-ID allowlist.
- Default deny: no matching rule → no access.

### Enforcement points (server-side, per request)
1. Session middleware on every `/api/*` route (401 without sign-in).
2. Tenant guard on `/api/connect/graph` — requested tenantId must be in
   the caller's allowed set.
3. Report guard on `/api/run` — reportId must be in the caller's allowlist.
4. Snapshot/diff guards — scoped to reports the caller can run.
5. Audit every allow *and* deny decision.

### Open questions to settle before building
- Single shared PowerShell session vs. per-user sessions (memory cost vs.
  isolation; per-tenant sessions likely needed once multiple tenants are
  used concurrently).
- Should the tool support app-only (client credential) Graph auth per
  tenant so reports don't depend on the operator's own delegated rights?
  This pairs naturally with multi-tenant and removes interactive-auth
  friction, but requires per-tenant app registrations and certificate
  management.
- TLS: multi-user means network exposure; the server must ship with HTTPS
  (self-signed bootstrap + documented cert replacement) before the bind
  default changes.

## Sequencing
1. v11.x — audit log matures (this release), tenant config in use.
2. v12.0 — OIDC sign-in + config-based authorization + HTTPS, as one unit.
3. v12.x — admin UI for editing `access` rules; per-tenant app-only auth.
