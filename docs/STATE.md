# Project State
_Last updated: 2026-07-16 -- session 7_

## Current goal
**App-only Exchange.** Shipped **v12.1.4** (deployed) with the `orgDomain` fix +
hardened grant script, ran the EXO role grant, then chased why Exchange **reports**
still 401'd. Root cause found and proven: **not Azure/RBAC — the
`ExchangeOnlineManagement` module (3.7.2) in the container is broken for app-only
REST cmdlets** on PowerShell 7.5/.NET. Decision (ADR-0011): **bypass the module and
call the EXO REST API (`adminapi`) directly.** That rewrite is **deferred to the next
session** (wrapped here by request).

## Status
- [x] **v12.1.4 shipped + deployed.** Per-tenant `orgDomain` (server whitelist +
      entry, admin table/form, connect resolution `req.body.org → orgDomain →
      tenantId`); Exchange connect banner now app-only-aware in `DOCKER_MODE`;
      grant script hardened (role-list, StrictMode, `-Device`). Tests 22/22, lint +
      lint:copy + Babel all green. Live on ACA rev **`m365-admin-reports--0000008`**.
- [x] **EXO role grant done.** App SP registered in Exchange Online + assigned
      `View-Only Recipients`, `View-Only Configuration`, `Message Tracking`
      (Enabled=True). Also added **Global Reader** Entra role as a fallback.
- [x] **`orgDomain=am.consulting` set on the AM tenant** (live, via admin UI). App-only
      Exchange **connect** verified working (`-Organization am.consulting`, token Active).
- [x] **Root cause proven (ADR-0011).** In-container test: app-only token is correct
      (`roles=Exchange.ManageAsApp`); **raw `adminapi/.../Mailbox` → HTTP 200**, but the
      **module's `Get-EXOMailbox` → 401** + `.NET GetResponseHeader` bug. AuthZ/permissions
      are fine; the module masked every prior test (the app always uses the module).
- [ ] **Direct-REST rewrite — NEXT SESSION.** See below.
- [ ] **Uncommitted.** All of session 7's code is uncommitted (see below).

## NEXT SESSION should start by
Implement **ADR-0011: bypass the EXO module with direct `adminapi` REST calls.**
- **Mechanism:** Connect mints + caches an app-only token for `outlook.office365.com`
  (client-assertion with the KV cert — proven flow) in the session
  (`$global:ExoToken`/`$ExoTid`), replacing `Connect-ExchangeOnline`; re-mint on ~1h
  expiry. Each Exchange report swaps its `Get-EXO*` cmdlet for `Invoke-RestMethod`
  against `adminapi/beta/{tid}/...` with OData `$filter`/`$select`, shaped to the same
  columns. Touches `tenants.js` (buildExchangeAppOnlyConnect), `server.js`
  (/api/connect/exchange), `reports.js` (the 8 `ex:true` reports), maybe `sessions.js`.
- **Phasing (agreed):** (1) mailbox reports — shared-mailboxes, mail-forwarding,
  mailbox-sizes, user-mailbox → `Mailbox` + `MailboxStatistics` (easy, proven 200);
  (2) dl-members + user-inbox-rules → adminapi DistributionGroup/InboxRule (verify
  endpoints); (3) message-trace(-detail) → SEPARATE reporting API, meatier — likely its
  own iteration. Recommend: prove **shared-mailboxes** end-to-end in the container first.
- **Validate** each in the deployed container via the exec/REST technique below, then a
  real report run in the UI. Bump version, changelog, redeploy.

## Deploy — v12.1.4 LIVE (session 7)
- **URL:** https://m365-admin-reports.calmisland-95b7b76c.eastus2.azurecontainerapps.io
- Image `amm365acr.azurecr.io/m365-admin-reports:12.1.4` (+`latest`), rev
  **`m365-admin-reports--0000008`**, Healthy, 100% traffic, 0 restarts. RG
  `rg-m365admin`, eastus2. min 0 / max 1.
- Quick-roll: `az acr build --no-logs -r amm365acr -t m365-admin-reports:<v> -t
  m365-admin-reports:latest .` then `az containerapp update -n m365-admin-reports -g
  rg-m365admin --image …:<v>`.

## Uncommitted changes (session 7 — awaiting commit)
- `server.js` (orgDomain whitelist/entry + connect resolution), `public/index.html`
  (orgDomain admin field + Exchange banner `appOnly`), `deploy/Grant-ExoAppOnlyRole.ps1`
  (role-list/StrictMode/`-Device`), `package.json` (12.1.4), `CHANGELOG.md`, `docs/*`.
- **Note:** the deployed rev `0000008` was built BEFORE the banner edit, so the live UI
  still shows the old Exchange banner text; the fix lands with the next deploy.
- Pre-existing uncommitted (from before session 7): `CHANGELOG.md`, `deploy/Grant-…`,
  `package.json`, `public/index.html`, `server.js` were already modified at session start.

## Azure config that IS correct — leave alone
- App `Exchange.ManageAsApp` consented; EXO SP registered (AppId 25407385… ↔ objectId
  dea11da4…); management roles assigned + Enabled; Global Reader assigned; no CA block;
  `orgDomain=am.consulting` on AM tenant. All verified. The ONLY remaining problem is
  the module — fix is code (direct REST), not Azure.

## Diagnostic technique (reusable)
- Run app-only EXO **inside the live container** via `az containerapp exec` (its managed
  identity can read the KV cert; `jcsernik-adm` canNOT read amm365kv secrets data-plane).
- exec command path 404s if too long — keep `pwsh -EncodedCommand <UTF16LE-b64>` under
  ~1550 chars; many rapid exec calls → HTTP 429 (retry-after 600s). For longer scripts,
  upload to the Azure Files share `m365data` (mounted `/app/data`; key via
  `az storage account keys list -n amm365data`) and run once with `pwsh -File
  /app/data/x.ps1`, writing results to `/app/data/*.out` to download. minReplicas=0 →
  `/tmp` + staged certs vanish on scale-down.

## Manual follow-ups still open (unchanged)
- Group-claim overage `memberOf` fallback in `auth.js` — not built, not yet hit.
- Access group `197dd092` empty — decide gate strategy vs role-assignment entry.
- Decide min-replicas (0 vs 1).
