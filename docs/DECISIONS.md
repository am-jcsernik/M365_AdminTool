# Decision Log

Append-only. Newest entries at the top. ADR-style: each decision dated, with
context, the decision itself, and consequences/trade-offs.

---

## 2026-07-15 -- ADR-0008: v12.0.0 shipped and deployed; two Entra lockout prerequisites resolved at deploy
**Context:** Phases 5 (admin UI + `/api/admin/*` CRUD) and 6 (guard-matrix
integration tests, docs, version bump, deploy) completed v12. Deploying turns
RBAC enforcement ON for the live app, and in-container **admin is group/env-only**
(no admin-via-assignment path), so admin resolves solely from the Easy Auth
`groups` claim. Pre-deploy checks found this would have been a self-inflicted
outage: (1) both Entra access/admin groups were empty; (2) the Easy Auth app
registration had `groupMembershipClaims = null`, so the forwarded token carried
NO groups — every caller would be 403'd with no way to reach the admin UI to fix
it; (3) the Bicep/`Deploy-ToAca.ps1` never wired `ACCESS_GROUP_ID`/`ADMIN_GROUP_ID`
into the container env.
**Decision:**
- **Wire the bootstrap group ids** through `deploy/main.bicep` (new params) and
  `Deploy-ToAca.ps1`; `deployKeyVault` gates vault *creation* only, so
  `-KeyVaultName` alone reuses the Phase-0 vault (`deployKeyVault=false`).
- **Enable group claims** on the Easy Auth app reg (`edb8be95…`):
  `groupMembershipClaims = SecurityGroup`.
- **Bootstrap a single admin:** add `jcsernik-adm@am.consulting` to the admin
  group `bb661e80…` (chosen by the operator). The access group stays empty for now.
- **Deploy from the `feature/v12-rbac` working tree** (not yet merged to `main`);
  a PR/merge is a follow-up.
- **Integration tests are Node's built-in runner** (`test/`, `npm test`): they
  boot the real server and forge Easy Auth headers to drive the full guard
  matrix offline (no Graph/PowerShell), including the DOCKER_MODE 401 path.
**Consequences:** v12.0.0 is live (rev `--0000001`, image digest `fb366906…`,
restarted for the rotated Easy Auth secret); `/api/health` correctly 302s to the
home-tenant login. End-to-end admin is unproven until `jcsernik-adm` signs in and
sees the Access Control panel — the group-claim → `req.user.groups` → `isAdmin`
chain can only be confirmed interactively. App-only `Connect-MgGraph -Certificate`
also gets its first live exercise post-deploy. Recovery if admin doesn't resolve:
edit `access/rbac.json` on the Azure Files share, or re-check group membership +
the token `groups` claim. Two bugs were caught and fixed during the phase: an
`__audit` marker leaking into the persisted store, and the missing group-id env
wiring above.

## 2026-07-14 -- ADR-0007: v12 implementation choices (branch, dependency-free Key Vault, Phase 4 split, local-dev admin)
**Context:** Implementing v12 (Phases 0-4a this session) surfaced four practical
decisions not fixed by the ADR-0006 design.
**Decision:**
- **Branch strategy:** v12 application code lives on `feature/v12-rbac`; only
  Phase 0 infra tooling + design docs went to `main`. Enforcement (Phase 3+)
  stays off `main` until v12 ships as one PR.
- **Dependency-free Key Vault access:** fetch per-tenant certs via the Container
  App managed identity (`IDENTITY_ENDPOINT`/`IDENTITY_HEADER`, IMDS fallback) +
  the Key Vault REST API using Node's built-in `fetch` — no `@azure/*` SDKs. Keeps
  `package-lock.json` and the image unchanged. The cert's private key is staged to
  a 0600 temp file at connect time (the runtime signer needs it); "key stays in
  KV" applies to provisioning, not the runtime.
- **Phase 4 split:** ship 4a (app-only cert connect on the existing single
  session, additive/guarded, device-code retained as fallback) now; defer 4b (the
  concurrent per-tenant connection pool + `maxReplicas` lift) because it is a
  large refactor that cannot be validated without live multi-tenant traffic.
- **Local-dev is a full admin** (`auth.js`): with no Easy Auth header and not
  `DOCKER_MODE`, synthesize an admin identity so enforcement never locks out
  localhost development. Easy Auth headers are trusted only when present.
**Consequences:** Leaner image, no SDK supply-chain surface. App-only auth's live
path (`Connect-MgGraph -Certificate`) is unverifiable on the workstation, so it
gets its first real exercise at deploy. Discovered and fixed a latent deploy bug:
the Dockerfile `COPY` omitted `auth.js`/`rbac.js`, which would have crash-looped
the v12 image on boot. Enabling enforcement in the container requires the group
ids (env) + a populated store first, or operators are 403'd (see STATE.md).

## 2026-07-14 -- ADR-0006: v12 multi-user RBAC — Easy Auth identity + in-tool roles + app-only cert per tenant
**Context:** The tool must move from "single admin on localhost" to a small
multi-user service with three access tiers: who may open the tool, which tenants
each user may reach, and which areas/reports each may run (session 3 requirement).
Easy Auth already gates *who reaches* the tool (ADR-0003) but provides no
per-user authorization; the single in-memory device-code `pwsh` session (capped
at `maxReplicas 1`, ADR-0003/0005) cannot serve concurrent users across multiple
tenants; and the report catalog is server-owned, so a per-role allowlist is a
simple filter. The original `RBAC-ROADMAP.md` predated the Easy Auth deploy and
assumed an in-app OIDC flow.
**Decision:**
- **AuthN:** reuse **Easy Auth** — resolve the acting user from the
  `X-MS-CLIENT-PRINCIPAL-*` headers; do **not** build a second in-app OIDC flow.
- **Overall-access gate:** membership in a designated **Entra security group**.
- **Inner authZ:** an in-tool RBAC engine with **named, reusable roles**
  (`{tenants, areas/reports}`) assigned to users or Entra groups; **default-deny**.
- **First-admin bootstrap:** a designated **Entra admin group** auto-grants the
  in-tool admin role.
- **Tenants:** admin-defined in the UI (friendly name → tenantId + app
  registration + Key Vault cert reference); users pick from a friendly-name
  dropdown; visibility is part of the role assignment.
- **Connection:** **app-only certificate auth per tenant** (pooled per-tenant
  connections), retiring the shared device-code session (kept only as a local-dev
  fallback). Certs live in **Azure Key Vault**, read by ACA via **managed
  identity** — never on disk or in the UI store.
- **AuthZ store:** a writable JSON store on the `DATA_DIR` Azure Files mount
  (non-secret metadata only); `config.json` `tenants[]` becomes a seed source.
- **Report scope:** granular at **area (category) and report-ID** level.
- Ships as one coherent major version, **v12.0.0**.
**Consequences:** Two identities are now recorded on every action — the acting
user (Easy Auth) and the connection identity (per-tenant app SP); `audit.js`'s
identity provider moves off `connectionInfo.account` to the acting user. App-only
auth does not impersonate a user — it acts as the app and targets a named
user/mailbox, bounded by granted application permissions (optionally narrowed via
Graph RBAC-for-Apps / Exchange Application Access Policy). Retiring the shared
session lifts the `maxReplicas 1` cap and removes cold-start re-auth. New infra
required: Key Vault, an ACA managed identity, and per-tenant app registrations
with admin-consented application permissions. Enforcement adds middleware + guards
on the existing routes (`/api/connect/*`, `/api/run`, `/api/pack/run`,
snapshots/diff/export, `/api/reports`, `/api/config`, `/api/audit`). Full design
and phasing in `RBAC-ROADMAP.md`; build steps in `docs/PLAN-v12-rbac.md`.

## 2026-07-14 -- ADR-0005: First live ACA deploy landed in eastus2, deploy script hardened
**Context:** Executing the first real `deploy/Deploy-ToAca.ps1` run surfaced four
issues in sequence. (1) `az acr build` crashed the *local* CLI with a
`UnicodeEncodeError` (colorama writing a `→` from build logs to a Windows cp1252
console) — but the *server-side* build succeeded every time. (2) eastus could not
provision the Container Apps managed environment (`AKSCapacityHeavyUsage`). (3) The
data-plane `az acr repository show-tags` read failed from this workstation
(`CONNECTIVITY_CHALLENGE_ERROR`) after registry delete/recreate churn. (4) An
initial resilience check I added wrongly gated a clean exit-0 build on that same
data-plane read.
**Decision:** Deploy the whole co-located stack in **eastus2** (ACR + storage +
env together; the Bicep pins all resources to `resourceGroup().location`, so a
region move means moving everything, and reusing the globally-unique ACR/storage
names required deleting the eastus RG first). Harden the script: build with
`--no-logs`; treat `exit 0` as success without a follow-up tag read; add
`-SkipBuild`; make the `-SkipBuild` tag check tolerant of data-plane read failures
(ACA pulls via ACR admin creds, so that read is not on the critical path).
**Consequences:** App v11.12.2 is live and verified in eastus2 (Easy Auth gate +
in-app device-code connect confirmed). The deploy script is now robust to the
Windows log-stream bug and to regional capacity/registry-churn quirks. Open: the
local `*.azurecr.io` data-plane read failure is unresolved (cosmetic for deploys,
but affects any local ACR content query); `PYTHONUTF8`/`PYTHONIOENCODING` do NOT
fix the frozen-az Unicode crash, hence `--no-logs`.

## 2026-07-14 -- ADR-0004: Raw passthrough execution for device-code auth
**Context:** In a headless container, `Connect-MgGraph`/`Connect-ExchangeOnline`
device-code sign-in never surfaced the code (UI or logs), so auth timed out. The
Graph SDK emits the prompt on the PowerShell Success stream, which the command
wrapper captured (`$__r = & { ... }`) and the connect line discarded (`| Out-Null`);
the interactive session (no `-NonInteractive`) also polluted output via PSReadLine.
**Decision:** Spawn the persistent session with `-NonInteractive`; add a "raw"
execution mode (`runInSession(..., {raw:true})`) that runs a command at statement
level (no capture, no `Out-Null`) so host/Success output streams live; capture the
device-code prompt server-side and expose it on `GET /api/job/:id` for the UI.
Exchange uses `-Device` (probed) in `DOCKER_MODE`.
**Consequences:** Device-code works in-container/ACA with an in-UI prompt. Raw mode
bypasses the structured-envelope diagnostics, so it is used ONLY for connect (a
narrow, well-understood command), not for report execution.

## 2026-07-14 -- ADR-0003: Azure Container Apps deployment shape
**Context:** The app must be deployable to ACA, but it has no application-level
authZ yet (RBAC is v12), speaks plain HTTP, and its auth session is a single
in-memory `pwsh` process.
**Decision:** Ship as one long-running Container App. Gate the public ingress with
Entra **Easy Auth** (home-tenant only) — the access control that makes exposure
acceptable before v12 RBAC. TLS terminates at the ACA edge. Persist all durable
state under a configurable `DATA_DIR` backed by an Azure Files mount. Scale
**min 0 / max 1** (scale-to-zero for cost; single replica because the session is
in-memory). Graph/EXO auth is **device-code** for the first cut.
**Consequences:** Cheap when idle; operators re-run device-code sign-in after each
cold start (documented trade-off). Multi-tenant reach preserved: Easy Auth gates
*who* uses the tool; the in-app connect targets *whichever tenant* the operator
signs into. Per-tenant app-only cert auth is the planned successor.

## 2026-07-14 -- ADR-0002: Promote the app source as the tracked baseline
**Context:** The current app (v11.11.0, running and tenant-connected) existed only
as an untracked working copy under `C:\Temp\Claude Testing`. This git repo held
just the scaffold plus a stale v11.9.0 handoff tarball.
**Decision:** Copy the live v11.11.0 source into this repo (excluding
`node_modules`, runtime dirs, `config.json`) and commit it as the real baseline, so
the git repo is the single source of truth. Runtime state + the tenant list stay
gitignored.
**Consequences:** Version-controlled history going forward. The native instance on
3365 was left running from its original location (promotion only, no relaunch), so
the repo and that process are byte-identical but not yet the same runtime home.

## 2026-07-14 -- ADR-0001: Adopt file-based session continuity
**Context:** Sessions are kept short and numerous; chat history is not a reliable
carrier of project state across sessions.
**Decision:** State is carried in `docs/STATE.md` (volatile), `docs/DECISIONS.md`
(this file), and git history. `CLAUDE.md` holds only stable rules. Sessions
bookend with `/resume` and `/wrap`.
**Consequences:** Continuity is portable across Claude Code CLI, Nimbalyst, and
cloud routines. Cost: discipline -- a session that skips `/wrap` leaves the next
one blind.
