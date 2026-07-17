# Decision Log

Append-only. Newest entries at the top. ADR-style: each decision dated, with
context, the decision itself, and consequences/trade-offs.

---

## 2026-07-17 -- ADR-0014: ADR-0011 phase 3 implemented — message-trace over adminapi; ADR-0011 complete (v12.1.7)
**Context:** ADR-0011 assumed `message-trace` / `message-trace-detail` needed a
*separate* reporting API (`reports.office365.com` / Graph reports), deferred as a
meatier lift. Meanwhile the two reports still called `Get-MessageTrace(V2)` /
`Get-MessageTraceDetail(V2)` as **module** cmdlets via `Get-Command`, but the
app-only connect no longer imports `ExchangeOnlineManagement` — so they died with
"The term 'Get-MessageTrace' is not recognized."
**Decision (probed in-container before touching report code):**
- **Ran a read-only transport probe** (`deploy/probe-messagetrace.ps1`): both
  `Get-MessageTraceV2` and `Get-MessageTraceDetailV2` run fine over the **same
  `adminapi InvokeCommand` surface** as every other EXO cmdlet. The
  "separate reporting API" assumption was wrong — no second endpoint needed.
- **Rewrote both reports onto `Invoke-ExoRest`** (`reports.js`): dates passed as ISO
  strings, `ResultSize` capped at 5000; `message-trace-detail` chains off a row's
  `MessageTraceId` + `RecipientAddress`. Validated end-to-end in the live container
  (`deploy/validate-messagetrace.ps1`) against real AM mail flow.
- **Dropped the legacy V1 `Get-MessageTrace` fallback** — over `adminapi` it now
  hard-errors server-side (deprecating since 2025-09-01; use V2).
- **Added a `requireAny` report gate** (report schema + `public/index.html`): a report
  can set `requireAny:true` to block Run until at least one optional parameter has a
  value. Applied to Message Trace so an all-optional report can't be run wide open;
  Run stays disabled with a hint until a filter is set. (`message-trace-detail` was
  already gated by its required `MessageTraceId`.)
**Consequences:** **ADR-0011 is complete — every Exchange report now runs app-only
over `adminapi`, the `ExchangeOnlineManagement` module is fully out of the path.**
Ships as **v12.1.7**. Perf note still carried: `all-forwarding-rules` and
`mailbox-sizes` are per-mailbox serial REST loops (candidate to batch). The
authenticated Easy-Auth click-through remains a manual confirm; in-container logic is
proven for all reports.

## 2026-07-17 -- ADR-0013: ADR-0011 phase 2 implemented — the last module-based Exchange reports moved to adminapi (v12.1.6)
**Context:** Phase 1 (ADR-0012) proved `Invoke-ExoRest` as a general EXO transport
and migrated the four mailbox reports. Four reports still called the broken
`ExchangeOnlineManagement` module cmdlets (`Get-EXOMailbox`,
`Get-EXOMailboxPermission`, `Get-EXORecipientPermission`, `Get-InboxRule`,
`Get-DistributionGroup*`): `dl-members`, `user-inbox-rules`, `all-forwarding-rules`,
`mailbox-permissions`. The transport was proven, but the REST field shapes for
these cmdlets were unverified.
**Decision (shapes probed in-container before touching report code):**
- **Ran a read-only field-shape inspection** (`deploy/inspect-exo-phase2-fields.ps1`)
  over `InvokeCommand` for each cmdlet against real AM data, then wrote the report
  bodies to the observed serialization rather than the module's typed objects:
  - `Get-DistributionGroup` returns `Guid`/`PrimarySmtpAddress`/`Identity` as plain
    **strings** — resolve members from the string `Guid`; dropped `.ToString()`.
  - `Get-InboxRule` `ForwardTo`/`RedirectTo`/`ForwardAsAttachmentTo` are a string
    collection whose entries are `"Display Name" [EX:/o=…/cn=…]`; extract the quoted
    display name for output. Empty → `null` (join tolerates it).
  - `Get-MailboxPermission` `Deny` is the **string** `"False"`/`"True"`, not a bool →
    exclude Deny ACEs with `Deny -ne 'True'`. `AccessRights` is a string collection.
- **Migrated all four reports onto `Invoke-ExoRest`**; hardened `all-forwarding-rules`
  with a per-mailbox `try/catch` so one unreadable mailbox can't abort the tenant scan.
- **Validated end-to-end in the live container** (`deploy/validate-exo-phase2.ps1`)
  against real data (55 DLs, 107 mailboxes) before shipping **v12.1.6**.
**Consequences:** Every Exchange report except message-trace now runs app-only over
`adminapi`, module fully out of the path. **Phase 3 remains:** `message-trace` /
`message-trace-detail` use `Get-MessageTraceV2`, which is the reporting API, not
adminapi — its own reverse-engineering effort. Perf note carried forward:
`all-forwarding-rules` and `mailbox-sizes` are per-mailbox serial REST loops (slow at
107; candidate to batch/parallelize).

## 2026-07-16 -- ADR-0012: ADR-0011 phase 1 implemented — adminapi InvokeCommand as the general EXO transport (v12.1.5)
**Context:** Executing ADR-0011. ADR-0011 proved a raw entity GET
(`adminapi/beta/{tid}/Mailbox`) returns 200 with an app-only token, but that path
only covers simple entity sets — MailboxStatistics, InboxRule, DistributionGroupMember
etc. are not entity GETs. Needed one transport that covers every read cmdlet.
**Decision (proven in-container before writing any report code):**
- **Transport = `POST adminapi/beta/{tid}/InvokeCommand`** with body
  `{CmdletInput:{CmdletName, Parameters}}`. A probe confirmed it returns the same
  `value[]` shape as the module and needs **no `X-AnchorMailbox` header** (bare works);
  paging is via `@odata.nextLink` (GET continuations). This lets any EXO cmdlet run
  over our own token with the module fully out of the path.
- **Token** minted in-session by client-assertion (RS256 over the KV cert,
  `scope=https://outlook.office365.com/.default`), cached on `$global:ExoRest` and
  re-minted ~2 min before expiry. Helpers `Get-ExoRestToken` + `Invoke-ExoRest` are
  defined **session-global at connect** (raw-mode dot-source persists them), so
  reports built by `reports.js` just call `Invoke-ExoRest -Cmdlet <X> -Parameters @{}`.
- **REST field-shape adjustments** (probed, not guessed): over REST `TotalItemSize`
  is a display string `"1.4 GB (n bytes)"` (not the module's typed `ByteQuantified`),
  so `mailbox-sizes` parses the parenthetical byte count for its sort; date/quota
  fields come back as strings, so `.ToString()` calls were dropped.
- **Phasing honored:** shipped phase 1 (the 4 mailbox reports) only; validated all
  four end-to-end in the live container against 107 mailboxes, then deployed **v12.1.5**
  (rev `--0000009`). Phases 2 (dl-members, inbox-rules, permissions, all-forwarding)
  and 3 (message-trace — a separate reporting API, not adminapi) deferred.
**Consequences:** App-only Exchange reporting works without the module — a stateless
token + HTTPS call, consistent with the containerized model. `isSafe`'s block on
`Invoke-RestMethod`/`Invoke-Command` is not tripped: report commands call only the
`Invoke-ExoRest` helper; the raw REST lives in the connect script, which does not pass
through `isSafe`. Cost/limitation: `mailbox-sizes` is O(mailboxes) sequential REST
calls (slow at scale, within the 5-min job timeout for now). The authenticated HTTP
click-through (connect + run via the Easy Auth UI) is still owed as a manual confirm;
only the in-container logic is proven. Probes/validators kept under `deploy/`.

## 2026-07-16 -- ADR-0011: App-only Exchange blocked by a broken EXO module in the container — bypass it with direct REST calls
**Context:** Completing app-only Exchange (the remaining v12 follow-up). Shipped
v12.1.4 first: a per-tenant `orgDomain` field so `Connect-ExchangeOnline
-Organization` gets a domain (`am.consulting`) instead of the tenant GUID fallback
(which fails), plus a hardened `deploy/Grant-ExoAppOnlyRole.ps1` (assign the
individual View-Only management **roles**, not the "View-Only Organization
Management" role **group**; StrictMode + `-Device` fixes). Ran the grant: SP
registered in EXO, three read-only roles assigned. But every Exchange **report**
then failed with a bare `HttpStatusCode=401` (empty body). Exhaustive ground-truth
diagnosis (all via `az`, and by running app-only EXO *inside the live container* via
`az containerapp exec` + a diagnostic staged on the Azure Files share) ruled out,
in turn: wrong `-Organization` (fixed), SP registration, missing `Exchange.ManageAsApp`
(consented), unassigned/disabled roles (all Enabled), propagation (12h+), and
Conditional Access (no workload-identity policies; user CA doesn't apply to
client-credential tokens). We even added the read-only **Global Reader** Entra role
as the classic fallback — still 401.
**The decisive test:** mint the app-only token in-container and hit the EXO REST API
two ways. The token was correct (`roles=Exchange.ManageAsApp`, `aud=outlook.office365.com`);
a **raw `adminapi/beta/{tid}/Mailbox` call returned HTTP 200**, but the **same token
through the `ExchangeOnlineManagement` module (3.7.2) returned 401** — with the
tell-tale `[System.Net.Http.HttpResponseMessage] does not contain a method named
'GetResponseHeader'`, a .NET-version-drift bug in the module's error path on
PowerShell 7.5.8. So authZ/permissions were fine all along; the **module** was the
blocker, and since the app always runs through the module it masked every prior test.
**Decision:** **Bypass the ExchangeOnlineManagement module for reports — call the EXO
REST API (`adminapi`) directly** with an app-only token. Connect mints + caches the
token (client-assertion with the KV cert) in the session instead of running
`Connect-ExchangeOnline`; each Exchange report swaps its `Get-EXO*` cmdlet for an
`Invoke-RestMethod` against `adminapi`, shaped to the same columns. Phasing:
(1) mailbox reports (shared-mailboxes, mail-forwarding, mailbox-sizes, user-mailbox)
→ `adminapi/.../Mailbox` + `MailboxStatistics`; (2) dl-members + user-inbox-rules →
adminapi DistributionGroup/InboxRule (verify endpoints); (3) message-trace(-detail)
→ a SEPARATE reporting API (not adminapi), a meatier lift. Deferred to a dedicated
session. Keep the current Azure config (roles, Global Reader, `Exchange.ManageAsApp`,
`orgDomain`) — it is correct and working.
**Consequences:** Removes the fragile module dependency for Exchange and the
device-code/session-affinity baggage; app-only Exchange becomes a stateless token +
HTTPS call, consistent with the containerized model. Cost: reimplementing each report
against REST semantics and reverse-engineering the message-trace reporting endpoint.
Graph app-only is unaffected. Global Reader was likely unnecessary (RBAC-for-Apps was
probably fine); left in place for now, revisit for least-privilege once REST works.

## 2026-07-15 -- ADR-0010: v12.1.3 — hosted connect card is app-only; Dockerfile COPY glob + guard; RBAC store repoint (second-user fix)
**Context:** With Phase 4b live, a second user (dave@am.consulting) still could
not connect — the deployed connect card presented the delegated sign-in controls
(UPN, Tenant ID, device-code, "Connect as Current User"), which the server refuses
in `DOCKER_MODE`, and his Connect dead-ended in "No job was created — the server
rejected the request." Ground-truth diagnosis (live RBAC store + audit log + Entra
membership via `az`) showed the real cause was **data, not code**: the store's
`am-full-read` role assignment was bound to the **"M365 Admin Reports - Access"**
group (`197dd092`, which Dave is not in) instead of the **"AM Full Read"** group
(`8c763eb0`, which he is). Dave's token carried none of the store's referenced
groups → `hasToolAccess` = false → denied at the access gate before any tenant
logic. The role being *named* `am-full-read` while assigned to the *Access* group
was the trap; it was not group-claim overage (Dave is in ~30 groups, well under
the ~150/200 cutoff). Separately, the connect card and the Dockerfile were the two
deferred follow-ups from ADR-0009.
**Decision:**
- **Fix the live data out-of-band, unblock without a deploy.** Repointed the
  assignment `197dd092` → `8c763eb0` directly on the Azure Files store
  (`access/rbac.json`), original backed up to `access/rbac.json.bak-20260715-repoint`.
  `rbac.js` hot-reloads on file mtime, so the fix took effect on Dave's next
  request — no image change required. Verified: **Dave refreshed and connected.**
  `hasToolAccess` grants entry to any role-holder, so binding the role to the
  correct group also satisfies the access gate even though the Access group is
  empty; `accessGroupId` was left pointing at the (empty) Access group as the
  future gate.
- **Connect card is app-only in the hosted tool** (`public/index.html`). In
  `DOCKER_MODE` (read from `/api/health` `dockerMode`), hide the delegated-only
  controls and show only the tenant selector + Connect (disabled until a tenant is
  chosen); the connecting banner no longer promises a browser sign-in window.
  Localhost keeps the delegated fallback. Added a clear **"No access — ask an
  admin"** banner when the RBAC gate denies `/api/config`, and a "no tenant
  granted" note — so this whole class of denial is self-explanatory instead of a
  dead Connect button.
- **Retire the explicit Dockerfile COPY list** (supersedes the ADR-0007 approach
  of "keep the explicit list in sync"). Use `COPY *.js ./` so a new top-level
  module can never be silently omitted, and add `npm run lint:copy`
  (`scripts/lint-copy.js`) that walks the `server.js` require() graph and fails the
  build if any `require("./x")` is unresolved or uncopied. (The guard itself had a
  shared-global-regex-under-recursion bug that dropped `keyvault.js`; fixed by
  collecting matches before recursing.)
- **Deploy by quick image roll**, not the full script: `az acr build --no-logs` +
  `az containerapp update --image`, preserving Easy Auth / KV / storage config.
**Consequences:** Ships as **v12.1.3**, live in ACA (rev `--0000007`, eastus2,
100% traffic). The credential-bleed remediation is now proven end-to-end by a real
second user. The COPY glob is validated in the strongest way possible — the 12.1.3
image booted **Healthy**, so the crash-loop mode that killed 12.1.0/12.1.1 cannot
recur from an omitted module. `npm test` 22/22; both lints green. Both v12 PRs
(#1 Phase 4b, #2 this work) are merged; `main` @ `34217d5` equals what is live.
Operational lesson recorded: an RBAC role/assignment must reference the intended
Entra **group OID** — a role whose *name* matches a group is not the same as being
*assigned to* that group; verify the OID, not the name. `gh` also needed the
`am-jcsernik` account added (the `arcenik86` login is not a collaborator on
`origin`, so it could not open PRs). Open: Exchange app-only unproven; group-claim
overage fallback still unbuilt; switch-tenant-after-connect still needs a disconnect.

## 2026-07-15 -- ADR-0009: v12 Phase 4b — per-tenant app-only session pool (credential-bleed fix), shipped v12.1.2
**Context:** A second user testing the deployed tool saw it "connected as" the
admin, and their reports executed against the admin's delegated Graph token. Root
cause (confirmed in code): v11's architecture is process-global — one `pwsh`
process, one `connectionInfo`, one FIFO queue — and the live connection was a
**delegated device-code** session, so the admin's personal token sat in front of
every caller. This is the deferred Phase 4b, now forced by a live exposure.
**Decision:**
- **Connection model = app-only per tenant** (the ADR-0006 intent), chosen over
  per-user delegated sessions. Rationale weighed with the operator: app-only makes
  the connection identity the app SP (never a person), is unattended, reuses the
  Phase 0 cert infra, and is cheap (bounded by #tenants). The cost — the M365
  unified log attributes actions to the app SP — is covered by hardening the
  tool's **own** audit log as the authoritative "who".
- **Per-tenant session pool** (`sessions.js`): each tenant slug gets its own pwsh,
  connection state, FIFO queue, and browse/dashboard caches (the latter moved
  off globals to avoid a *new* cross-tenant cache bleed). Lazy start; 30-min idle
  eviction (kills pwsh, unlinks staged cert). Concurrency is across tenants; within
  a tenant, commands still serialize (no-interleave invariant preserved).
- **App-only mandatory in `DOCKER_MODE`:** delegated/device-code connect refused
  (400). Delegated survives only as the localhost-dev fallback. This is the change
  that structurally removes the bleed — no personal token is ever server-side.
- **Tenant routed per request**, re-checked with `rbac.can(user,{tenant})`
  server-side (never trust the client's tenant choice). New `GET /api/connection`;
  `/api/health` slimmed to liveness + PS state.
- **Tamper-evident audit** — hash chain (`hash = sha256(prevHash + entry)`),
  `verifyAuditChain()`, `integrity` on `GET /api/audit`.
- **`maxReplicas` stays 1** — sessions are per-replica in memory; lifting it needs
  ACA session affinity (deferred).
**Consequences:** Ships as **v12.1.0** (feature), with two follow-on patches found
only at first live exercise: **v12.1.1** (`a6b47d3`) — the Dockerfile `COPY` list
omitted the new `sessions.js`, crash-looping the image (a *recurrence* of the
ADR-0007 hazard: the explicit COPY list must track every `require`); **v12.1.2**
(`60bc80c`) — the app-only connect commands write via the `__OUTFILE__` token
(substituted only in `raw` mode) but ran without `raw: true`, so a *successful*
`Connect-MgGraph -Certificate` produced no captured output and the server never
set `graphConnected`. Both were invisible until app-only ran live (it never had,
through Phase 4a). v12.1.2 is live in ACA (rev `--0000006`, eastus2) and the
app-only path is **confirmed end-to-end** — the connect banner reads the app
identity, not a user. Deploy friction of note: the background deploy's output was
truncated by task teardown across turns (build/Bicep still completed; trust live
Azure state over the log), and `az containerapp update --image` is the quick
image roll. Open: connect-card UI still shows vestigial delegated controls;
Dockerfile COPY hardening; second-user validation; merge to `main`.

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
