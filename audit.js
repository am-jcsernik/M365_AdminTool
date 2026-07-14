/*
 * audit.js — append-only audit log (v11.2.0)
 *
 * Every consequential action (connections, report runs, snapshot
 * operations, session restarts, config reads) is appended as one JSON
 * line to ./M365AuditLog/audit-YYYY-MM.jsonl (monthly rotation by
 * filename). Entries are never modified or deleted by the application.
 *
 * Entry shape:
 *   { ts, action, ip, detail }
 *
 * This is the foundation for the planned RBAC feature (see
 * RBAC-ROADMAP.md) — once users authenticate, entries also carry the
 * acting identity.
 */

const fs = require("fs");
const path = require("path");

const AUDIT_DIR = path.join(process.cwd(), "M365AuditLog");

// The server registers a function returning the current acting identity
// (today: the connected Graph account; post-RBAC: the signed-in user).
let identityProvider = () => null;
function setIdentityProvider(fn) { identityProvider = fn; }

function currentFile() {
  const d = new Date();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return path.join(AUDIT_DIR, `audit-${ym}.jsonl`);
}

// audit(req, action, detail) — req may be null for server-initiated events.
function audit(req, action, detail = {}) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      action,
      account: (() => { try { return identityProvider(); } catch { return null; } })(),
      ip: req ? (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null) : null,
      detail,
    };
    fs.appendFileSync(currentFile(), JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    // Auditing must never break the operation itself; log and continue.
    console.error("audit write failed:", e.message);
  }
}

// Read the most recent `limit` entries (newest first), spanning file
// boundaries if the current month's file is short.
function readAudit(limit = 200) {
  if (!fs.existsSync(AUDIT_DIR)) return [];
  const files = fs.readdirSync(AUDIT_DIR).filter(f => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse();
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const lines = fs.readFileSync(path.join(AUDIT_DIR, f), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch {}
    }
  }
  return out;
}

module.exports = { audit, readAudit, setIdentityProvider, AUDIT_DIR };
