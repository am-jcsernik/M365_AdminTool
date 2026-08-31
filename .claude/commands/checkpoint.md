---
description: Mid-session checkpoint - refresh docs/STATE.md without closing the session
disable-model-invocation: true
---
Checkpoint this session: bring `docs/STATE.md` up to date NOW so an interruption
loses nothing, then keep working. This is `/wrap`'s step 1 alone - no CHANGELOG,
no version bump, no commit, no deploy, and the session stays open.

Steps:
1. Update `docs/STATE.md`: bump the "Last updated" date; mark the current
   session IN PROGRESS (checkpointed), never closed; refresh Current goal,
   Status (done / in progress / next), and Active context (files in flight, key
   facts a resuming session would need); write a concrete "if interrupted,
   resume by" list.
2. Do NOT touch `docs/DECISIONS.md` here - decisions are recorded with
   `/decide`. If an unrecorded decision surfaced this session, say so in your
   reply rather than silently folding it into the narrative.
3. Do NOT commit, push, deploy, or touch `docs/CHANGELOG.md`.
4. Confirm in one line what was checkpointed, then continue the session. `/wrap`
   still runs at session end and supersedes this checkpoint's narrative.
