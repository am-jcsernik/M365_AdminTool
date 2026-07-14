---
description: End-of-session wrap - update STATE/DECISIONS/CHANGELOG; optional commit/push/deploy via arguments
argument-hint: [commit] [push] [deploy]
---
Wrap up this session for clean handoff to the next one.

Arguments passed: "$ARGUMENTS"

Treat words in the arguments as explicit, pre-granted authorizations:
- "commit" -> after updating the docs, stage everything and commit (imperative
  subject; body explains why) WITHOUT asking again.
- "push" -> after committing, push the current branch to its remote (set upstream
  if needed). Implies "commit".
- "deploy" -> after pushing, run this project's documented deploy procedure.
  Implies "commit" and "push". The procedure MUST come from CLAUDE.md
  "Project-specific notes" (e.g. a deploy script or az command). If none is
  documented there, STOP after the push and ask - never guess a deploy method.

Steps:
1. Update `docs/STATE.md`: bump the "Last updated" date and session number;
   refresh Current goal, Status (done / in progress / next), and Active context
   (files in flight, key facts the next session needs); write a concrete
   "Next session should start by" list.
2. Append any architectural or trade-off decisions made this session to
   `docs/DECISIONS.md` (dated, ADR-style, newest at top, next ADR number).
3. If a deliverable changed, add/extend a `docs/CHANGELOG.md` entry under
   [Unreleased] and bump the version per SemVer when appropriate.
4. If NO arguments were given: propose a git commit message and WAIT for my
   confirmation before committing; do not push or deploy.
5. If arguments authorize it: perform commit / push / deploy as granted above,
   stopping immediately on any failure, and report each step's result.
