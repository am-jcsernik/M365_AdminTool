# Decision Log

Append-only. Newest entries at the top. ADR-style: each decision dated, with
context, the decision itself, and consequences/trade-offs.

---

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
