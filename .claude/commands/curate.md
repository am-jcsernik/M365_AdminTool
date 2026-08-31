---
description: Interactively curate the cross-project knowledge digest into lean lessons
argument-hint: [path-to-brief-or-digest]
disable-model-invocation: true
---
Run an INTERACTIVE curation session over my cross-project knowledge. Do not skip
the question phase and jump to output.

Source: if "$ARGUMENTS" is a file path, read that. Otherwise read
`C:\Claude\_knowledge\curation-brief.md`; if that does not exist, fall back to
`C:\Claude\_knowledge\knowledge-digest.md`. If neither exists, tell me to run
`Export-ProjectKnowledge.ps1 -IncludeBodies -CurationBrief` first, and stop.

If the file contains an embedded "Curation brief" preamble, follow that protocol
exactly. If it is a bare digest, apply this protocol:

1. FIRST REPLY: findings summary only -- themes, duplicate clusters (same lesson
   learned in multiple projects), stale/superseded candidates, counts. No output
   files yet.
2. THEN: ask decision questions in small numbered batches (max 5 per reply) and
   wait for my answers: which phrasing wins per duplicate cluster; promote
   globally vs keep project-local; archive vs drop; where curated output lives.
3. ONLY AFTER the Q&A: produce (a) a lean always-load `lessons.md` (target:
   roughly under 50 lines, only lessons that generalize, each citing source
   project + ADR), (b) `archive.md` for reference-worthy items, and
   (c) `cleanup-recommendations.md` with per-project suggested edits.

Rules: never invent or embellish -- only restructure what is in the source;
preserve exact technical details verbatim; when unsure if two entries are the
same lesson, ask; never modify source project files -- write outputs only to the
location I choose during the Q&A.
