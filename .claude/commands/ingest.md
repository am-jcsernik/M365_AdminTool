---
description: Ingest a chat handoff bundle (.tar.gz/.zip) or markdown handoff into this project
argument-hint: <path-to-handoff.tar.gz|.zip|.md>
disable-model-invocation: true
---
Ingest a project handed off from a claude.ai chat into THIS project.

Source: "$ARGUMENTS". If no path was given, ask me for one and stop. If the path does
not exist, say so and stop.

Detect the format:
- `.tar.gz` / `.tgz` / `.tar` / `.zip` -> ARCHIVE MODE (produced by the kit's
  Chat-Handoff-Prompt.md or ChatGPT-Migration-Prompt.md; preferred). ChatGPT often
  emits .zip rather than .tar.gz -- both are fine.
- `.md` / anything else text -> MARKDOWN MODE (fallback handoff format)

## Archive mode

### Phase 1a -- inspect WITHOUT extracting into the project
1. List the archive contents first (`tar -tzf` for tar archives, `Expand-Archive`
   listing or equivalent for .zip). Never extract straight into the project directory.
2. REJECT the archive and stop if any entry has an absolute path, contains a `..`
   segment, or is a symlink or device file. Report the offending entries. This is a
   path-traversal guard -- do not work around it.
3. Extract to a temp directory outside the project (e.g. `$env:TEMP\handoff-ingest`).
4. Expect this layout: `handoff/HANDOFF.md`, `handoff/manifest.json`,
   `handoff/files/...`, `handoff/at-risk.md`. If the layout differs, adapt and say
   how you interpreted it.
5. Read `manifest.json`. If `schema_version` is not 1, say so and proceed
   cautiously. Cross-check the manifest against what is actually in `files/`:
   report files listed but missing, and files present but unlisted.

### Phase 1b -- report the plan (no writes into the project yet)
Report:
1. Files to place, with target paths relative to the project root. Flag every file
   that would OVERWRITE something already here, and every file whose manifest
   `status` is `draft` or `incomplete`.
2. Any file containing a `HANDOFF-INCOMPLETE` marker.
3. Contents of `at-risk.md`.
4. From HANDOFF.md: counts and headings for DECISIONS and FAILED-ATTEMPTS, plus the
   STATE, ENVIRONMENT, and GOTCHAS highlights. If a `CHATGPT-CONTEXT` section exists
   (ChatGPT migrations), summarize it and tell me to read it directly -- carried-over
   custom instructions and saved memory often explain otherwise puzzling choices, and
   uploaded files it names may still need supplying.
5. Gaps: missing sections, referenced-but-absent files, dependencies or env vars
   mentioned without definition.
6. Anything resembling a real secret or credential -- name it and recommend it move
   to `.env` (untracked) rather than into source control.

Then ask me to confirm, and ask about anything ambiguous in batches of at most 5
questions. Do not write into the project until I approve.

## Markdown mode
Read the handoff file. Handle both the structured headings (INVENTORY, FILES,
ENVIRONMENT, DECISIONS, FAILED-ATTEMPTS, STATE, GOTCHAS) and loose formats. Then
produce the same Phase 1b report, additionally flagging any file that looks
truncated or elided ("...", "rest unchanged", "same as above"). Same approval gate.

## Phase 2 -- write (only after my approval)
1. Copy the reconstructed files to their agreed paths. Never overwrite an existing
   file without asking about that specific file first. Preserve contents byte-exact:
   do not reformat, "improve", or complete partial code. Leave
   `HANDOFF-INCOMPLETE` markers in place.
2. Append the handoff's decisions to `docs/DECISIONS.md` in this project's ADR style
   (dated, newest at top, ADR numbers continuing from what is already there).
   The template ships its example ADR-0001 commented out, so if this project has
   no real decisions yet the first one is **ADR-0001** -- do not count the
   commented example.
   Preserve original rationale, alternatives, and trade-offs -- do not summarize
   them away.
3. Update `docs/STATE.md`: current goal, status (done / in progress / untested or
   broken), active context, and a concrete "Next session should start by" list from
   the handoff's next steps. Record the ingest date and source archive name. List
   any incomplete or at-risk files as explicit follow-ups.
4. Add durable facts to CLAUDE.md "Project-specific notes": runtime and versions,
   build/test/run commands, deploy target, and the gotchas. Keep the existing
   structure; do not rewrite unrelated sections.
5. Record failed attempts as a "Rejected approaches" note -- ask whether I want it
   in `docs/DECISIONS.md` or `docs/ARCHITECTURE.md`.
6. If the handoff names dependencies, tell me the install commands. Do not install
   anything yourself.
7. Tell me the temp extraction path so I can delete it when satisfied. Never
   delete the source archive unasked -- and if it lives in `_drop/`, end this
   same reply with the transfer-point disposition question: keep it (name the
   destination it would be filed to; filing is a write and needs authorization)
   or discard it. `_drop/` retains nothing by default, so leaving the archive
   there silently is not an option.

## Phase 3 -- summary
Report: files created (and any skipped), ADRs appended, STATE/CLAUDE.md updates,
unresolved gaps and at-risk items, and the recommended first task. Propose a commit
message but do not commit unless I say so.

Rules: never invent content to fill a gap -- flag it and ask; preserve exact
technical details (versions, flags, paths) verbatim; never write real credentials
into tracked files.
