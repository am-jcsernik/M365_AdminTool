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
const crypto = require("crypto");

// DATA_DIR relocates durable state to a mounted volume in containers;
// defaults to the working directory so local runs are unchanged.
const AUDIT_DIR = path.join(process.env.DATA_DIR || process.cwd(), "M365AuditLog");

// v12 Phase 4b: tamper-evident hash chain. Each entry carries `prevHash` (the
// previous entry's `hash`) and `hash` = sha256(prevHash + canonical-entry). Any
// edit/deletion/reordering breaks the chain, detectable via verifyAuditChain().
// Under app-only auth the tool's own log is the authoritative "who" record (the
// M365 unified log attributes actions to the app SP), so it must be verifiable.
const GENESIS = "GENESIS";
let _lastHash = null; // in-memory tail hash; seeded lazily from disk

function hashEntry(prevHash, core) {
  return crypto.createHash("sha256").update(prevHash + "\n" + JSON.stringify(core)).digest("hex");
}

// Seed _lastHash from the newest existing entry so the chain survives restarts
// and spans monthly files. Called once on first audit()/verify.
function seedLastHash() {
  if (_lastHash !== null) return;
  const recent = readAudit(1);
  _lastHash = recent.length && recent[0].hash ? recent[0].hash : GENESIS;
}

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
    seedLastHash();
    // Core fields are hashed; `hash`/`prevHash` are appended after.
    const core = {
      ts: new Date().toISOString(),
      action,
      // Acting user (accountability): from req.user (auth.js). Null for
      // server-initiated events (req === null) or pre-auth requests.
      account: req && req.user ? (req.user.upn || null) : null,
      // Connection identity (what the tool reported as). Prefer an explicit
      // per-tenant connection in detail; fall back to the global provider.
      connection: (detail && detail.connection) || (() => { try { return connectionIdentityProvider(); } catch { return null; } })(),
      ip: req ? (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null) : null,
      detail,
    };
    const prevHash = _lastHash || GENESIS;
    const hash = hashEntry(prevHash, core);
    _lastHash = hash;
    fs.appendFileSync(currentFile(), JSON.stringify({ ...core, prevHash, hash }) + "\n", "utf8");
  } catch (e) {
    // Auditing must never break the operation itself; log and continue.
    console.error("audit write failed:", e.message);
  }
}

// Verify the hash chain across all audit files (oldest → newest). Returns
// { ok, count, brokenAt? } — brokenAt is the ts/action of the first tampered or
// out-of-order entry. An admin route can surface this as an integrity check.
function verifyAuditChain() {
  if (!fs.existsSync(AUDIT_DIR)) return { ok: true, count: 0 };
  const files = fs.readdirSync(AUDIT_DIR).filter(f => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  let prev = GENESIS, count = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(AUDIT_DIR, f), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { return { ok: false, count, brokenAt: "unparseable line" }; }
      const { hash, prevHash, ...core } = e;
      if (prevHash !== prev) return { ok: false, count, brokenAt: `${core.ts} ${core.action} (prevHash mismatch)` };
      if (hashEntry(prevHash, core) !== hash) return { ok: false, count, brokenAt: `${core.ts} ${core.action} (hash mismatch)` };
      prev = hash; count++;
    }
  }
  return { ok: true, count };
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

module.exports = { audit, readAudit, verifyAuditChain, setConnectionIdentityProvider, setIdentityProvider, AUDIT_DIR };
