# Project State
_Last updated: 2026-07-14 -- session 1_

## Current goal
Get the M365 Admin Reports app deployable to Azure Container Apps, validated
locally first. (This session: done through local container validation; live
ACA deploy not yet performed.)

## Status
- [x] Promoted the live v11.11.0 app source into this git repo as the tracked
      baseline (it previously existed only as an untracked working copy under
      `C:\Temp\Claude Testing`). Pushed to `origin` (am-jcsernik).
- [x] ACA enablement (v11.12.0): `DATA_DIR` volume support, fixed Dockerfile
      (module-copy bug), `deploy/` artifacts (Bicep + PowerShell + guide),
      ARCHITECTURE.md filled in. Image builds + boots; verified locally.
- [x] Device-code sign-in works in the container (v11.12.1 Graph, v11.12.2
      Exchange): raw passthrough execution mode surfaces the code to the UI.
- [x] Jim confirmed 11.12.2 checks out (Graph connected via device code;
      Exchange fix verified in-container).
- [ ] In progress: nothing mid-flight.
- [ ] Next: decide whether to run the live ACA deploy, or continue the roadmap.

## Active context
- **Versions/artifacts:** app deliverable is **v11.12.2**; see root
  `CHANGELOG.md` (authoritative app changelog) and `deploy/` for ACA artifacts.
- **Two runtimes on this machine:**
  - Jim's native instance on `127.0.0.1:3365` (still **v11.11.0**, tenant-connected
    as `jcsernik-adm@`). I only *promoted* the source; I did not relaunch the
    native app from the repo.
  - A test container from `docker compose` was left running on host port
    **13365** (`HOST_PORT=13365 docker compose up`). `docker compose down` to stop.
- **config.json** is gitignored (tenant list); recreate from
  `config.json.example` if lost.
- **Deploy is artifacts-only so far.** `deploy/Deploy-ToAca.ps1` is runnable but
  NOT executed. A live deploy needs `az login` + subscription + a new Entra app
  registration (Easy Auth) + consent -- all of which require Jim's approval per
  CLAUDE.md ("Human approval required").

## Next session should start by
1. Deciding the next move: (a) live ACA deploy via `deploy/Deploy-ToAca.ps1`
   (run with `-WhatIf` first; requires Jim's approval for the app-reg/consent
   and network exposure), or (b) keep exercising containerized reports, or
   (c) start the next roadmap item.
2. If deploying: confirm subscription, resource-provider registration
   (`Microsoft.App`, `Microsoft.OperationalInsights`), and names (ACR, storage).
3. If not deploying yet: `docker compose down` to stop the 13365 test container.

## Open questions
- **MSAL Graph<->EXO assembly conflict** in one container session: WAM is
  Windows-only so it likely won't bite on Linux, but connecting BOTH Graph and
  Exchange in the same container session is unverified end-to-end. The
  `-DisableWAM` probe + helpful error are in place.
- **App-only certificate auth** is the planned robust successor to device-code
  for unattended cloud use (removes cold-start re-auth + the max-1-replica cap).
- **v12 RBAC** is still required for true multi-user; Easy Auth only gates *who
  reaches the tool*, not per-user authorization (shared admin session).
- Should the native 3365 instance be relaunched from this repo to make the repo
  the single runtime source of truth?
