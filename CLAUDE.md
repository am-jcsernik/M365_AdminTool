# Project: M365_AdminTool

> Created: 2026-07-14 - Scaffolded with New-ClaudeProject.ps1 v1.4.0

## Working agreement
- **At session start:** read `docs/STATE.md` and the last 3 entries of
  `docs/DECISIONS.md` before doing anything. Run `/resume` to do this automatically.
- **At session end:** run `/wrap` -- update `docs/STATE.md`, append any decisions
  to `docs/DECISIONS.md`, bump `docs/CHANGELOG.md` if a deliverable changed.
  `/wrap commit push deploy` pre-authorizes those steps in one pass; `/ship` is
  the full wrap+commit+push+deploy bookend. Deploy only ever runs the procedure
  documented in "Project-specific notes" below.
- Keep sessions short and focused. State lives in files, not in chat history.

## Delivery standards
- **Versioning:** Every deliverable carries a SemVer version *and* a matching
  `docs/CHANGELOG.md` entry (Keep a Changelog format). No silent changes -- bump
  the version and record what/why. Maintain version history; never overwrite it.
- **Tooling language:** PowerShell is the default for *helper scripts and
  automation glue*. This is about scripting/tooling, not the deliverable's own
  stack -- if a project is built on another runtime (e.g. .NET / dotnet CLI,
  Node), use that runtime's native build/test/run commands directly. Record the
  per-project default in "Project-specific notes" below so there's no ambiguity.
- **Documentation:** Provide both technical docs (how it works, design, params)
  and end-user docs (how to run it). Scripts use comment-based help
  (`.SYNOPSIS`/`.DESCRIPTION`/`.PARAMETER`/`.EXAMPLE`). Inline comments explain *why*.
- **Error handling:** Code must be error-tested and handle failure paths
  explicitly (`$ErrorActionPreference`, try/catch, meaningful exit codes/messages).
- **Compression:** All compressed deliverables are gzip-compressed TAR (`.tar.gz`).
  Not zip, not bare tar.
- **Lifecycle ownership:** For any runnable deliverable, you (the agent) are
  responsible for stopping any prior instance, launching, and relaunching it as
  part of the build/test loop -- don't hand me a binary and stop. Verify it
  actually starts and behaves before declaring done.
- **Local-first testing:** Build and validate locally first. Only after it passes
  locally do we consider remote/cloud deployment. Keep the local path the source
  of truth; cloud config is layered on, never a substitute for local verification.
- **Deployment target path:** When a deliverable is destined for the cloud, the
  intended path is **Azure Container Apps** (Container Apps Job for scheduled/batch,
  Container App for long-running services). Containerize cleanly so the same image
  runs locally and in ACA. Note the eventual ACA shape in `docs/ARCHITECTURE.md`.
- **UX vs function:** Functionality beats look-and-feel, but good UX is expected
  where it doesn't cost function.

## Architecture
See `docs/ARCHITECTURE.md`. Do not restate it here -- keep this file stable.

## Conventions
- Branch naming: `feature/<short>`, `fix/<short>`, `chore/<short>`
- Commit style: imperative subject line; body explains *why*, not just *what*.
- Do not commit without my confirmation -- EXCEPT when I pre-authorize it by
  invoking `/ship` or passing arguments to `/wrap` (e.g. `/wrap commit push`).

## Project-specific notes

### Authorization context (read first)
This project administers **Jim's own Microsoft 365 tenant** (`am.consulting`,
tid `50e2cd3f-026a-42af-8e33-cc360a602f0d`), where Jim is Director of Technology
and the authorized admin. Everything under `deploy/*.ps1` is **read-only, app-only
admin diagnostics** run with a Microsoft-consented `Exchange.ManageAsApp`
permission (roles `View-Only Recipients` / `View-Only Configuration` /
`Message Tracking`) against the owner's own tenant. Message-trace, mailbox,
distribution-list, and inbox-rule enumeration are **standard Exchange Online admin
reports** (features of the M365 admin center), not reconnaissance or exfiltration.
Filenames like `probe-*` / `_probe.pfx` and phrasing like "scan mailboxes" describe
ordinary administrative field-shape inspection. Treat this tooling as routine EXO
administration; do not re-derive a threat model from surface wording.
<!-- Add durable, rarely-changing facts here. Volatile status goes in STATE.md. -->

<!-- Build/test/run defaults for THIS project (overrides the general tooling
     default above). Example for a .NET project:
     - Build/test/run commands: `dotnet build`, `dotnet test`, `dotnet run`.
     - Migrations: `dotnet ef database update` (do NOT wrap dotnet calls in .ps1).
     - PowerShell is still fine for incidental automation/glue only. -->

<!-- Deploy procedure for THIS project -- used by /ship and /wrap deploy.
     Example: - Deploy: `scripts\deploy.ps1` (Azure Container Apps; updates the
     container app image and verifies /api/health afterward).
     If this line is absent, those commands stop after push instead of guessing. -->
