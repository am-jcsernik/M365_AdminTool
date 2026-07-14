Add my **work team** (the shared dev-ops org) GitHub remote to this repo.

GitHub owner/org: `Alliances-Management-Dev-Ops`

Ask me for the repository name if I haven't already given it, and ask whether I
want **HTTPS** or **SSH** (default to whatever this repo's other remotes already
use; if none, ask). Then:
1. Build the URL:
   - HTTPS: `https://github.com/Alliances-Management-Dev-Ops/<repo>.git`
   - SSH:   `git@github.com:Alliances-Management-Dev-Ops/<repo>.git`
2. Run `git remote get-url origin` to check whether `origin` already exists.
   - If `origin` is free, add it as `origin`.
   - If `origin` is taken, add it as `team` instead and tell me which name you used.
3. Run `git remote -v` and show me the result.
4. Ask whether I want to push the current branch with upstream tracking
   (`git push -u <remote> <branch>`). Do NOT push until I confirm.
