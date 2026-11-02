---
description: File an achievement (work or personal) in my achievements log
argument-hint: [a block pasted from a Claude chat]
---
File ONE entry in my achievements log -- the running record of what I work on,
used for status updates to management and as evidence for a promotion or raise
case.

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
   notes" -- add it only if I say yes. An entry may still override either value.
3. **The entry.** The format is `SCHEMA.md` in the clone; read it first.
   - If the arguments hold a pasted block (it starts with a code fence or with
     `---`), that block IS the entry, produced by a Claude chat. Do not rewrite
     its wording; only its `project` line may change, and only by the check
     below. Its `source` must be `claude-chat`.
   - Otherwise, draft one from THIS session's work: `date` today; `category`
     and `org` from the project default; `project` this project's name; a
     one-line `title` (what was achieved) and `impact` (why it mattered, in
     business terms); `skills`; `evidence` (commit hashes, PRs, test results
     from this session); `source: claude-code`; and a 2-4 sentence body
     written for a manager, not an engineer. Use only facts from this session.
     Never invent a metric, a figure or an outcome.
   - Client names and engagement detail are allowed. Secrets, credentials and
     tokens never are; the filing script refuses them.
   - **Same project as before?** A project's history in the log is every
     entry with the same `org` and `project`, so a new spelling starts a
     separate history. Read the frontmatter `org:` and `project:` of every file
     under `C:\Claude\Achievements\entries\` (read only). If this entry's
     project matches one filed under its org, ignoring case, use that
     spelling and go on. Otherwise ask me in a form BEFORE step 4: the
     project names already filed under this org, plus "new project: <this
     name>"; if the name is filed under another org, say which. Use what I
     choose.
4. **My approval.** Show me the complete entry in a form: an editable text
   field seeded with the entry, and a choice to file it or stop. Nothing is
   filed without my yes, and what I approve is filed exactly as approved.
5. **File it.** Write the approved text to a new file in the system temp
   directory (UTF-8, no BOM), then run, in PowerShell:
   `& 'C:\Claude\Achievements\tools\Add-Achievement.ps1' -Path '<that file>'`
   and delete the temp file afterwards. That script is the ONLY writer: it
   validates, writes, commits the one entry file by explicit path, and pushes.
   Never edit, stage or commit anything in the clone yourself. This is the one
   ruled exception to committing through the commit widget (ruled 2026-11-02),
   and it belongs to the script, not to you.
6. **Report by exit code**, quoting the script's RESULT or error line:
   `0` filed and pushed (give the path and commit); `2` refused -- show every
   problem, fix the entry with me, and go back to step 4; `3` written but not
   committed -- give the path, do not retry; `4` committed but not pushed --
   say so, do not retry; `1` could not start -- show the error.
