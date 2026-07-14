/*
 * snapshots.js — snapshot persistence and diff engine (v11.1.0)
 *
 * Snapshots are point-in-time copies of a report's result rows, stored as
 * JSON under ./M365Snapshots/<reportId>/<timestamp>_<id>.json. Diffing two
 * row sets produces { added, removed, changed } keyed on a stable column.
 *
 * Key selection: an explicit per-report key (KEY_COLUMNS) when defined,
 * otherwise the first heuristic candidate present in the data, otherwise
 * the whole row serialized (exact-match only; changes appear as
 * remove+add). The chosen key is reported back so the UI can show it.
 *
 * Storage layout (one file per snapshot):
 *   { id, reportId, label, takenAt, params, fields, rowCount, rows }
 */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const SNAP_DIR = path.join(process.cwd(), "M365Snapshots");

// Explicit key columns for reports where the heuristic could mislead.
const KEY_COLUMNS = {
  "all-users": "UserPrincipalName",
  "disabled-users": "UserPrincipalName",
  "guest-users": "UserPrincipalName",
  "recent-users": "UserPrincipalName",
  "stale-users": "UserPrincipalName",
  "unlicensed-users": "UserPrincipalName",
  "all-groups": "DisplayName",
  "security-groups": "DisplayName",
  "distribution-lists": "DisplayName",
  "m365-groups": "DisplayName",
  "dynamic-groups": "DisplayName",
  "license-summary": "License",
  "shared-mailboxes": "PrimarySmtpAddress",
  "mail-forwarding": "PrimarySmtpAddress",
  "sp-sites": "WebUrl",
  "ca-policies": "DisplayName",
  "devices": "DisplayName",
  "domains": "Name",
};

const KEY_HEURISTICS = ["UserPrincipalName", "UPN", "Id", "PrimarySmtpAddress", "WebUrl", "DisplayName", "Name", "License", "User"];

function pickKey(reportId, rows) {
  if (KEY_COLUMNS[reportId] && rows.some(r => r[KEY_COLUMNS[reportId]] != null)) return KEY_COLUMNS[reportId];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  for (const k of KEY_HEURISTICS) if (cols.includes(k)) return k;
  return null; // whole-row identity
}

function rowKey(row, key) {
  if (key) return String(row[key] ?? "");
  return JSON.stringify(row);
}

// ── Storage ───────────────────────────────────────────────────────────
function reportDir(reportId) {
  // reportId comes from the catalog, but sanitize anyway (defense-in-depth
  // against path traversal if this is ever called with client input).
  const safe = String(reportId).replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(SNAP_DIR, safe);
}

function saveSnapshot(reportId, rows, { label, params, fields } = {}) {
  if (!Array.isArray(rows)) throw new Error("rows must be an array");
  const dir = reportDir(reportId);
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const takenAt = new Date().toISOString();
  const snap = { id, reportId, label: label || "", takenAt, params: params || {}, fields: fields || null, rowCount: rows.length, rows };
  const file = path.join(dir, `${takenAt.replace(/[:.]/g, "-")}_${id}.json`);
  fs.writeFileSync(file, JSON.stringify(snap), "utf8");
  return { id, takenAt, rowCount: rows.length, label: snap.label };
}

function listSnapshots(reportId) {
  const dir = reportDir(reportId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      out.push({ id: s.id, takenAt: s.takenAt, rowCount: s.rowCount, label: s.label || "" });
    } catch {}
  }
  return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

function loadSnapshot(reportId, id) {
  const dir = reportDir(reportId);
  if (!fs.existsSync(dir)) return null;
  const safeId = String(id).replace(/[^a-zA-Z0-9-]/g, "");
  const f = fs.readdirSync(dir).find(n => n.endsWith(`_${safeId}.json`));
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; }
}

function deleteSnapshot(reportId, id) {
  const dir = reportDir(reportId);
  if (!fs.existsSync(dir)) return false;
  const safeId = String(id).replace(/[^a-zA-Z0-9-]/g, "");
  const f = fs.readdirSync(dir).find(n => n.endsWith(`_${safeId}.json`));
  if (!f) return false;
  try { fs.unlinkSync(path.join(dir, f)); return true; } catch { return false; }
}

// ── Diff ──────────────────────────────────────────────────────────────
// Compares oldRows → newRows. Returns:
//   key       column used as identity (null = whole-row matching)
//   added     rows present in new but not old
//   removed   rows present in old but not new
//   changed   [{ key, changes: [{field, from, to}], row }] same key, different values
//   summary   counts
function diffRows(reportId, oldRows, newRows) {
  oldRows = Array.isArray(oldRows) ? oldRows : [];
  newRows = Array.isArray(newRows) ? newRows : [];
  const key = pickKey(reportId, newRows.length ? newRows : oldRows);

  const oldMap = new Map(), dupOld = new Set();
  for (const r of oldRows) { const k = rowKey(r, key); if (oldMap.has(k)) dupOld.add(k); oldMap.set(k, r); }
  const newMap = new Map(), dupNew = new Set();
  for (const r of newRows) { const k = rowKey(r, key); if (newMap.has(k)) dupNew.add(k); newMap.set(k, r); }

  const added = [], removed = [], changed = [];
  for (const [k, r] of newMap) if (!oldMap.has(k)) added.push(r);
  for (const [k, r] of oldMap) if (!newMap.has(k)) removed.push(r);
  if (key) {
    for (const [k, nr] of newMap) {
      const or = oldMap.get(k);
      if (!or) continue;
      const fieldSet = new Set([...Object.keys(or), ...Object.keys(nr)]);
      const changes = [];
      for (const f of fieldSet) {
        const a = or[f] ?? null, b = nr[f] ?? null;
        if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ field: f, from: a, to: b });
      }
      if (changes.length) changed.push({ key: k, changes, row: nr });
    }
  }

  const warnings = [];
  if (dupOld.size || dupNew.size) warnings.push(`Non-unique key values detected (${key}); duplicate-key rows compare last-wins.`);
  if (!key) warnings.push("No stable key column found — rows matched by full content; modified rows appear as removed+added.");

  return {
    key,
    added, removed, changed,
    summary: { added: added.length, removed: removed.length, changed: changed.length, oldCount: oldRows.length, newCount: newRows.length },
    warnings,
  };
}

module.exports = { saveSnapshot, listSnapshots, loadSnapshot, deleteSnapshot, diffRows, pickKey, SNAP_DIR };
