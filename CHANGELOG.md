# Changelog — M365 Admin Reports

All notable changes to this project. Versioning follows semver as of v11.0.0;
earlier versions were sequential build numbers with letter-suffixed patch
iterations (e.g., v10f).

## [12.3.0] — 2026-07-17

### Added
- **Global Administrators are tool admins (via the `wids` claim).** In-tool admin
  can now be conferred by an Entra directory role — Global Administrator by
  default, extendable via the `ADMIN_ROLE_IDS` env (comma-separated
  roleTemplateIds). This rides the token's `wids` claim, which is *independent* of
  the `groups` claim, so a Global Admin retains admin even if group claims break
  or overflow (group overage) — a recovery path that admin-group membership alone
  didn't provide. Strictly additive: it only adds ways to be admin.
- **`/api/config` echoes the caller's own identity** as `me: { upn, adminVia }`
  (own identity only — no leak), where `adminVia` lists which signals granted
  admin (`local-dev` / `admin-group` / `global-admin-role`). Lets the Global-Admin
  path be confirmed live in-browser.

### Changed
- Admin resolution in `auth.js` is now `local-dev OR admin-group OR admin
  directory role` (previously admin-group only). The decoded principal now also
  carries `roles` (the `wids` values).

### Notes
- Ratified two open items with no code change (see ADR-0016): the bootstrap
  access group staying optional/empty by design, and min-replicas remaining 0.
- The originally-planned Graph `/memberOf` group-overage fallback is intentionally
  not built — not needed at this tenant's scale; the `wids` admin path addresses
  the real lockout risk.

## [12.2.0] — 2026-07-17

### Added
- **`Invoke-ExoRestBatch` — concurrent per-identity EXO fan-out.** A new
  session-global helper in the app-only connect script (sibling to
  `Invoke-ExoRest`) that runs one EXO cmdlet across many identities with bounded
  concurrency (`ForEach-Object -Parallel`, default `-ThrottleLimit 8`), reusing a
  single pre-minted token. Honors `Retry-After` on 429/5xx with a capped retry
  loop. Lives in the connect script (not a report command) so it may call
  `Invoke-RestMethod` directly without tripping the report read-only blocklist,
  and sidesteps the fact that `-Parallel` runspaces don't inherit the global
  `Invoke-ExoRest` / token state.

### Changed
- **`all-forwarding-rules` and `mailbox-sizes` now fan out in parallel.** Both
  were serial per-mailbox REST loops (107 mailboxes at AM → ~minutes). They now
  collect identities up front and hand them to `Invoke-ExoRestBatch`; result
  shaping (rule-name cleaning, size parsing, top-50 sort) stays in the parent, so
  the `$clean` scriptblock no longer crosses a runspace boundary. Expected
  wall-clock roughly `serial ÷ throttle` minus throttling.
- **No more silently-dropped mailboxes.** `all-forwarding-rules` previously did
  `catch{continue}`, so a transient per-mailbox error dropped that mailbox from
  the audit with no trace. Failures now surface as a row
  (`Rule='(scan failed)'`, the error in `ForwardTo`) so an incomplete scan is
  visible. `mailbox-sizes` skips failed stats (as before) but the failure is no
  longer masked at the transport layer.

## [12.1.7] — 2026-07-17

### Fixed
- **Message Trace works again (ADR-0011 phase 3, completing the ADR).** The
  `message-trace` and `message-trace-detail` reports still called
  `Get-MessageTrace(V2)` / `Get-MessageTraceDetail(V2)` as *module* cmdlets via
  `Get-Command`, but the app-only connection no longer imports the
  `ExchangeOnlineManagement` module — so they failed with "The term
  'Get-MessageTrace' is not recognized." An in-container probe proved
  `Get-MessageTraceV2` and `Get-MessageTraceDetailV2` run fine over the same
  `adminapi InvokeCommand` transport as every other EXO cmdlet (the earlier
  assumption that message trace needed a separate reporting API was wrong). Both
  reports now call `Invoke-ExoRest -Cmdlet Get-MessageTrace(Detail)V2`; dates are
  passed as ISO strings and `ResultSize` caps at 5000. Validated end-to-end in the
  live container. **All Exchange reports are now app-only over `adminapi`.**
- Dropped the legacy `Get-MessageTrace` (V1) fallback entirely — over `adminapi`
  it now hard-errors server-side ("Get-MessageTrace will start deprecating on
  September 1st, 2025 … switch to Get-MessageTraceV2").

### Added
- **`requireAny` report gate (report + UI).** A report may set `requireAny:true`
  to block Run until at least one parameter has a value, so an all-optional report
  can't be run wide open. Applied to **Message Trace**: the user must open the card
  and set at least one filter (sender / recipient / date / status) before Run
  enables, mirroring how picker-gated reports require a selection. A hint explains
  why Run is disabled. (`message-trace-detail` was already gated by its required
  `MessageTraceId`.)

## [12.1.6] — 2026-07-17

### Changed
- **Phase-2 Exchange reports rewritten onto `Invoke-ExoRest` (ADR-0011)**
  (`reports.js`): `dl-members`, `user-inbox-rules`, `all-forwarding-rules`,
  `mailbox-permissions`. These were the last reports still calling the broken
  `ExchangeOnlineManagement` module cmdlets (`Get-EXOMailbox`,
  `Get-EXOMailboxPermission`, `Get-EXORecipientPermission`, `Get-InboxRule`,
  `Get-DistributionGroup*`); they now run app-only over the `adminapi`
  `InvokeCommand` REST surface like phase 1. Validated end-to-end in the live
  container against real AM data (55 DLs, 107 mailboxes).

### Fixed
- **`dl-members`:** over REST `Get-DistributionGroup` returns `Guid`,
  `PrimarySmtpAddress` and `Identity` as plain strings (not typed objects), so
  member expansion resolves `Identity` from the string `Guid` directly (dropped
  the now-invalid `.ToString()`).
- **`user-inbox-rules` / `all-forwarding-rules`:** `ForwardTo` / `RedirectTo` /
  `ForwardAsAttachmentTo` serialize as a string collection whose entries are
  display strings with an embedded legacyExchangeDN
  (`"Name" [EX:/o=…/cn=…]`); the reports now extract just the quoted display name
  for readable output instead of dumping the raw EX address. Empty collections
  come back `null`, which the join tolerates. `all-forwarding-rules` also gained
  a per-mailbox `try/catch` so one unreadable mailbox no longer aborts the scan.
- **`mailbox-permissions`:** over REST `Deny` serializes as the string
  `"False"`/`"True"` (not a boolean), so a Deny ACE is now correctly excluded
  from the "grants access" output via `Deny -ne 'True'`; `AccessRights` remains a
  string collection and joins cleanly.

## [12.1.5] — 2026-07-16

### Fixed
- **App-only Exchange reports now work — the broken EXO module is bypassed
  (ADR-0011).** `ExchangeOnlineManagement` 3.7.2 fails every app-only REST cmdlet
  on PowerShell 7.5/.NET (its error path calls the removed
  `HttpResponseMessage.GetResponseHeader`, surfacing as a bare `401`) even though
  the app's permissions are correct. The Exchange connect no longer runs
  `Connect-ExchangeOnline`; instead it mints an app-only token for
  `outlook.office365.com` (client-assertion signed with the tenant's Key Vault
  cert) and calls the EXO REST admin API (`adminapi` `InvokeCommand`) directly.
  Proven end-to-end in the live container against 107 mailboxes.

### Added
- **Session-global Exchange REST helpers** (`tenants.js`,
  `buildExchangeAppOnlyConnect`): `Get-ExoRestToken` (mint/cache the app-only
  token, re-mints ~2 min before expiry) and `Invoke-ExoRest` (run any EXO cmdlet
  over `adminapi InvokeCommand`, with `@odata.nextLink` paging and clean error
  propagation). Connect verifies with a cheap `Get-OrganizationConfig`.

### Changed
- **Phase-1 Exchange reports rewritten onto `Invoke-ExoRest`** (`reports.js`):
  `shared-mailboxes`, `mail-forwarding`, `mailbox-sizes`, `user-mailbox`. Over
  REST `TotalItemSize` is a string (`"1.4 GB (n bytes)"`), so `mailbox-sizes` now
  parses the byte count from the string for sorting instead of the module's typed
  `.Value.ToBytes()`.

### Known limitations
- `mailbox-sizes` stats each mailbox with its own REST call (107 at AM), so it is
  the slow report; within the 5-min job timeout but a candidate for batching.
- Phase 2 (`dl-members`, `user-inbox-rules`, `mailbox-permissions`,
  `all-forwarding-rules`) and phase 3 (`message-trace`/`-detail`, a separate
  reporting API) still use the old module cmdlets and remain to be ported.

## [12.1.4] — 2026-07-15

### Fixed
- **App-only Exchange connect now passes a domain, not the tenant GUID.** The
  hosted connect card never supplied an `org`, so `buildExchangeAppOnlyConnect`
  fell back to `tenant.tenantId` — a GUID — for `Connect-ExchangeOnline
  -Organization`, which documents a verified/`.onmicrosoft.com` domain and does
  not reliably accept the GUID. This would have failed every hosted Exchange
  connect even after the EXO role grant.

- **Exchange connect banner wording (hosted).** The Exchange "connecting" banner
  now passes `appOnly` in `DOCKER_MODE`, so it reads "Signing in with the tenant's
  app registration (certificate) — no browser…" instead of the stale "a browser
  sign-in window should be open" text (the Graph banner was already fixed in 12.1.3).

### Added
- **Per-tenant `orgDomain` field.** Tenants now carry an optional `orgDomain`
  (the verified/`.onmicrosoft.com` domain, e.g. `am.consulting`) used for the
  Exchange app-only `-Organization` argument. Surfaced in the Tenants admin table
  and add/edit form; persisted in the RBAC store. Resolution order for the connect
  is `req.body.org` → `tenant.orgDomain` → `tenant.tenantId` (last-resort only).

### Changed (tooling)
- **`deploy/Grant-ExoAppOnlyRole.ps1` hardened.** `-Role` (single) → `-Roles`
  (array), defaulting to the read-only management ROLES the reports need
  (`View-Only Recipients`, `View-Only Configuration`, `Message Tracking`) instead
  of the role GROUP "View-Only Organization Management" (which `New-ManagementRoleAssignment
  -App` cannot accept). Each role is pre-checked with `Get-ManagementRole`; the
  SP-exists message no longer references a `ServiceId` property that trips StrictMode.

### Known issue
- **App-only Exchange reports still fail (module bug, not config).** With app-only
  auth proven working at the REST layer (raw `adminapi` call returns 200 with the
  app token), the `ExchangeOnlineManagement` module (3.7.2) in the container returns
  401 for its REST cmdlets on PowerShell 7.5/.NET (the `HttpResponseMessage`
  `GetResponseHeader` bug). Fix planned: bypass the module and call the EXO REST API
  directly (see `docs/DECISIONS.md` ADR-0011). Graph app-only is unaffected.

## [12.1.3] — 2026-07-15

### Changed
- **Connect card is app-only in the hosted tool.** In `DOCKER_MODE` the card now
  hides the delegated-only controls that could only ever fail server-side — the
  Account (UPN) box, the "Tenant ID (local delegated only)" box, the "Use device
  code auth" checkbox, and the "Connect as Current User" button — leaving just the
  tenant selector and Connect. The Connect button is disabled until a tenant is
  chosen, and the "connecting" banner no longer claims a browser sign-in window
  will open (app-only certificate auth needs none). Delegated controls still show
  on localhost, where the delegated fallback is valid.

### Added
- **Clear messaging for the unauthorized/no-tenant cases.** A caller who is
  authenticated but not authorized (RBAC access gate denies `/api/config`) now
  sees a plain "No access — ask an administrator…" banner instead of a working-
  looking Connect button that dead-ends in "No job was created." A caller with
  tool access but no tenant granted sees a targeted "no tenant available" note.
- **`npm run lint:copy` build guard** (`scripts/lint-copy.js`) — walks the
  `server.js` local `require()` graph and fails if any `require("./x")` is
  unresolved or not copied by the Dockerfile.

### Fixed
- **Dockerfile hardening against the recurring crash-loop.** The image now copies
  every top-level module with `COPY *.js ./` instead of an explicit per-file list
  that twice fell out of sync with new `require()`s (ADR-0007 `auth.js`/`rbac.js`;
  v12.1.1 `sessions.js`). A new module can no longer be silently omitted from the
  image.

## [12.1.2] — 2026-07-15

### Fixed
- **App-only connect now captures its result (`raw: true`).** The per-tenant
  app-only Graph/Exchange connect commands write their result via the
  `__OUTFILE__` token, which is only substituted in raw execution mode — but the
  app-only path called `runInSession` without `raw: true`. `Connect-MgGraph
  -Certificate` succeeded but produced 0 bytes of captured output, so the server
  never set `graphConnected` and every report's Run button stayed disabled
  (Graph shown as not-connected). Pre-existing since Phase 4a; first surfaced on
  the initial live app-only connect. Both Graph and Exchange app-only calls now
  pass `raw: true` (matching the delegated path).

## [12.1.1] — 2026-07-15

### Fixed
- **Dockerfile `COPY` now includes `sessions.js`.** The v12.1.0 image omitted the
  new Phase 4b module, so the container crash-looped on boot
  (`Cannot find module './sessions.js'`) → 0 healthy replicas → ingress 404. The
  12.1.0 image never served a request; 12.1.1 is the first working Phase 4b image.
  (Recurrence of the ADR-0007 Dockerfile-COPY hazard — the explicit module list
  must track every `require` in `server.js`.)

## [12.1.0] — 2026-07-15

**Phase 4b — per-tenant app-only session pool.** Closes the shared-session
credential bleed found in production: a second user saw the tool "connected as"
the admin, and their reports executed against the admin's delegated token,
because v11 kept one process-global PowerShell session/connection/queue.

### Changed
- **Per-tenant session pool (`sessions.js`, new).** The single global session is
  replaced by `Map<tenantSlug → {pwsh, connectionInfo, queue, caches, cert}>`.
  Each tenant gets its own process, connection state, FIFO queue, and browse/
  dashboard caches. Concurrency is across tenants; within a tenant, commands
  still serialize (the no-interleave invariant is preserved). Sessions start
  lazily and are evicted after 30 min idle (pwsh killed, staged cert unlinked).
- **App-only enforced in the hosted tool.** In `DOCKER_MODE`, delegated/device-
  code connect is refused (400) — the connection identity is always the app
  service principal, never a person, so no user's token is ever server-side.
  Delegated auth survives only as the localhost-dev fallback.
- **Tenant routed per request.** `/api/run`, `/api/browse/*`, `/api/pack/run`,
  `/api/dashboard`, connect, disconnect, and restart resolve the caller's
  selected tenant and re-check `rbac.can(user, {tenant})` server-side (the
  client's choice is never trusted). New `GET /api/connection?tenant=` reports
  per-tenant status; `/api/health` is now liveness + PowerShell state only.
- **UI (`public/index.html`).** Sends the selected tenant slug on every data
  request; per-tenant connection banner; tenant selector keyed by slug.

### Added
- **Tamper-evident audit log.** Each entry is hash-chained
  (`hash = sha256(prevHash + entry)`); `GET /api/audit` returns an `integrity`
  verdict from `verifyAuditChain()`. Under app-only the tool's own log is the
  authoritative "who" record (the M365 unified log attributes to the app SP).
  Report runs record the tenant + connection identity.
- Tests: `test/phase4b.sessions.test.js` — delegated refusal in `DOCKER_MODE`,
  per-tenant routing + tenant authorization, and audit chain integrity/tamper
  detection. Suite now 22/22.

### Notes
- `maxReplicas` stays 1 (sessions are in-memory per replica). Scaling >1 would
  require ACA session affinity — out of scope here.
- Known UI limitation: switching tenants after connecting requires disconnect
  (the tenant selector shows in the connect card). Follow-up.

## [12.0.0] — 2026-07-15

Multi-user, default-deny **RBAC** — the tool moves from "single admin on
localhost" to a small multi-user service with three access tiers: who may open
the tool → which tenants → which reports/areas. Ships as one major version.
Full design in ADR-0006/0007 and `docs/PLAN-v12-rbac.md`.

### Added
- **Identity (`auth.js`).** Acting user resolved from Azure Container Apps Easy
  Auth (`X-MS-CLIENT-PRINCIPAL*`), trusted only when present; a synthetic
  full-admin identity on the local bind so localhost dev is unchanged. Group
  overage flagged.
- **Authorization store + engine (`rbac.js`).** Writable store at
  `DATA_DIR/access/rbac.json` (non-secret metadata only; mtime-cached, atomic
  writes) and a default-deny engine: named reusable roles scoping tenants +
  areas/report-ids, assigned to users or Entra groups; access is the union of
  all matching roles.
- **Enforcement (`server.js`).** A `/api` access gate + per-route tenant/report
  guards; `/api/reports` and `/api/config` filtered to the caller; admin-only
  management + `/api/audit`. Every deny is audited.
- **App-only certificate connect per tenant (`tenants.js`, `keyvault.js`).**
  Cert fetched from Key Vault via the Container App managed identity at connect
  time (no `@azure/*` SDKs — REST + built-in `fetch`); device code retained as
  fallback and admin-bootstrap path.
- **Admin UI (`public/index.html`).** An admin-gated **Access Control** panel —
  tenants, roles, assignments, and bootstrap group ids — with a friendly-name
  tenant dropdown. No hand-editing of JSON.
- **Admin management API.** `requireAdmin`-gated CRUD under `/api/admin/*`
  (store, tenants, roles, assignments, groups), each writing atomically through
  `rbac.saveStore` and audited. Deletes cascade (tenant→roles, role→assignments).
- **Integration test suite (`test/`, `npm test`).** Node's built-in runner boots
  the real server and drives the full guard matrix (401/403/filtering/admin
  CRUD/cascade) offline — no Graph/PowerShell required.
- **New env vars.** `ACCESS_GROUP_ID`, `ADMIN_GROUP_ID`, `KEY_VAULT_NAME`
  (see README).

### Changed
- Audit now records **two identities** per action: the acting user (Easy Auth)
  and the connection identity (per-tenant app service principal).
- Docs updated for the new identity/authZ/connection model: `README.md`
  (access-control admin + end-user guide), `PERMISSIONS.md` (application vs
  delegated scopes), `docs/ARCHITECTURE.md`.

### Fixed
- **Dockerfile `COPY`** now ships `auth.js`, `rbac.js`, `tenants.js`,
  `keyvault.js` — without this the v12 image crash-looped on boot.

### Deferred
- **Phase 4b** — the concurrent per-tenant connection pool that retires the
  single in-memory session and lifts `maxReplicas 1`; needs live multi-tenant
  traffic to validate.
- **Group-claim overage fallback** — the Graph `memberOf` lookup for users in
  too many groups (overage is flagged but not yet resolved).

## [11.12.2] — 2026-07-14

### Fixed
- **Exchange Online sign-in now works in the container / ACA.**
  `Connect-ExchangeOnline` defaulted to interactive browser auth and failed in
  the headless Linux container with "Unable to open a web page using xdg-open,
  gnome-open, kfmclient or wslview tools." In `DOCKER_MODE` it now passes
  `-Device` (probed, EXO 3.x) for device-code auth and runs in the raw
  passthrough mode added in 11.12.1, so the device-code prompt streams to the
  UI just like the Graph connect. Verified in-container: the code surfaces in
  the job status. The device-code prompt is now shown in the connect banner for
  both Graph and Exchange.

## [11.12.1] — 2026-07-14

### Fixed
- **Device-code sign-in now works in the container / ACA.** In `DOCKER_MODE`
  the Graph connect uses device-code auth, but the code never appeared — not in
  the UI and not in the logs — so sign-in always timed out after 120s. Two
  causes: (1) the persistent pwsh session was interactive (no `-NonInteractive`),
  so PSReadLine terminal rendering polluted/hid the output; and (2) the Graph SDK
  emits the device-code prompt on the Success stream, which the command wrapper
  captured (`$__r = & { … }`) and the connect line discarded (`| Out-Null`), so
  it never streamed to stdout. Fixes:
  - Spawn the session with `-NonInteractive`.
  - Add a **raw passthrough execution mode** (`runInSession(..., {raw:true})`)
    that runs a command at statement level without capturing/Out-Null-ing its
    output, so the device-code prompt streams to the session stdout live; the
    command writes its result to the job out-file instead.
  - Capture the device-code prompt server-side and expose it on
    `GET /api/job/:id` (`deviceCode: {url, code}`).

### Added
- **Device code shown in the web UI.** The connect banner now displays the
  `microsoft.com/device` link and the code (with a copy button) as soon as the
  server surfaces them, so operators never tail the server/container console.

### Changed
- `docker-compose.yml`: host port is overridable via `HOST_PORT` (defaults to
  3365) so local container validation can coexist with a native instance on
  3365; removed the obsolete `version:` key.

## [11.12.0] — 2026-07-14

### Added
- **Azure Container Apps deployment support** (`deploy/`):
  - `main.bicep` — declarative infrastructure: Log Analytics workspace,
    Container Apps environment, an Azure Files share linked as the `DATA_DIR`
    volume, and the Container App with external ingress (TLS at the edge),
    scale-to-zero (`minReplicas 0` / `maxReplicas 1`), and a `/api/health`
    liveness probe.
  - `Deploy-ToAca.ps1` — PS 7 orchestration wrapper: prereq checks, resource
    group, ACR + server-side `az acr build`, storage/file-share, Bicep deploy,
    and **Entra Easy Auth** as the ingress gate (restricted to the home
    tenant) — the access control that makes public exposure acceptable ahead
    of v12 RBAC.
  - `deploy/README.md` — deployment guide covering the security posture, the
    two independent auth layers (ingress gate vs. Graph/EXO connect), the
    scale-to-zero re-auth tradeoff, and persistent storage.
- **`DATA_DIR` environment variable** — relocates all durable state
  (`M365Snapshots/`, `M365AuditLog/`, `M365Logs/`, `M365Reports/`) under a
  single configurable root. Defaults to `process.cwd()`, so local runs are
  unchanged; in a container it points at the mounted Azure Files volume so
  state survives restarts and scale-to-zero. (`server.js`, `audit.js`,
  `snapshots.js`.)

### Fixed
- **Dockerfile no longer boots a broken image.** It now copies every module
  `server.js` requires (`reports.js`, `packs.js`, `snapshots.js`, `audit.js`,
  `scripts/`) — the pre-v11 Dockerfile copied only `server.js` + `public/` and
  would crash on startup after the module split. Also switched to
  `npm ci --omit=dev` (reproducible, lockfile-pinned) and created the
  non-root-owned `/app/data` volume mount point.

### Changed
- `docker-compose.yml` mounts a single `./data` volume at `DATA_DIR` for local
  parity with the ACA Azure Files mount, and documents the local device-code
  validation flow.
- `.dockerignore` hardened to exclude `config.json`, all runtime state dirs,
  and `deploy/` / `Handoff/` from the build context.
- `docs/ARCHITECTURE.md` filled in with the full system shape and the ACA
  deployment target.

## [11.11.0] — 2026-07-10

### Changed
- **Message Trace drill-down is now a structured detail view** instead of a
  raw event table:
  - A **summary header** shows the message-level fields (Received, Status,
    Sender, Recipient, Subject, Size, From/To IP) and — addressing the
    truncated-ID problem — the **full Message-Trace-ID and Message-ID**, each
    with a one-click **Copy** button (the table cell stays truncated for
    layout, but the full value is always available here).
  - Delivery events render as a **color-coded timeline** (event type →
    colour: receive/deliver/send/fail/spam/expand), each showing the event,
    action, timestamp and detail.
  - Each event's **`Data` payload is parsed** — message-trace Data is usually
    XML, so it's expanded on demand into a readable key/value table (with a
    raw fallback for non-XML). This is the deepest per-hop detail the live
    trace API exposes.
- **Trace table cells now carry a hover tooltip** (`title`) showing the full
  untruncated value, so long fields like Message-Trace-ID are readable without
  expanding a row.

### Notes
- "Further detail" beyond this: the live trace's event `Data` is the deepest
  layer available in the ~10-day window. Older messages, a downloadable
  extended report, or bulk detail require **Historical Search**
  (`Start-HistoricalSearch`) — async, and still a planned follow-up (a note to
  that effect appears at the bottom of the detail panel). Full RFC headers and
  message bodies are not available through message trace at all.
- No server/report or scope changes; presentation only. Verified `node
  --check`, `npm run lint` (49 reports + 3 packs), and the frontend Babel
  transform.

## [11.10.0] — 2026-07-10

### Added
- **Message Trace Detail** (Exchange / Mailbox) — per-hop delivery events
  (RECEIVE, SEND, DELIVER, FAIL, etc.) for a single message, via
  `Get-MessageTraceDetailV2` with automatic fallback to
  `Get-MessageTraceDetail`. Returns Date, Event, Action, Detail and Data.
- **Message Trace drill-down.** Rows in the Message Trace result table are now
  clickable: expanding a row runs Message Trace Detail inline for that row's
  Message-Trace-ID and recipient and shows the delivery hops beneath it. Rows
  without a Message-Trace-ID (e.g. the "no messages"/"capped" notice rows)
  are not expandable. The detail report is also usable standalone — paste a
  Message-Trace-ID and recipient into its card directly.

### Fixed
- **Distribution List Members failing for some lists** ("object '…' couldn't
  be found"). The distribution-list picker was sending the Graph
  **DisplayName** as the Exchange `-Identity`; lists whose display name
  differs from their Exchange name/alias (e.g. "Staff PH", "Staff Contractors")
  couldn't be resolved. Two-part fix:
  - The picker now sends the list's **primary SMTP address** (unique and
    always resolvable) while still displaying the friendly name in the field.
  - The `dl-members` command now resolves the list defensively — by identity
    first, then by a display-name filter — and expands members by the
    resolved object **GUID**, so it works regardless of which identifier is
    supplied. Unresolvable lists and non-classic groups (dynamic DLs,
    mail-enabled security groups) now return a clear ERROR row instead of a
    raw Exchange failure, and empty lists return a tidy "No members" row.

### Notes
- No new Graph scope. Both Message Trace Detail and the DL fix use the
  existing Exchange connection.
- Ships **untested against a live tenant** (sandbox has no pwsh/Graph/EXO):
  verified `node --check`, `npm run lint` (49 reports + 3 packs), frontend
  Babel transform, and `/api/reports`/`/api/health` exposure. See HANDOFF.md.

## [11.9.0] — 2026-07-09

### Added
- **Message Trace** (Exchange / Mailbox) — trace mail flow over the live
  window. Filter by sender, recipient, a start/end date window, and delivery
  status; all filters are optional. Returns Received, Sender, Recipient,
  Subject, Status, From/To IP, size (KB), Message-ID and Message-Trace-ID.
  Runs over the existing **Exchange** connection (`ex:true`).
  - **Cmdlet auto-selection:** probes for `Get-MessageTraceV2` (Exchange
    Online PowerShell module 3.7.0+) and uses it when present, falling back
    to the legacy `Get-MessageTrace`. Filters are passed via a shared splat;
    only the row-cap parameter differs (`-ResultSize 5000` for V2,
    `-PageSize 5000 -Page 1` for V1).
  - **Guardrails:** window defaults to the last 48 hours when unset (matching
    Microsoft's own default); a query window longer than 10 days is rejected
    with a clear message (this is a Microsoft limit — historical search beyond
    10 days is a planned follow-up); unparseable dates return an explicit
    ERROR row; the Graph/EXO call is wrapped in try/catch (Exchange cmdlet
    HTTP failures are terminating); a "No messages matched" row reports the
    resolved window and the cmdlet used; results at the 5000-row cap append a
    notice row prompting a narrower query.
  - **Scope caveat:** this is the *live* trace only. It does not run
    `Start-HistoricalSearch` (async, >10-day lookback) — noted as a follow-up.

### Changed
- **Parameter model extended (backward compatible):** report parameters now
  support `optional: true` (excluded from the run-enable gate), `type:
  "datetime"` (native date/time picker, submitted as a sanitizer-safe
  `yyyy-MM-ddTHH:mm` string), and `type: "select"` with an `options` list
  (dropdown). Existing reports use none of these and are unchanged.
- **Collapsed-card badge** now reads **"Params"** for reports whose inputs are
  free-text/date/select and **"Picker"** only when a tenant-object picker is
  present (previously always "Picker").
- Added a `--scheme` theme variable (dark/light) so native `datetime-local`
  and `select` controls render with the correct light/dark affordances.

### Notes
- No new **Graph** scope. Message trace uses the Exchange connection; the
  connecting account needs an Exchange role that includes **Message Tracking**
  (see PERMISSIONS.md).
- Ships **untested against a live tenant** (sandbox has no pwsh/Graph/EXO):
  verified `node --check`, `npm run lint` (48 reports + 3 packs), frontend
  Babel transform, and `/api/reports` exposure. See HANDOFF.md test items.

## [11.8.0] — 2026-07-09

### Added
- **CA Policies Targeting a User** (Security) — enter a user and see which
  conditional access policies include them, by what path (All Users, direct
  assignment, group membership, directory role, or guest/external), whether
  an exclusion removes them, and the effective "Applies" verdict, plus each
  policy's target apps and grant controls. Resolves the user's transitive
  group and role membership via `Get-MgUserTransitiveMemberOf`. Uses
  Policy.Read.All + Directory.Read.All (already granted — no re-consent).
  **Scope caveat:** this is an *assignment-scope* report, not the portal
  What-If — it does not evaluate app/device/location/risk conditions or
  session controls, only who a policy targets.
- **Intune / Devices** — a new report category (5 reports), all via
  `Invoke-MgGraphRequest` GET with automatic paging (no dependency on the
  Microsoft.Graph.DeviceManagement submodule):
  - **Managed Devices** — every Intune-managed device with compliance state,
    OS/version, ownership, last check-in, model, manufacturer, serial.
  - **Non-Compliant Devices** — managed devices not in a compliant state.
  - **Managed Devices (User)** — devices for one user (user picker).
  - **Compliance Policies** — Intune device compliance policies by platform.
  - **Configuration Profiles** — Intune device configuration profiles.

### Changed
- **Two new Graph scopes requested on connect:**
  `DeviceManagementManagedDevices.Read.All` and
  `DeviceManagementConfiguration.Read.All` (for the Intune reports). This
  triggers a **one-time consent prompt on your next connect**. Intune data
  also requires Intune licensing on the tenant.

## [11.7.1] — 2026-07-09

### Fixed
- **Usage reports failing with "PercentComplete cannot be greater than 100"**
  — this was a Graph SDK bug, not a permissions problem: the
  `Get-MgReport*UsageDetail -OutFile` cmdlets run a download progress bar
  whose percentage can exceed 100 and throw a *terminating* error. (The
  v11.7.0 try/catch caught it but mislabeled it as a Reports.Read.All consent
  issue.) All three usage reports — **OneDrive Usage**, **SharePoint Site
  Usage** and **OneDrive Report (User)** — now download the CSV via
  `Invoke-MgGraphRequest -OutputFilePath`, which has no progress wrapper and
  sidesteps the bug entirely.
- **Distribution List Members picker listed every group** (≈136) instead of
  distribution lists (≈48). The picker now uses a dedicated `distlists` type
  that reuses the group browse data filtered to `Type = 'Distribution'` — the
  same set the "Distribution Lists" report returns. No new server endpoint or
  scope; the picker label reads "distribution list(s)".

## [11.7.0] — 2026-07-09

### Added
- **Five new parameterized reports** (all use existing consent scopes — no
  new admin-consent prompt on connect):
  - **Distribution List Members** (Group Reports, Exchange) — expands a DL
    via `Get-DistributionGroupMember`, so it resolves classic DLs, nested
    groups and mail contacts that a Graph group-member query represents
    differently. Group picker.
  - **Licenses for a User** (Licenses) — every SKU assigned to one user via
    `Get-MgUserLicenseDetail`, with the enabled service-plan names and a
    plan count. User picker.
  - **Mailbox Report (User)** (Exchange) — type, size, item count, archive
    status, litigation hold, send/warning quotas and forwarding for a single
    mailbox. User picker.
  - **OneDrive Report (User)** (SharePoint / OneDrive) — per-user storage
    pulled from the D30 OneDrive usage report (so it needs only
    Reports.Read.All, not Files.Read.All). Returns a clear "no row" object
    when the user has no OneDrive or names are concealed by the tenant
    report-privacy setting. User picker.
  - **Sign-In Logs (User, 7d)** (Security) — last 7 days of sign-ins for one
    user via a server-side OData filter on `userPrincipalName`. User picker.

### Fixed
- **SharePoint reports failing outright** ("All SharePoint Sites" →
  InternalServerError; "SharePoint Site Usage" → Forbidden). Root cause:
  `Invoke-MgGraphRequest` raises HTTP failures as **terminating** errors,
  which `-ErrorAction SilentlyContinue -ErrorVariable` does not suppress
  (the persistent session's `$ErrorActionPreference = 'Stop'` compounds
  this). The error escaped to the envelope's catch and failed the whole job
  before the graceful diagnostic paths could run. Every `Invoke-MgGraphRequest`
  in the SharePoint/OneDrive reports is now wrapped in `try/catch`:
  - **All SharePoint Sites** — Search POST wrapped, with a single automatic
    retry for transient 500s; a persistent failure now returns a diagnostic
    row instead of killing the report.
  - **SharePoint Site Usage** — the usage-report cmdlet, the Search POST and
    each per-site GET fallback are individually guarded. Sites the delegated
    account can't read (403) now correctly stay `(unresolved)` instead of
    aborting the run.
  - **SharePoint Site Search** and **OneDrive Usage** — same
    terminating-error guard applied for consistency.
- **Audit-pack status icons had no tooltip** — hovering a pack result's
  ✓ / ✗ / ⊘ / ▶ now shows the row count, error message, or status. The icon
  helper previously received only the status string, so it had nothing to
  surface.

### Changed
- **Graph connect banner moved into the connect card** — the "Connecting to
  Microsoft Graph…" status with its elapsed timer now renders directly below
  the connect buttons, inside the *Connect to Microsoft Graph* card. The
  top-of-page banner is retained for Exchange connects.

### Internal
- Removed a dead, shadowed 2-arg `buildCommand` in reports.js (the 3-arg
  version is the only one used; the leftover was a reorder hazard).

## [11.6.0] — 2026-07-06

### Added
- **Result badges on report cards** — collapsed cards now show what their
  last run produced: green "✓ N rows", red "✗ error" (message on hover),
  or blue "⟳ running". Scan the page and see what you've run at a glance.
- **Audit entries carry the acting account** — every entry now includes
  the connected Graph account (the best identity available until RBAC
  sign-in lands), shown in the Audit viewer and its CSV export. The audit
  log lives in the UI at PowerShell Environment → Debug → Audit, and on
  disk at ./M365AuditLog/audit-YYYY-MM.jsonl.
- **Persistent console log** — everything the Debug "Logs" view shows is
  now also appended to ./M365Logs/console-YYYY-MM.log, since container
  console output (Azure Container Apps) is ephemeral. Mount a volume for
  ACA and the console log, audit log, and snapshots all survive restarts.
- **Favicon** (public/favicon.svg — gradient tile with bar-chart motif).

### Changed
- **Two-column report layout** — category sections now flow cards in a
  responsive grid (two columns on typical widths, one when narrow); an
  opened card expands to full width so tables keep their room.
- **Lucide icons** replace emoji across the chrome: dashboard, packs, run,
  refresh, download/export, snapshot camera, and the theme toggle (inlined
  SVG paths — no CDN dependency, ACA-friendly).

## [11.5.1] — 2026-07-06

### Fixed
- **Risky Users: "required scopes are missing in the token"** — the root
  cause was ours, not licensing: `IdentityRiskyUser.Read.All` was never in
  the Connect-MgGraph scope list, so no role could satisfy it. Now
  requested; expect a one-time consent prompt on next connect. (Azure AD
  P2 is still required for the data itself.)
- **Connect banner position** — now renders directly beneath the connect
  buttons at the top of the page instead of mid-content.

### Changed
- **SharePoint Site Usage name resolution, second pass** — Global Admin
  doesn't confer SharePoint site-level access, so the delegated Search
  join can't see permission-trimmed sites. The report now also attempts a
  direct `GET /sites/{id}` for up to 40 unresolved rows, recovering sites
  Search missed; truly inaccessible sites remain "(unresolved)"
  (TROUBLESHOOTING.md explains the GA nuance).

## [11.5.0] — 2026-07-06

### Fixed
- **Version reporting** — v11.4.0's release script bumped package.json but
  not the server's VERSION constant, so the console banner and UI footer
  kept saying 11.3.0 (and the 11.4.1 bump was then a silent no-op). The
  version now has a single source of truth: `require("./package.json")`.
- **License tile inflation** (e.g. "142/1010134") — `subscribedSkus`
  includes free/trial SKUs carrying prepaid pools of 10,000–1,000,000
  seats (Flow Free, Power BI Standard, Teams Exploratory, etc.). SKUs with
  ≥ 10,000 prepaid seats are now excluded from the used/total math; the
  tile notes how many pools were excluded. SKU count still shows all SKUs.

### Changed
- **Report cards no longer auto-collapse** — the accordion now allows any
  number of cards open at once, so results stay visible while running
  further reports. Clicking a header still toggles that card.

### Added
- **Connect-in-progress banner** — while connecting to Graph or Exchange, a
  banner shows what's connecting with a live elapsed-seconds counter and a
  reminder that the browser sign-in window may be hidden behind other
  windows (with a device-code variant pointing at the server console).
- TROUBLESHOOTING: "(unresolved)" SharePoint usage names also occur for
  sites the signed-in account cannot access (Search API is delegated).

## [11.4.1] — 2026-07-06

### Fixed
- **Admin Role Assignments parse error** — the command piped a
  statement-form `foreach` directly into `Sort-Object`, which PowerShell
  rejects ("An empty pipe element is not allowed"). Wrapped in `$( )`.
  This report had never successfully run; the Security Audit Pack exposed
  it.
- **Cascading failures after any parse error** — the parse-error recovery
  injected a lone `)` into the session (a relic of pre-file-IPC piping);
  with dot-sourced script files nothing dangles, so the `)` itself threw
  `Unexpected token ')'`, which the NEXT queued job's stderr watcher
  attributed to that job — one bad report failed the following ones
  (observed: guest-users and stale-users failing at "line 1: )" in the
  pack run). The injection is removed; parse errors now fail only their
  own job and the queue proceeds cleanly.
- Lint gained a brace-tracking check for statement-form
  `foreach`/`if`/`while`/`switch` blocks piped directly — the exact class
  of the admin-roles bug — verified against the old broken command.

## [11.4.0] — 2026-07-06

### Added — Tenant Health dashboard
- Summary tiles above the report list once Graph is connected: Users
  (total/enabled), Disabled, Guests, Groups, Devices, Licenses
  (used/total, % assigned, SKU count), CA Policies (enabled/total).
  Powered by a single aggregated Graph pass using `$count` queries
  (ConsistencyLevel: eventual) — fast even on large tenants.
- Tiles deep-link: clicking scrolls to (and briefly highlights) the
  matching report card. Warning colors: disabled/guests > 0, license
  assignment < 70%, zero enabled CA policies (red).
- Server-side 5-minute cache; ↻ Refresh forces a re-run
  (`GET /api/dashboard`, audit-logged).

### Fixed
- **SharePoint Site Usage now resolves site names.** Root cause identified
  from field testing (thanks Jim): OneDrive usage showed names, so this was
  NOT the tenant privacy setting — it's Microsoft's 2019 removal of "Site
  URL"/"Owner Display Name" from the SharePoint site usage report
  specifically, never restored. The report now joins the usage CSV's Site
  Id against the Microsoft Search API site list and resolves Site name and
  SiteUrl itself; unmatched rows show "(unresolved)". TROUBLESHOOTING.md
  rewritten to distinguish the two blank-name causes.

## [11.3.0] — 2026-07-06

### Added — Audit Packs
- One-click curated report bundles (`packs.js`), run sequentially through
  the job queue with per-report progress in the UI:
  - **Security Audit Pack** — admin roles, guests, stale/disabled accounts,
    CA policies, failed sign-ins, risky users, forwarding rules, shared
    mailboxes (10 reports).
  - **License & Cost Review** — license summary, service plans,
    unlicensed and disabled users (4 reports).
  - **Tenant Hygiene Pack** — empty groups, stale/disabled/unlicensed
    users, devices, domains (6 reports).
- **Auto-snapshot** (default on) saves each result with a shared label —
  periodic evidence collection; diff any of them from the report cards.
  Optional free-text label (e.g. "Q3 review").
- Exchange-dependent reports are skipped (not failed) when Exchange isn't
  connected, and the pack card shows the skip count up front.
- **Export All CSVs** downloads every completed report in the pack;
  per-report export buttons too.
- Pack runs and completions (with per-report outcomes) recorded in the
  audit log. Packs require a Graph connection (409 otherwise).
- API: `GET /api/packs`, `POST /api/pack/run`, `GET /api/pack/job/:id`,
  `GET /api/pack/job/:id/rows/:reportId`. Results held 30 minutes.
- Lint now validates packs: report IDs must exist and be parameter-free.

## [11.2.0] — 2026-07-06

### Fixed
- **Exchange Online connect** — `Method not found ... WithBroker(BrokerOptions)`
  is an MSAL assembly conflict: the Graph SDK loads its own
  Microsoft.Identity.Client into the shared session, then EXO 3.7.x calls a
  broker overload that version lacks. Connect now probes for and uses
  `-DisableWAM` (skips the broker path entirely), and if the conflict still
  occurs, surfaces concrete remediation (restart session → connect Exchange
  first, or update both modules) instead of the raw exception. **Needs
  testing on the real tenant.**
- **All SharePoint Sites** — `sites?search=%20` returns 400 BadRequest.
  Rewritten to the Microsoft Search API (`POST /search/query`,
  entityTypes: site), the supported way to enumerate site collections with
  delegated auth. `isSafe()` gained a narrow exception permitting POST to
  exactly that read-only endpoint (mirrored in the linter). **Needs testing.**
- **Queued jobs resolved prematurely** — v11.0.0 introduced a "queued"
  status, but the frontend poller and connect watchers treated any
  status ≠ "running" as terminal. A job that actually waited in the queue
  would have returned early. All status checks now treat "queued" as
  in-flight. (Latent — only visible when two jobs overlap.)

### Changed
- SharePoint/OneDrive usage reports: added `SiteId` column and documented
  that blank Site/User names are the tenant's report privacy setting
  ("conceal user, group, and site names"), not a tool bug — see
  TROUBLESHOOTING.md for the admin-center toggle.

### Added
- **Audit log** (`audit.js`) — append-only monthly JSONL under
  `./M365AuditLog/`: connections, report runs (and rejections), snapshot
  save/delete/diff, session restarts, with timestamp and client IP.
  Viewer + CSV export in the Debug section; `GET /api/audit`.
- **Configured tenant picker** — optional `config.json` (`tenants[]`, see
  `config.json.example`) renders a dropdown in the connect panel; the
  default entry pre-fills. Free-text Tenant ID still works.
- **Diff export** — "Export Diff" produces a CSV of added/removed/changed
  rows (Change column; per-field before→after summary on changed rows).
- **Snapshot export** — any stored snapshot exports to CSV from the
  snapshot dropdown.
- `RBAC-ROADMAP.md` — design for admin-configured per-user/per-role tenant
  access (v12 scope: OIDC sign-in + authorization + HTTPS as one unit).

## [11.1.0] — 2026-07-06

### Added — Snapshots & Diff
- **Save Snapshot** button under any report's results stores a point-in-time
  copy (JSON) under `./M365Snapshots/<reportId>/`.
- **Compare** dropdown diffs the current results against any saved snapshot:
  added / removed / changed rows, with per-field before→after values for
  changed rows. Answers "what changed since <date>" — new users, membership
  changes, new forwarding rules, license count movement, etc.
- Diff identity uses a per-report key column (`snapshots.js` KEY_COLUMNS —
  e.g., UserPrincipalName for user reports, PrimarySmtpAddress for mailbox
  reports), falling back to a heuristic, then whole-row matching (with a
  warning) when no stable key exists.
- API: `POST /api/snapshots`, `GET /api/snapshots/:reportId`,
  `GET /api/snapshots/:reportId/:id`, `DELETE /api/snapshots/:reportId/:id`,
  `POST /api/diff` (baseline snapshot vs. current rows or second snapshot).
- Snapshot report IDs are validated against the catalog and path-sanitized.

## [11.0.0] — 2026-07-06

### Fixed — root cause of the SharePoint "Not found" saga
- **The server's read-only blocklist pattern `/\bInvoke-Mg/i` matched
  `Invoke-MgGraphRequest`**, the cmdlet every SharePoint report uses. The
  `/api/run` request was rejected with 403 before any job was created (which
  is why the debug log never showed a `JOB:` line for SharePoint runs). The
  frontend didn't check the response for an error, destructured an undefined
  `jobId`, polled `/api/job/undefined`, and displayed that endpoint's 404
  response — literally `"Not found"` — as if it were a Graph error.
  The blocklist now uses `/\bInvoke-Mg(?!GraphRequest\b)/i` and separately
  requires `Invoke-MgGraphRequest` lines to specify `-Method GET`.
- Frontend now surfaces the server's actual rejection message instead of
  polling a nonexistent job; `api.poll` refuses to poll a missing jobId.
- `/api/job/:id` 404 message clarified ("Job not found — the run request may
  have been rejected").

### Changed — security hardening
- **Server binds `127.0.0.1` by default.** `0.0.0.0` only under `DOCKER_MODE`
  or an explicit `HOST` env var. Previously the tool (and its authenticated
  Graph session) was reachable from the entire LAN.
- **Report catalog moved server-side** (`reports.js`). The client now sends
  only `{ reportId, params, fields }`; the server builds the command from its
  own catalog. Field selections are validated against each report's whitelist
  and parameter values are stripped of PowerShell metacharacters. The client
  can no longer submit arbitrary PowerShell.
- Removed the unused `/api/run-raw` endpoint (arbitrary-command execution
  surface with only blocklist protection).

### Changed — reliability
- **Job queue.** All session commands now flow through a FIFO queue — exactly
  one command in flight on the persistent pwsh session's stdin. Previously,
  concurrent requests (e.g., an entity-cache prefetch overlapping a report)
  could interleave scripts.
- **Structured result envelope.** Report runs capture *all* PowerShell
  streams (`*>&1`): output, error, warning, and information records are
  separated and returned as a JSON envelope
  `{Success, Data, Errors, Warnings, Information}`. Errors no longer vanish
  into the `& { }` wrapper; warnings/info now display in the UI beneath
  results. (Connection/infrastructure commands still use the legacy wrapper
  for compatibility.)

### Changed — SharePoint reports
- "All SharePoint Sites" rewritten as a production command: delegated-auth
  workaround (`sites?search=%20`, single-quoted URI so `$select`/`$top` are
  not interpolated), with `-ErrorVariable` diagnostics that report the
  connected account and whether `Sites.Read.All` is present in the token when
  no results come back.
- "SharePoint Site Search" simplified with the same error-capture pattern.

### Added
- `GET /api/reports` — serves the catalog to the client at boot.
- `scripts/lint-reports.js` (`npm run lint`) — validates every catalog
  command: structure, placeholder/params agreement, `${` interpolation
  hazards, read-only blocklist compliance, and (when pwsh is on PATH) a full
  PowerShell AST parse of every built command.
- Version reported in `/api/health`, startup banner, and the UI footer.
- `CHANGELOG.md`, `PERMISSIONS.md`, `TROUBLESHOOTING.md`.

### Packaging
- Releases are now distributed as gzip-compressed TAR (`.tar.gz`).

## [v10 lettered series] — v10a–v10j
- Rebuilt from the v10 baseline (interactive browser auth) after the device
  code capture approach proved unworkable; retained accumulated fixes:
  - Poll loop checks the `.done` file before the timeout check (race fix).
  - Security Groups / Distribution Lists: `-Property` now includes
    `MailEnabled`/`GroupTypes` used by the filters (previously silently
    returned nothing).
  - User Details: `| Select-Object __FIELDS__` appended so the field selector
    matches the returned columns.
  - Improved dark/light palettes; `Microsoft.Graph.Sites`/`.Files` in session
    init; SharePoint/OneDrive, inbox rules, mailbox permissions, risky users
    reports.
- Iterative SharePoint debugging: `getAllSites` (application-permission-only)
  → `search=*` (invalid) → `search=%20` → double-quote interpolation fix
  (`$select`/`$top` expanded as empty variables) → diagnostic variants with
  try/catch, then `-ErrorVariable`. (Root cause found and fixed in v11.0.0 —
  none of these commands were ever executed.)

## [v11–v16 era, device code detour] — superseded
- Extensive attempts to capture the MSAL device code from the persistent
  session: stdout/stderr watchers, `Start-Transcript`, stream 6 redirection,
  pre-created `.info` files, `/api/job/:id/info` endpoint. Abandoned: MSAL
  writes via .NET `Console.Write()`, bypassing all PowerShell stream capture.
  Reverted to the v10 baseline.

## [v6–v10]
- Sticky header with connection controls; PowerShell Environment as a
  collapsible panel; accordion cards (one open, state preserved); collapsed
  command preview; field selector chips with live preview; results column
  visibility toggles; client-side CSV export via Blob (column-aware);
  "Connect as Current User"; Docker/Azure Container Apps support; light mode.

## [v2–v5]
- Persistent PowerShell session with file-based IPC (`.ps1` in, `.out`/
  `.err`/`.done` back) replacing per-command process spawning — fixed
  "Get-MgUser is not recognized" and kept the Graph connection alive.
- `/api/browse/*` entity endpoints with caching for user/group/license
  pickers; ANSI stripping; account/tenant specification.

## [1.0.0]
- Original release: menu-driven PowerShell script (`M365AdminReports.ps1`)
  with ~30 read-only reports, plus a React reference dashboard. Evolved into
  the Node.js + web UI architecture in v2.
