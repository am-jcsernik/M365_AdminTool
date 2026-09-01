---
description: Full ship - wrap docs, commit, push, and deploy in one authorized pass
argument-hint: [skip-deploy]
disable-model-invocation: true
---
Ship this session's work end-to-end. By invoking this command I have explicitly
authorized every step below - do not re-ask for confirmation between steps, but
STOP immediately on any failure and report what happened.

1. WRAP: update `docs/STATE.md` (date, session number, goal, status, active
   context, next-session list); append decisions to `docs/DECISIONS.md`
   (ADR-style); update `docs/CHANGELOG.md` / bump SemVer if a deliverable changed;
   update `docs/ARCHITECTURE.md` if this session changed the system's shape
   (components, data flow, external dependencies, deploy shape) -- no other
   step writes it, so drift there is silent.
2. COMMIT: stage everything; imperative subject, body explains why.
3. PUSH: push the current branch to its remote, setting upstream if needed.
4. DEPLOY: run the deploy procedure documented in CLAUDE.md "Project-specific
   notes" (e.g. `scripts\deploy.ps1` or an `az containerapp` command). Skip this
   step and say so if "$ARGUMENTS" contains "skip-deploy" OR no deploy procedure
   is documented - never improvise a deploy method.
   (Deliberately different from /wrap deploy, which STOPS after the push and
   asks in the no-procedure case: there "deploy" named that step explicitly, so
   the unfulfillable request stops; /ship authorizes everything applicable, and
   on a project with no deploy procedure nothing is -- skipping loudly beats
   asking a question with only one answer every session.)
5. RECORD THE DEPLOY: update the `## Deployment` section of `docs/STATE.md` with
   the version, target, timestamp, and how the deploy was verified - then commit
   that change on its own with the subject `docs: record deploy of vX`.
   - This is a SECOND commit, deliberately. Steps 1-3 necessarily run BEFORE the
     deploy, so the wrap commit cannot contain the deploy outcome. Committing
     after deploying is the only ordering that is both accurate and honest:
     deploying before committing would leave deployed bits with no commit behind
     them, and amending plus force-pushing would rewrite published history to
     record something that happened after it.
   - If `docs/STATE.md` has no `## Deployment` section, CREATE it. Projects
     scaffolded before this was added to the template will not have one, and
     Sync-ProjectCommands only syncs `.claude/commands/`, never `docs/`. Use the
     same four fields: version deployed, target, timestamp, verified by.
   - If step 4 was SKIPPED, skip this step too and leave the section untouched.
   - If step 4 FAILED, record the failure and its timestamp here anyway. A stale
     "deployed" entry is worse than a recorded failure.
   - Never write a timestamp for a deploy you did not observe succeed.
6. SUMMARY: report docs updated, commit hash, push result, deploy result, and the
   hash of the deploy-record commit from step 5.
