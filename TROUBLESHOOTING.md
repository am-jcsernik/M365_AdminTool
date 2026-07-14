# Troubleshooting — M365 Admin Reports

Hard-won lessons from this project's development, plus how to diagnose
problems with the v11 tooling.

## First stops

1. **Debug → Refresh Logs** in the PowerShell Environment panel. Every run
   logs a `[jobId] JOB:` line. If a report shows an error but **no JOB line
   appears**, the server rejected the request before creating a job — the
   card now shows the actual rejection reason (v11).
2. **The result envelope.** As of v11, report runs capture all PowerShell
   streams. Errors, warnings, and information records display beneath the
   results table instead of disappearing.
3. **`npm run lint`** after editing `reports.js`. With PowerShell on PATH it
   also AST-parses every command — catches escaping/syntax breakage before
   runtime.

## Known issues and their causes

### A report says "Job not found" or used to say just "Not found"
Pre-v11, a rejected `/api/run` (403) led the frontend to poll
`/api/job/undefined` and display that endpoint's 404 text — masking the real
reason. The most infamous case: the read-only blocklist matched
`Invoke-MgGraphRequest` (pattern `/\bInvoke-Mg/i`), silently rejecting every
SharePoint report for six debugging iterations. If you see "Job not found" in
v11+, check the server logs for a `REJECTED` line.

### SharePoint reports return no sites
- Run "All SharePoint Sites" — on failure or empty results it now reports
  your account and whether `Sites.Read.All` is in the **token** (not just the
  request). If `HasSitesScope` is `False`: Disconnect, reconnect; if still
  false, the scope needs admin consent (see PERMISSIONS.md).
- Delegated auth lists only sites the signed-in account can access.
  `getAllSites` requires application permissions and is not used.

### OneDrive / SharePoint Usage reports fail
`Reports.Read.All` requires admin consent. Grant it (Entra admin center →
Enterprise applications → Microsoft Graph Command Line Tools → Permissions),
then disconnect/reconnect.

### "Get-MgUser is not recognized" or modules not found
- The persistent session imports modules at startup; if you installed modules
  *after* starting the server, use **Restart Session**.
- **OneDrive-redirected Documents folders:** module path resolution must use
  `[Environment]::GetFolderPath('MyDocuments')`, never `$HOME\Documents`.
  The server's MODULE_PATH_FIX handles this — keep it if you refactor.

### Device code sign-in shows no code in the web UI
By design. MSAL prints the device code via .NET `Console.Write()`, which
bypasses PowerShell streams, `Start-Transcript`, and Node stdout capture —
it cannot be intercepted in this architecture. With the device-code checkbox
enabled, the code appears in the **server console window**. On Windows,
prefer the default interactive browser auth.

### Exchange connect opens a browser then says "return to your application"
Normal — that's the Exchange Online module completing its auth redirect. The
tool's header dot flips to connected once `Connect-ExchangeOnline` returns.

### Message Trace returns "No messages matched" or an ERROR row
Message Trace runs over the **Exchange** connection (connect Exchange first).
Things to check, in order:
- **Window too old / too wide.** The live trace only covers roughly the last
  10 days, and each query is limited to a **10-day span**. Requesting a wider
  span is rejected up front with a clear message. Data older than 10 days
  needs `Start-HistoricalSearch`, which is async and not yet wired in (planned
  follow-up).
- **Very recent mail lags.** Messages can take a few minutes to appear in the
  trace, so a query ending "now" may legitimately miss the last message.
- **Filters too tight.** Sender/recipient must match the addresses exactly as
  stamped on the message (the sanitizer strips quotes/`;`/`$` etc., so an
  address containing those characters won't match — this is by design).
- **Permission.** The connected account needs an Exchange role that includes
  the **Message Tracking** management role (Organization Management and
  Compliance Management have it; a bare View-Only role may not). A permission
  failure surfaces as an ERROR row with the underlying message.
- **Which cmdlet ran** is shown in the "No messages" row (`Get-MessageTraceV2`
  vs `Get-MessageTrace`). V2 needs Exchange Online module 3.7.0+; the tool
  probes for it and falls back to V1 automatically.
- **Throttling.** Microsoft caps message-trace queries at ~100 requests per
  tenant per 5-minute window; heavy back-to-back runs can be throttled
  (surfaces as an ERROR row).

### Message Trace drill-down shows an error when a row is expanded
Expanding a Message Trace row runs **Message Trace Detail**
(`Get-MessageTraceDetailV2`, falling back to `Get-MessageTraceDetail`) for that
row's Message-Trace-ID and recipient. It needs the Exchange connection and a
valid ID within the same ~10-day live window. Rows without a Message-Trace-ID
(the "no messages" and "results capped" notice rows) are intentionally not
expandable.

### Distribution List Members: "object '…' couldn't be found"
Fixed in v11.10.0. The picker used to pass the Graph **display name** as the
Exchange `-Identity`; lists whose display name differs from their Exchange
name/alias (e.g. "Staff PH") couldn't be resolved. The picker now passes the
primary SMTP address, and the report resolves defensively (identity → display-
name filter) and expands by object GUID. If a list still can't be resolved you
will get a clear ERROR row — usual causes: it's a **dynamic** distribution
group (use a different mechanism — `Get-DynamicDistributionGroupMember`, not
yet a report) or a **mail-enabled security group** (not a classic DL). An
empty list returns a "No members" row rather than a blank result.

### Reports return columns that were deselected / empty result sets
Two historical bug classes, both fixed but worth knowing when adding reports:
- Graph `-Property` must explicitly request every field a later filter or
  select uses. Filtering on `MailEnabled` without requesting it silently
  yields nothing (the property is `$null` on every object).
- Field selection requires piping `| Select-Object __FIELDS__`; `-Property`
  alone controls what's *fetched*, not what's *returned*.

## Writing new report commands (rules that keep you out of trouble)

- Commands live in `reports.js` **on the server** — never in the frontend.
- Use **single-quoted** PowerShell strings for Graph URIs so `$select`/`$top`
  aren't interpolated as (empty) variables.
- For `Invoke-MgGraphRequest` (and any cmdlet that can return an HTTP error),
  **wrap it in `try { … } catch { $err = $_.Exception.Message }`** and branch
  on `$err`. HTTP failures are *terminating* errors, so
  `-ErrorAction SilentlyContinue -ErrorVariable x` will NOT capture them and
  the whole job dies (see the v11.7.0 SharePoint fix below). For genuinely
  non-terminating warnings, letting the v11 envelope capture the error stream
  is still fine.
- Avoid `${` anywhere in a command (JS template-literal interpolation hazard
  in `reports.js`) — the linter flags it.
- `Write-Host` output goes to the Information stream; the v11 envelope
  captures and displays it, but pipeline objects are what become the results
  table.
- Mutating cmdlets are rejected by `isSafe()`; `Invoke-MgGraphRequest` must
  specify `-Method GET`.

### Exchange connect: "Method not found ... WithBroker(BrokerOptions)"
MSAL assembly conflict. Both the Graph SDK and ExchangeOnlineManagement load
Microsoft.Identity.Client into the one shared session; .NET keeps whichever
loaded first, and EXO 3.7.x's broker (WAM) path calls an overload the Graph
SDK's MSAL doesn't have. v11.2 mitigations, in order:
1. The tool now passes `-DisableWAM` automatically (EXO 3.7+), avoiding the
   broker path.
2. If it still fails: **Restart Session**, connect **Exchange first**, then
   Graph (first module in wins).
3. Permanent fix: update both modules in an elevated PowerShell —
   `Update-Module ExchangeOnlineManagement -Force` and
   `Update-Module Microsoft.Graph -Force` — then restart the server.

### Usage reports show blank Site / User names
Two distinct causes, distinguishable by whether OneDrive usage shows names:
1. **OneDrive names ALSO blank** → the tenant privacy setting "Display
   concealed user, group, and site names in all reports" is on. Fix:
   Microsoft 365 admin center → Settings → Org settings → Services →
   **Reports** → uncheck it.
2. **OneDrive names visible but SharePoint Site names blank** → this is the
   long-standing Microsoft gap: the SharePoint site usage detail report's
   "Site URL"/"Owner Display Name" columns stopped being populated in 2019
   (a privacy change never fully reverted for this specific report),
   regardless of the tenant setting. As of v11.4 the tool works around it:
   the report joins the usage CSV's Site Id against the Microsoft Search
   API site list and resolves Site name and URL itself. Sites shown as
   "(unresolved)" exist in the usage data but weren't returned by Search
   (typically deleted-but-retained sites, or beyond the 500-site page).
   Note the Search API runs with DELEGATED permissions — it returns only
   sites the signed-in account can access. Global Admin does NOT confer
   site-level access in SharePoint: GA can *grant* itself access via the
   admin center, but is not in site permissions by default, so Search
   permission-trims those sites away. As of v11.5.1 the report additionally
   tries a direct `GET /sites/{id}` for up to 40 unresolved rows, which
   recovers sites that Search missed; sites the account truly cannot read
   remain "(unresolved)". To resolve everything, add the account as Site
   Collection Administrator (or accept the ID-only rows).

### All SharePoint Sites returns an ERROR row
The report uses `POST /search/query` (Microsoft Search API) with delegated
auth. An ERROR row shows the Graph message plus whether `Sites.Read.All` is
in the token. BadRequest here would indicate the Search API rejected the
query; AccessDenied means consent. Note the Search API returns at most 500
sites per page — a truncation marker row appears if there are more.
InternalServerError (HTTP 500) from the Search API is usually transient; the
report now retries once automatically before surfacing the diagnostic row.

### A whole SharePoint/OneDrive report fails instead of showing a diagnostic (v11.7.0)
Symptom (pre-11.7.0): "All SharePoint Sites" died with
`InternalServerError`, "SharePoint Site Usage" died with `Forbidden`, and the
graceful ERROR/`(unresolved)` rows never appeared.

Cause: `Invoke-MgGraphRequest` raises HTTP failures (500, 403, …) as
**terminating** errors. `-ErrorAction SilentlyContinue -ErrorVariable` only
suppresses *non-terminating* errors, so the exception was never captured in
the `$spErr`/`$sErr` variable the report checked. It propagated up to the
structured envelope's `try/catch` and failed the entire job. The persistent
session sets `$ErrorActionPreference = 'Stop'`, which makes this the default
behavior for everything in the session.

Rule: **guard every `Invoke-MgGraphRequest` with `try { … } catch { … }`** —
do not rely on `-ErrorAction SilentlyContinue -ErrorVariable` to catch Graph
HTTP errors. This is why a 403 on one inaccessible site (per-site GET
fallback) now leaves that row `(unresolved)` rather than aborting the run.
The same guard was applied to Site Search and OneDrive Usage.

## Network / binding

v11 binds `127.0.0.1` by default. If you intentionally need LAN access, set
`HOST=0.0.0.0` — and understand that anyone who can reach the port can drive
a PowerShell session that may hold your authenticated Graph token. Docker
sets this automatically inside the container; publish the port thoughtfully.
