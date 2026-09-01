---
description: Session start - read STATE, recent decisions, and git log, then summarize where things stand
---
Read `docs/STATE.md`, the last 3 entries in `docs/DECISIONS.md`, and the output of
`git log --oneline -10`.

Then summarize in 3-4 lines:
- Current goal
- What's in progress / blocked
- The single next concrete action

When reading `docs/STATE.md`, treat its `## Deployment` section as follows: an
absent, undated, or "<none recorded>" entry means the deploy state is UNKNOWN.
It does NOT mean "not deployed". Say "deploy state unknown" and, if it matters
for the next action, check the deploy target before concluding anything shipped
or did not ship. Do not report a negative that the file does not actually assert.
"Check the deploy target" means: run the verification procedure recorded in
CLAUDE.md "Project-specific notes" beside the deploy procedure. If none is
recorded there, the state STAYS unknown and saying so is the correct report --
do not improvise a check at resume time; /wrap and /ship own recording one.

Do not start work yet. Wait for my go-ahead.
