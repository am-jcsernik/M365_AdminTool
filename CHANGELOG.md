# Changelog — M365 Admin Reports

All notable changes to this project. Versioning follows semver as of v11.0.0;
earlier versions were sequential build numbers with letter-suffixed patch
iterations (e.g., v10f).

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
