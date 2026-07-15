/*
 * audit.js — append-only audit log (v11.2.0)
 *
 * Every consequential action (connections, report runs, snapshot
 * operations, session restarts, config reads) is appended as one JSON
 * line to ./M365AuditLog/audit-YYYY-MM.jsonl (monthly rotation by
 * filename). Entries are never modified or deleted by the application.
 *
 * Entry shape:
 *   { ts, action, account, connection, ip, detail }
 *
 * v12 records TWO identities (see RBAC-ROADMAP.md / docs/PLAN-v12-rbac.md):
 *   - account    — the ACTING USER (Easy Auth), taken from req.user.upn. This
 *                  is the accountability identity for "who did this".
 *   - connection — WHAT the tool reported as (the connected Graph/EXO account),
 *                  supplied by the connection identity provider below.
 */

const fs = require("fs");
const path = require("path");

// DATA_DIR relocates durable state to a mounted volume in containers;
// defaults to the working directory so local runs are unchanged.
const AUDIT_DIR = path.join(process.env.DATA_DIR || process.cwd(), "M365AuditLog");

// The server registers a function returning the current CONNECTION identity
// (the connected Graph/EXO account). The acting user comes per-request from
// req.user (see auth.js), not from this global.
let connectionIdentityProvider = () => null;
function setConnectionIdentityProvider(fn) { connectionIdentityProvider = fn; }
// Back-compat alias for the pre-v12 name.
const setIdentityProvider = setConnectionIdentityProvider;

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
      // Acting user (accountability): from req.user (auth.js). Null for
      // server-initiated events (req === null) or pre-auth requests.
      account: req && req.user ? (req.user.upn || null) : null,
      // Connection identity (what the tool reported as).
      connection: (() => { try { return connectionIdentityProvider(); } catch { return null; } })(),
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

module.exports = { audit, readAudit, setConnectionIdentityProvider, setIdentityProvider, AUDIT_DIR };
