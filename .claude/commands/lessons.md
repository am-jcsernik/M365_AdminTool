---
description: Search cross-project knowledge for prior art on a topic
argument-hint: <topic>
---
Before solving this here, check whether my OTHER projects already learned something
about this topic.

Topic: "$ARGUMENTS"

1. Read the knowledge digest at `C:\Claude\_knowledge\knowledge-digest.md`. (If this
   project documents a different digest path in CLAUDE.md "Project-specific notes",
   use that instead.)
2. Scan it for entries relevant to the topic -- decisions, notes, gotchas. For
   promising hits, open that project's `docs/DECISIONS.md` (path is listed in the
   digest) and read the full entry.
3. Summarize the prior art: which project(s) hit this before, what they decided,
   what trade-offs they recorded, and what applies to the current situation. Cite
   the project name and ADR heading for each point.
4. If a lesson clearly generalizes beyond one project, suggest promoting it (to my
   curated always-load lessons file or the starter template) -- but do not do the
   promotion yourself.
5. If the digest file is missing, tell me to run `Export-ProjectKnowledge.ps1`
   first, and stop.

Read-only: never modify files in other projects.
