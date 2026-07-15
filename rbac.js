/*
 * rbac.js — v12 RBAC Phase 2: authorization store + engine.
 *
 * Owns the writable authorization store (DATA_DIR/access/rbac.json) and the
 * DEFAULT-DENY decision engine. No Express wiring here — server.js consumes
 * these predicates in Phase 3 to guard routes. See docs/PLAN-v12-rbac.md.
 *
 * Store shape:
 *   {
 *     version: 1,
 *     accessGroupId: "<entra-group-oid>|null",   // overall-access gate
 *     adminGroupId:  "<entra-group-oid>|null",    // in-tool admin bootstrap
 *     tenants:     [ { id, name, tenantId, clientId, certSecret } ],
 *     roles:       [ { id, name, tenants: [id...]|"*",
 *                      reports: "*" | { areas: [cat...]|"*", ids: [id...] } } ],
 *     assignments: [ { principalType: "user"|"group", principal, roles: [id...] } ]
 *   }
 *
 * Two "*" conventions: role.tenants "*" = every tenant; role.reports "*" (or
 * reports.areas "*") = every report. Absence of a matching role = no access.
 */

const fs = require("fs");
const path = require("path");
const { reportArea } = require("./reports.js");

const ACCESS_DIR = path.join(process.env.DATA_DIR || process.cwd(), "access");
const STORE_PATH = path.join(ACCESS_DIR, "rbac.json");

// ── Store load / seed / save ──────────────────────────────────────────

// Build the initial store on first run. Seeds tenants from config.json (if
// provided) and the bootstrap group ids from env. Roles/assignments start
// empty, so the store is default-deny for everyone except admins until an
// admin grants access.
function seedStore(configTenants = []) {
  const tenants = (Array.isArray(configTenants) ? configTenants : []).map((t, i) => ({
    id: t.id || slug(t.name) || `tenant${i + 1}`,
    name: t.name || t.tenantId || `Tenant ${i + 1}`,
    tenantId: t.tenantId || null,
    clientId: t.clientId || null,      // filled in by the admin UI (Phase 5)
    certSecret: t.certSecret || null,  // e.g. "kv:m365-report-am"
  }));
  return {
    version: 1,
    accessGroupId: process.env.ACCESS_GROUP_ID || null,
    adminGroupId: process.env.ADMIN_GROUP_ID || null,
    tenants,
    roles: [],
    assignments: [],
  };
}

function slug(s) {
  return s ? String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : null;
}

// Load the store, creating a seeded one if absent. `configTenants` is only used
// for first-run seeding. Throws on a present-but-corrupt store (fail loud rather
// than silently reverting to default-deny and locking everyone out).
function loadStore(configTenants = []) {
  if (!fs.existsSync(STORE_PATH)) {
    const store = seedStore(configTenants);
    saveStore(store);
    return store;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (e) {
    throw new Error(`RBAC store is corrupt (${STORE_PATH}): ${e.message}`);
  }
  return normalizeStore(raw);
}

// Fill in any missing top-level fields so downstream code can assume shape.
function normalizeStore(s) {
  return {
    version: s.version || 1,
    accessGroupId: s.accessGroupId ?? (process.env.ACCESS_GROUP_ID || null),
    adminGroupId: s.adminGroupId ?? (process.env.ADMIN_GROUP_ID || null),
    tenants: Array.isArray(s.tenants) ? s.tenants : [],
    roles: Array.isArray(s.roles) ? s.roles : [],
    assignments: Array.isArray(s.assignments) ? s.assignments : [],
  };
}

// Atomic write (temp file + rename) so a crash mid-write can't corrupt the
// store. Callers should serialize writes (single admin UI writer in Phase 5).
function saveStore(store) {
  fs.mkdirSync(ACCESS_DIR, { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(normalizeStore(store), null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

// ── Engine ────────────────────────────────────────────────────────────

const lc = (v) => (v == null ? null : String(v).toLowerCase());

// Does the user belong to a group id (case-insensitive on GUIDs is harmless)?
function inGroup(user, groupId) {
  if (!groupId || !user || !Array.isArray(user.groups)) return false;
  const g = lc(groupId);
  return user.groups.some(x => lc(x) === g);
}

// Admins: members of the admin group, or a user carrying isAdmin already
// (auth.js may set it from env). Admins bypass fine-grained checks.
function isAdmin(user, store) {
  if (!user) return false;
  if (user.isAdmin === true) return true;
  return inGroup(user, store && store.adminGroupId);
}

// Overall-access gate: admins always; otherwise a member of the access group OR
// anyone holding at least one role assignment (so per-user grants work even if
// the access group isn't configured).
function hasToolAccess(user, store) {
  if (isAdmin(user, store)) return true;
  if (!user || !user.upn) return false;
  if (inGroup(user, store && store.accessGroupId)) return true;
  return resolveRoles(user, store).length > 0;
}

// Collect the role objects assigned to a user (via UPN or group membership).
function resolveRoles(user, store) {
  if (!user || !store || !Array.isArray(store.assignments)) return [];
  const upn = lc(user.upn);
  const roleIds = new Set();
  for (const a of store.assignments) {
    if (!a || !Array.isArray(a.roles)) continue;
    const match =
      (a.principalType === "user" && lc(a.principal) === upn) ||
      (a.principalType === "group" && inGroup(user, a.principal));
    if (match) a.roles.forEach(r => roleIds.add(r));
  }
  const byId = new Map((store.roles || []).map(r => [r.id, r]));
  return [...roleIds].map(id => byId.get(id)).filter(Boolean);
}

// Union the user's roles into an effective grant. "*" wins over any list.
function effectiveAccess(user, store) {
  const roles = resolveRoles(user, store);
  let allTenants = false, allReports = false;
  const tenants = new Set(), areas = new Set(), ids = new Set();
  for (const role of roles) {
    if (role.tenants === "*") allTenants = true;
    else (role.tenants || []).forEach(t => tenants.add(t));

    const rep = role.reports;
    if (rep === "*" || (rep && rep.areas === "*")) allReports = true;
    else if (rep) {
      (rep.areas || []).forEach(a => areas.add(a));
      (rep.ids || []).forEach(i => ids.add(i));
    }
  }
  return { allTenants, tenants, allReports, areas, ids };
}

// The core decision. `need` may include { tenant, reportId }; omit a field to
// skip that check (e.g. checking tenant access alone at connect time).
// Default deny: anything not explicitly granted is refused.
function can(user, need, store) {
  need = need || {};
  if (!hasToolAccess(user, store)) return false;
  if (isAdmin(user, store)) return true;

  const eff = effectiveAccess(user, store);

  if (need.tenant != null) {
    if (!eff.allTenants && !eff.tenants.has(need.tenant)) return false;
  }
  if (need.reportId != null) {
    if (!eff.allReports) {
      const area = reportArea(need.reportId);
      const areaOk = area != null && eff.areas.has(area);
      const idOk = eff.ids.has(need.reportId);
      if (!areaOk && !idOk) return false;
    }
  }
  return true;
}

// Convenience: the tenant entries a user may see (for the friendly-name
// dropdown and catalog filtering in Phase 3). Admins see all.
function allowedTenants(user, store) {
  const tenants = (store && store.tenants) || [];
  if (isAdmin(user, store)) return tenants;
  if (!hasToolAccess(user, store)) return [];
  const eff = effectiveAccess(user, store);
  if (eff.allTenants) return tenants;
  return tenants.filter(t => eff.tenants.has(t.id));
}

module.exports = {
  loadStore, saveStore, seedStore, normalizeStore, STORE_PATH,
  isAdmin, hasToolAccess, resolveRoles, effectiveAccess, can, allowedTenants,
};
