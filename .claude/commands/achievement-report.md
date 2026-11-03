---
description: Rundown of my achievements for a status update, review, raise or promotion case
argument-hint: [what and why, e.g. "work, last 12 months, promotion case"]
---
Draft a rundown from my achievements log -- the running record of what I work
on -- for the purpose I give. It is how the log is USED: status updates to
management, a performance review, and the case for a raise or a promotion.

Achievements log clone: `C:\Claude\Achievements`
Arguments: "$ARGUMENTS"

1. **Configured?** If the clone path above is `NOT-CONFIGURED`, STOP and say:
   this kit install names no achievements log; from the kit folder run
   `.\Set-KitOwner.ps1 -AchievementsRoot <path to the clone>`, then
   `.\Sync-ProjectCommands.ps1` for this project. If the path is set but the
   folder, or `tools\Get-AchievementReport.ps1` inside it, does not exist,
   STOP and say which is missing.
2. **Read only.** Never edit, stage, commit or move anything in the clone.
   First run `git -C 'C:\Claude\Achievements' pull --ff-only --quiet`, so
   entries filed from another machine are included. If it fails, carry on
   with what is on disk and say in the rundown that it may be missing
   entries filed elsewhere.
3. **The ask.** From the arguments, work out: category (`work`, `personal`
   or all), period (`-From` / `-To`), org(s), project(s), the PURPOSE
   (status update, review, raise, promotion, or other) and the audience. If
   category or purpose is not clear, ask me in ONE form, pre-filled with:
   category work, the last 12 months, purpose promotion case.
4. **The facts.** Run, in PowerShell:
   `& 'C:\Claude\Achievements\tools\Get-AchievementReport.ps1' <filters> -OutFile '<a new file in the system temp directory>'`
   and read that file; delete it when done. Quote its "Files read: ..." line
   in the rundown. If it lists unreadable or misfiled files, say so -- they
   are not silently part of, or missing from, the rundown.
5. **The rundown**, written for the purpose and the audience:
   - **Summary** -- 3-5 sentences: the period, the scope, and the two or
     three themes that matter most for this purpose.
   - **By theme or project** -- for each: what was done, why it mattered
     (from the entries' `impact`), and the evidence (from `evidence`). Cite
     each claim's entry by date and title.
   - **Skills and breadth** -- from the report's skills table.
   - **To strengthen** -- entries whose impact has no measurable result, or
     whose evidence is thin. Put each as a QUESTION to me ("what did this
     save, in hours or money?"), never as a filled-in answer.
   - **Sources** -- every entry used: date, project, title.
   Use ONLY what the entries say. Never invent a metric, a figure, an
   outcome or a comparison, and never upgrade a claim beyond its entry
   ("helped" does not become "led"). A strong case is a true one.
6. **Deliver it in the chat.** Then ask whether to save it, and where. Do
   not write it into the achievements clone: the log holds entries, not
   reports.
