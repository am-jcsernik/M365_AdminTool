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
   (ADR-style); update `docs/CHANGELOG.md` / bump SemVer if a deliverable changed.
2. COMMIT: stage everything; imperative subject, body explains why.
3. PUSH: push the current branch to its remote, setting upstream if needed.
4. DEPLOY: run the deploy procedure documented in CLAUDE.md "Project-specific
   notes" (e.g. `scripts\deploy.ps1` or an `az containerapp` command). Skip this
   step and say so if "$ARGUMENTS" contains "skip-deploy" OR no deploy procedure
   is documented - never improvise a deploy method.
5. SUMMARY: report docs updated, commit hash, push result, deploy result.
