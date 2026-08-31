---
description: Re-read project rules and commands after starter-kit or CLAUDE.md updates
disable-model-invocation: true
---
I have updated this project's starter files (CLAUDE.md, .claude/commands/, or the
docs templates) since this session started -- likely via Sync-ProjectCommands.ps1
or a kit upgrade. Get acquainted with the current state:

1. Re-read `CLAUDE.md` from disk. Treat THIS read as authoritative: wherever it
   differs from the version loaded at session start, the on-disk version wins
   for the rest of this session.
2. List the files in `.claude/commands/` and read each one's frontmatter
   (description, argument-hint). Note any commands that are new or changed
   relative to what you believed was available.
3. Re-read `docs/STATE.md` so current status is fresh.
4. Reply with a short summary: (a) rule changes that affect how you work in
   this session, (b) the current command roster, one line each, and (c) anything
   in the updated files that CONFLICTS with instructions given earlier in this
   session -- flag those explicitly rather than silently picking one.

Do not modify any files. This is a read-and-realign step only.
