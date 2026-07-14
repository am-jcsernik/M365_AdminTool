# Project State
_Last updated: 2026-07-14 -- session 2_

## Current goal
Ship the M365 Admin Reports app to Azure Container Apps. **Live deploy is now
done and verified** (eastus2). Next is deciding the follow-on roadmap (app-only
cert auth, v12 RBAC) or operational hardening.

## Status
- [x] (session 1) Promoted v11.11.0 source as tracked baseline; ACA enablement
      (v11.12.0); device-code sign-in in-container (v11.12.1 Graph / v11.12.2
      Exchange); local container validation.
- [x] **Live ACA deploy performed and verified** (session 2). App v11.12.2 is live:
      `https://m365-admin-reports.calmisland-95b7b76c.eastus2.azurecontainerapps.io`
- [x] Easy Auth gate verified: browser → 302 to am.consulting login; API → 401.
- [x] **Jim connected inside the ACA instance** (device-code Graph/Exchange) — full
      end-to-end confirmed.
- [x] `deploy/Deploy-ToAca.ps1` hardened (see ADR-0005): `--no-logs`, exit-0 =
      success, `-SkipBuild`, tolerant data-plane tag check.
- [ ] In progress: nothing mid-flight.

## Active context
- **Live infra (eastus2, RG `rg-m365admin`, sub "MCPP Subscription"
  4c373777-…):** Container App `m365-admin-reports` (scale 0/1, Healthy), ACR
  `amm365acr`, storage `amm365data` + Files share `m365data` (`DATA_DIR`),
  Log Analytics `m365-admin-logs`.
- **Easy Auth Entra app reg:** `edb8be95-fddd-4490-a851-ef32c828406f`
  (display name "M365 Admin Reports (Easy Auth)"), issuer
  `https://login.microsoftonline.com/am.consulting/v2.0`, redirect
  `.../.auth/login/aad/callback`. Client secret was minted during deploy.
- **Versions:** app deliverable **v11.12.2** (unchanged this session; app code
  not touched). Deploy tooling changed — see `docs/CHANGELOG.md`.
- **Cold start:** min-replicas 0 → operator re-runs the in-app device-code connect
  on first request after idle. Durable state on the Files share survives.
- **Watch device code:** `az containerapp logs show -g rg-m365admin
  -n m365-admin-reports --follow`.
- **Teardown if ever needed:** `az group delete --name rg-m365admin --yes` then
  `az ad app delete --id edb8be95-fddd-4490-a851-ef32c828406f`.
- **config.json** (tenant list) is gitignored; not uploaded to the share yet
  (tenant picker optional).

## Next session should start by
1. Deciding the follow-on: (a) **app-only certificate auth** (removes cold-start
   re-auth + the max-1-replica cap — the planned successor to device-code), (b)
   **v12 RBAC** for true multi-user authZ, or (c) operational polish (custom
   domain, config.json upload, monitoring/alerts).
2. If touching the deploy again: the local `*.azurecr.io` data-plane read failure
   (`CONNECTIVITY_CHALLENGE_ERROR`) is still unresolved — fine for deploys, but
   worth fixing before relying on local ACR content queries.

## Open questions
- **App-only certificate auth** is the planned robust successor to device-code for
  unattended cloud use (removes cold-start re-auth + the max-1-replica cap).
- **v12 RBAC** still required for true multi-user; Easy Auth only gates *who
  reaches the tool*, not per-user authorization (shared admin session).
- **Local ACR data-plane read** fails from this workstation
  (`CONNECTIVITY_CHALLENGE_ERROR`); root cause (stale token vs. network to
  `*.azurecr.io`) not yet pinned down.
- Should the native 3365 instance be relaunched from this repo to make the repo
  the single runtime source of truth?
