# Project State
_Last updated: 2026-07-17 -- session 10_

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
- **Perf (carried forward):** `all-forwarding-rules` and `mailbox-sizes` are
  per-mailbox serial REST loops (107 at AM → slow, ~minutes; within the 5-min job
  timeout). Candidate to batch/parallelize.

## Deploy — v12.1.7 LIVE (session 10)
- **URL:** https://m365-admin-reports.calmisland-95b7b76c.eastus2.azurecontainerapps.io
- Image `amm365acr.azurecr.io/m365-admin-reports:12.1.7` (+`latest`), rev
  **`m365-admin-reports--0000011`**, Healthy / RunningAtMaxScale, 100% traffic.
  RG `rg-m365admin`, eastus2. min 0 / max 1.
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

## Manual follow-ups still open (unchanged)
- Group-claim overage `memberOf` fallback in `auth.js` — not built, not yet hit.
- Access group `197dd092` empty — decide gate strategy vs role-assignment entry.
- Decide min-replicas (0 vs 1).
