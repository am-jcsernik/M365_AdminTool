---
description: Backfill this project's scope and history into my achievements log
argument-hint: [optional: a period or milestones to cover, e.g. "up to v1.38.0"]
---
Reconstruct THIS project's history for my achievements log -- the running
record of what I work on, used for status updates to management and as
evidence for a promotion or raise case. For a project that predates the log,
or whose early history the log is missing: its original scope, and one dated
entry per milestone from the start to now.

Achievements log clone: `C:\Claude\Achievements`
Arguments: "$ARGUMENTS"

1. **Configured?** If the clone path above is `NOT-CONFIGURED`, STOP and say:
   this kit install names no achievements log; from the kit folder run
   `.\Set-KitOwner.ps1 -AchievementsRoot <path to the clone>`, then
   `.\Sync-ProjectCommands.ps1` for this project. If the path is set but the
   folder, or `tools\Add-Achievement.ps1` inside it, does not exist, STOP and
   say which is missing. Do nothing else in either case.
2. **This project's default.** Look in this project's `CLAUDE.md` for a line
   `Achievements: category=<work|personal> org=<org>`. If there is none, ask me
   for both in one form, and offer to add that line under "Project-specific
   notes" -- add it only if I say yes.
3. **Gather -- read only, in this project and in the clone.** The format is
   `SCHEMA.md` in the clone; read it first. Then read:
   - `git log --reverse --format='%as %h %s'` (the first commit and the arc)
     and `git tag`;
   - `docs/CHANGELOG.md` (versions and their dates), the headers and dates in
     `docs/DECISIONS.md`, the header of `docs/STATE.md`, and the earliest
     scope there is: `docs/ARCHITECTURE.md`, a handoff folder, the first
     CHANGELOG entry, the first commit's message;
   - in the clone, the frontmatter of every file under
     `C:\Claude\Achievements\entries\`, to find this project's filed entries and
     any `PROJECT.md`. Apply the same-name check as `achievement.md` step 3
     ("Same project as before?") and use the spelling already filed.
   If the arguments name a period or milestones, cover only that.
4. **Draft the set.**
   - **The overview**, if this project has no `PROJECT.md` yet: `org` and
     `project` as filed; `started`; `status` (`active` unless the files say
     otherwise); `for` when the org does not already say it; a one-line
     `summary`; `source: backfill`; and a 2-5 sentence body giving the
     ORIGINAL scope -- what it set out to do, for whom, and why -- from the
     earliest documents, never from today's state.
     **`started` is the earliest evidence of the work.** If anything
     predates the first commit (a handoff, a CHANGELOG entry older than the
     repo), ask me for the start date. Do not assume either one.
   - **Milestone entries**, one per milestone a manager would care about: the
     start, then the features and releases that changed what the project
     could do. Fold patch releases into the milestone they belong to; do not
     draft one entry per version. Each entry is dated the day its milestone
     happened (its release or commit date), `category` and `org` from the
     project default, `source: backfill`, `evidence` naming the version,
     commit or document it rests on, and a 2-4 sentence body for a manager.
   - **Skip what is already filed.** A milestone an existing entry covers is
     not drafted again; list it as already filed.
   - Use only what the files say. Never invent a metric, a figure or an
     outcome; if a milestone's impact is not in the files, write what was
     delivered and say the impact is not recorded. Secrets, credentials and
     tokens never go in; the filing script refuses them.
5. **My approval.** One form: a multiSelect of the drafted milestones (date
   and title, all checked), the overview as its own item, and an editable
   text field seeded with the whole set -- the overview first, then each
   entry, each block starting with `---`. Nothing is filed without my yes,
   and what I approve is filed exactly as approved.
6. **File the set.** Write each approved entry, and the overview, to its own
   new file in the system temp directory (UTF-8, no BOM), then run ONCE, in
   PowerShell:
   `& 'C:\Claude\Achievements\tools\Add-Achievement.ps1' -Path '<entry 1>', '<entry 2>' -ProjectPath '<overview>'`
   (leave out `-ProjectPath` if there is no overview, `-Path` if there are no
   entries) and delete the temp files afterwards. The set is validated as a
   whole and filed in one commit; if any item is refused, none is filed.
   Never edit, stage or commit anything in the clone yourself. The script is
   the one ruled exception to committing through the commit widget (ruled
   2026-11-02), and it belongs to the script, not to you.
7. **Report by exit code**, quoting the script's RESULT or error line:
   `0` filed and pushed (give the commit and the count); `2` refused -- show
   every problem (each names its file), fix the set with me, and go back to
   step 5; `3` written but not committed -- give the paths, do not retry; `4`
   committed but not pushed -- say so, do not retry; `1` could not start --
   show the error. (A `1` naming uncommitted changes to `README.md` or a
   `PROJECT.md` means the changes are mine to commit or discard, never yours.
   A `1` saying the project already has an overview elsewhere means run
   `tools\Repair-AchievementLayout.ps1` in the clone first.)
