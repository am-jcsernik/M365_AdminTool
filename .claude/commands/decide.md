---
description: Record a decision NOW as an ADR in docs/DECISIONS.md - don't wait for /wrap
argument-hint: [which decision, if not the most recent]
disable-model-invocation: true
---
Record the decision we just made in `docs/DECISIONS.md` immediately, so it
survives even if this session never reaches `/wrap`. My invoking this command is
the authorization to write the log entry.

Arguments passed: "$ARGUMENTS" - if non-empty, they name WHICH decision to
record; if empty, record the most recent decision actually reached in this
conversation. If no decision has been reached, say so and stop - never invent
one, and never promote an open question into a decision.

Steps:
1. Compose the entry ADR-style, matching the file's existing form: dated heading
   (`## YYYY-MM-DD -- ADR-NNNN: <title>`), then Context, Decision, and
   Consequences (including rejected alternatives, with the reason). NNNN is one
   more than the topmost real entry - the template ships its example ADR-0001
   commented out, so a project's FIRST real decision is ADR-0001; do not count
   the commented example.
2. If the decision's wording or rationale is ambiguous - you would have to infer
   what was decided or why - show me the draft and ask instead of guessing. The
   log is append-only: a wrong entry needs a superseding entry, not an edit.
3. Insert the entry at the TOP of `docs/DECISIONS.md` (newest first), touching
   nothing else in the file.
4. Do NOT commit, and do not update STATE or CHANGELOG - that is `/wrap`'s job
   (or `/checkpoint`'s for STATE).
5. Confirm in one line: the ADR number, its title, and that it is recorded. When
   `/wrap` later runs in this session, it must not append this decision again.
