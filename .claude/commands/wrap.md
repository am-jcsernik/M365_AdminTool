---
description: End-of-session wrap - update STATE/DECISIONS/CHANGELOG; optional commit/push/deploy via arguments
argument-hint: [commit] [push] [deploy]
disable-model-invocation: true
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
  (Deliberately different from /ship, which SKIPS the deploy step loudly in the
  same situation: passing "deploy" here names that step explicitly, so an
  unfulfillable explicit request stops and asks; /ship authorizes everything
  applicable, and on a project with no deploy procedure nothing is.)

Steps:
1. Update `docs/STATE.md`: bump the "Last updated" date and session number;
   refresh Current goal, Status (done / in progress / next), and Active context
   (files in flight, key facts the next session needs); write a concrete
   "Next session should start by" list.
2. Append any architectural or trade-off decisions made this session to
   `docs/DECISIONS.md` (dated, ADR-style, newest at top, next ADR number).
   The template ships its example ADR-0001 commented out, so a project's FIRST
   real decision is **ADR-0001** -- do not count the commented example.
   Skip any decision already recorded this session via `/decide` -- check the
   top of the log before appending; a duplicate entry is worse than none.
3. If a deliverable changed, add/extend a `docs/CHANGELOG.md` entry under
   [Unreleased] and bump the version per SemVer when appropriate.
4. If this session changed the system's SHAPE (components, data flow, external
   dependencies, deploy shape), update `docs/ARCHITECTURE.md` to match;
   otherwise leave it untouched. It is read at session start and no other step
   writes it, so drift here is silent and compounds.
5. If NO arguments were given: propose a git commit message and WAIT for my
   confirmation before committing; do not push or deploy.
6. If arguments authorize it: perform commit / push / deploy as granted above,
   stopping immediately on any failure, and report each step's result.
7. If a deploy ran in step 6: update the `## Deployment` section of
   `docs/STATE.md` (version, target, timestamp, how it was verified) and commit
   that on its own with the subject `docs: record deploy of vX`.
   - This is a SECOND commit, deliberately. Steps 1-4 run BEFORE the deploy, so
     the wrap commit cannot contain its outcome. Committing after deploying is
     the only accurate ordering: deploying before committing leaves deployed bits
     with no commit behind them, and amend-plus-force-push rewrites published
     history to record something that happened after it.
   - If `docs/STATE.md` has no `## Deployment` section, CREATE it. Projects
     scaffolded before this was added to the template will not have one, and
     Sync-ProjectCommands only syncs `.claude/commands/`, never `docs/`. Use the
     same four fields: version deployed, target, timestamp, verified by.
   - If the deploy FAILED, record the failure and its timestamp anyway. A stale
     "deployed" entry is worse than a recorded failure.
   - Never write a timestamp for a deploy you did not observe succeed.
