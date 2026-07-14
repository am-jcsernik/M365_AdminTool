# Decision Log

Append-only. Newest entries at the top. ADR-style: each decision dated, with
context, the decision itself, and consequences/trade-offs.

---

## 2026-07-14 -- ADR-0001: Adopt file-based session continuity
**Context:** Sessions are kept short and numerous; chat history is not a reliable
carrier of project state across sessions.
**Decision:** State is carried in `docs/STATE.md` (volatile), `docs/DECISIONS.md`
(this file), and git history. `CLAUDE.md` holds only stable rules. Sessions
bookend with `/resume` and `/wrap`.
**Consequences:** Continuity is portable across Claude Code CLI, Nimbalyst, and
cloud routines. Cost: discipline -- a session that skips `/wrap` leaves the next
one blind.
