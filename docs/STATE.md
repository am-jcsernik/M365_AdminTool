# Project State
_Last updated: 2026-07-17 -- session 11_

> **Authorization context (read first):** This project administers Jim's *own*
> M365 tenant (`am.consulting`), where he is Director of Technology and authorized
> admin. All `deploy/*.ps1` probes are **read-only, app-only diagnostics** run with
> a consented `Exchange.ManageAsApp` permission against the owner's tenant.
> Message-trace / mailbox / DL / inbox-rule enumeration are **standard Exchange
> Online admin reports**, not recon. `probe-*` filenames and "scan mailboxes"
> phrasing describe ordinary administrative field inspection. Treat as routine EXO
> tooling — don't re-derive a threat model from surface wording.

## Current goal
**App-only Exchange — ADR-0011 COMPLETE (v12.1.7, shipped session 10).** The
`ExchangeOnlineManagement` module is fully out of the path: the Exchange connect
mints an app-only token for `outlook.office365.com` (client-assertion signed with
the KV cert) and calls the EXO REST admin API (`adminapi InvokeCommand`) directly
via two session-global helpers (`Get-ExoRestToken`, `Invoke-ExoRest`). **Every
Exchange report now runs app-only over `Invoke-ExoRest`** — phase 1 (shared-mailboxes,
mail-forwarding, mailbox-sizes, user-mailbox), phase 2 (dl-members, user-inbox-rules,
all-forwarding-rules, mailbox-permissions), and phase 3 (message-trace,
message-trace-detail) — each validated end-to-end in the live container against real
data. No Exchange report remains on the module.

## Status
- [x] **Perf batching SHIPPED (v12.2.0, session 11) — live on rev `--0000012`.**
      New session-global helper `Invoke-ExoRestBatch` in `tenants.js`
      `buildExchangeAppOnlyConnect` fans one EXO cmdlet across many identities via
      `ForEach-Object -Parallel` (default `-ThrottleLimit 8`), reusing one
      pre-minted token, with `Retry-After` backoff on 429/5xx. Placed in the
      connect script (not a report command) because the report blocklist forbids
      `Invoke-RestMethod` and `-Parallel` runspaces don't inherit the global
      `Invoke-ExoRest`/token. `reports.js` `all-forwarding-rules` and
      `mailbox-sizes` rewritten to collect identities then call the batch helper;
      shaping stays in the parent (so `$clean` doesn't cross a runspace). Also
      fixed a silent-drop: `all-forwarding-rules` no longer `catch{continue}`s —
      per-mailbox failures surface as a `(scan failed)` row. Tests 22/22, lint
      (incl. PS AST) + lint:copy green. **Validated live in-container**
      (`deploy/validate-perf-batch.ps1`): 107 mailboxes, sample 20 serial 35.0s →
      parallel 8.5s (4.1×); full mailbox-sizes 31.4s (107/107, 0 err), full
      all-forwarding-rules 40.1s (352 rules, 28 fwd hits, 0 err). No 429s at
      throttle 8; both reports now finish <1min vs. ~3min serial.
- [x] **Phase 3 SHIPPED (v12.1.7, session 10) — ADR-0011 complete.** Transport probe
      (`deploy/probe-messagetrace.ps1`) proved `Get-MessageTraceV2`/`Get-MessageTraceDetailV2`
      run over the same `adminapi InvokeCommand` surface (the "separate reporting API"
      assumption was wrong). `reports.js` `message-trace`/`message-trace-detail` rewritten
      onto `Invoke-ExoRest` (ISO dates, ResultSize 5000, detail chains off row
      MessageTraceId+RecipientAddress); legacy V1 fallback dropped. Added a `requireAny`
      report gate (schema + `index.html`) so Message Trace can't run wide open — Run stays
      disabled until ≥1 filter is set. Validated end-to-end (`deploy/validate-messagetrace.ps1`).
      Tests 22/22, lint (incl. PS AST) + lint:copy green.
- [x] **Direct-REST rewrite — phase 2 SHIPPED (v12.1.6, session 9).** `reports.js`
      `dl-members`, `user-inbox-rules`, `all-forwarding-rules`, `mailbox-permissions`
      migrated off the broken module cmdlets onto `Invoke-ExoRest`. Field shapes
      probed first (`deploy/inspect-exo-phase2-fields.ps1`): DG Guid/Identity are
      strings; InboxRule Forward/Redirect are `"Name" [EX:…]` display strings (report
      extracts the quoted name); MailboxPermission `Deny` is the string `"False"`/`"True"`
      (Deny ACEs excluded). Validated end-to-end (`deploy/validate-exo-phase2.ps1`, 55
      DLs / 107 mailboxes). Tests 22/22, lint + lint:copy green.
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
- [x] **Direct-REST rewrite — phase 1 SHIPPED (v12.1.5).** `tenants.js`
      `buildExchangeAppOnlyConnect` rewritten to define `Get-ExoRestToken` +
      `Invoke-ExoRest` (session-global) and verify with `Get-OrganizationConfig`;
      `reports.js` phase-1 reports (shared-mailboxes, mail-forwarding, mailbox-sizes,
      user-mailbox) rewritten onto `Invoke-ExoRest`. Tests 22/22, both lints green.
      Validated in-container (deploy/validate-exo-reports.ps1) and deployed.
- [x] **Committed.** Session 7's v12.1.4 code is committed on `main` @ `4870eaf`.

## NEXT SESSION should start by
ADR-0011 is done and fully verified; no Exchange-migration work remains. Open items:
- **UI click-through CONFIRMED (session 10, Jim).** Message Trace verified working in
  the browser through Easy Auth — the `requireAny` gate and the app-only
  `Invoke-ExoRest` path are proven on the authenticated HTTP path, not just
  in-container. ADR-0011 is closed end-to-end.
- **Perf (v12.2.0 SHIPPED, session 11):** `all-forwarding-rules` and
  `mailbox-sizes` migrated off serial per-mailbox loops onto the parallel
  `Invoke-ExoRestBatch` helper; validated live (4–6× faster, 0 errors, no 429s at
  throttle 8). If future throttling ever appears, lower the helper's default
  `-ThrottleLimit`. Nothing else outstanding on this item.

## Deploy — v12.3.0 LIVE (session 11)
- **URL:** https://m365-admin-reports.calmisland-95b7b76c.eastus2.azurecontainerapps.io
- Image `amm365acr.azurecr.io/m365-admin-reports:12.3.0` (+`latest`), rev
  **`m365-admin-reports--0000013`**, RunningAtMaxScale, 100% traffic.
  RG `rg-m365admin`, eastus2. min 0 / max 1.
- **Live confirm still to do (Jim, in-browser):** open `/api/config` (or the
  admin UI) and check `me.adminVia` includes `global-admin-role` -- proves Easy
  Auth forwards the `wids` claim and the Global-Admin path fires. Additive change,
  so no lockout risk if it doesn't (admin-group path still works).
- Quick-roll: `az acr build --no-logs -r amm365acr -t m365-admin-reports:<v> -t
  m365-admin-reports:latest .` then `az containerapp update -n m365-admin-reports -g
  rg-m365admin --image …:<v>`.

## Commit status (session 7 — committed)
- All of session 7's v12.1.4 code is committed on `main` @ `4870eaf`
  ("feat: app-only Exchange orgDomain + grant hardening (v12.1.4)"): `server.js`,
  `public/index.html`, `deploy/Grant-ExoAppOnlyRole.ps1`, `package.json`,
  `CHANGELOG.md`, `docs/STATE.md`, `docs/DECISIONS.md`. Working tree clean.
- **Deploy drift (still open):** the deployed rev `0000008` was built BEFORE the
  banner edit, so the live UI still shows the old Exchange banner text; the fix
  lands with the next deploy (the ADR-0011 work will redeploy anyway).

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

## Parked ideas (not scheduled)
- **Message Trace → content drill-through via `Mail.Read`.** Add a per-row "view
  message content" action that pivots from a trace result into the actual body +
  attachments through Graph. Design sketched (session 11): join is
  trace `MessageId` → Graph `internetMessageId` `$filter` → item `id` → `GET
  body`/`attachments`; query the tenant-side mailbox (recipient inbound / sender
  outbound); gate the action to status ∈ {Delivered} (Failed/Quarantined have no
  mailbox item). **Open decision:** containment layer for the tenant-wide
  `Mail.Read` app grant — EXO **RBAC for Applications** (modern, preferred) vs
  **Application Access Policy** vs lean on logging + app-side RBAC. Would be a new
  ADR (follow-on to ADR-0011) before any code. Tabled per Jim, session 11.

## Follow-ups — RESOLVED session 11 (see ADR-0016)
- **Admin lockout / group-overage (v12.3.0):** replaced the planned Graph
  `/memberOf` fallback with a stronger, cheaper fix — Global Admins are tool
  admins via the `wids` claim (independent of `groups`, so it survives group-claim
  breakage). `ADMIN_ROLE_IDS` env extends the qualifying roles. `/api/config`
  echoes `me.adminVia` for live confirmation. The Graph overage fallback is
  intentionally NOT built (unneeded at AM scale).
- **Access group `197dd092` empty:** ratified as optional/intentional — inert in
  the `hasToolAccess` OR; real users gated by role assignments. No code.
- **min-replicas 0 vs 1:** ratified min 0 (cold start ~seconds, certs re-stage
  from KV; zero idle cost). No code.
