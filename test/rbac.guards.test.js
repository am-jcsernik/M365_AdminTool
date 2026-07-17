/*
 * rbac.guards.test.js — v12 RBAC Phase 6 integration tests (guard matrix).
 *
 * Boots the REAL server (child process, temp DATA_DIR, spare port) and drives
 * HTTP as different identities to prove the default-deny access model:
 *   - identity is taken from Easy Auth headers (X-MS-CLIENT-PRINCIPAL*), which
 *     the server trusts only when present; we forge them here to simulate ACA.
 *   - a second instance runs with DOCKER_MODE=1 to exercise the 401 (no
 *     identity) path, which local-dev (synthetic admin) can't reach.
 *
 * No Graph/PowerShell is exercised — the matrix is pure authZ (gate, per-report
 * filtering, admin-only routes), so it runs offline in CI. Run: `npm test`.
 *
 * Node's built-in test runner + assert; no external test deps.
 */

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ADMIN_GROUP = "11111111-1111-1111-1111-111111111111";
const ACCESS_GROUP = "22222222-2222-2222-2222-222222222222";
const GLOBAL_ADMIN_WID = "62e90394-69f5-4237-9190-012177145e10"; // Entra Global Administrator

// Forge an Easy Auth principal blob the way auth.js decodes it: a base64 JSON
// object with a `claims` array (upn + one claim per group + one `wids` per role).
function principalHeaders({ upn, groups = [], wids = [] }) {
  const claims = [
    { typ: "preferred_username", val: upn },
    ...groups.map(g => ({ typ: "groups", val: g })),
    ...wids.map(w => ({ typ: "wids", val: w })),
  ];
  const b64 = Buffer.from(JSON.stringify({ claims }), "utf8").toString("base64");
  return { "x-ms-client-principal": b64, "x-ms-client-principal-name": upn };
}

// Minimal HTTP helper against a base URL, with optional forged identity.
function makeClient(base) {
  return async (method, p, { body, as } = {}) => {
    const headers = { "content-type": "application/json", ...(as ? principalHeaders(as) : {}) };
    const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* some routes may not return JSON */ }
    return { status: res.status, json };
  };
}

// Kill a server child AND its grandchildren. On Windows, child.kill() reaps
// only the node process, leaving the pwsh session it spawned orphaned; taskkill
// /T tears down the whole tree. POSIX: a plain kill is enough here.
function killTree(child) {
  if (!child || child.killed) { try { child && child.kill(); } catch {} return; }
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); return; }
    catch { /* fall through to plain kill */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}

// Boot a server child on `port`, resolving once /api/health answers.
function bootServer({ port, dataDir, docker = false }) {
  const env = {
    ...process.env, PORT: String(port), DATA_DIR: dataDir,
    ADMIN_GROUP_ID: ADMIN_GROUP, ACCESS_GROUP_ID: ACCESS_GROUP,
  };
  if (docker) env.DOCKER_MODE = "1"; else delete env.DOCKER_MODE;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."), env, stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    (async function poll() {
      try {
        const r = await fetch(base + "/api/health");
        if (r.ok) return resolve({ child, base });
      } catch { /* not up yet */ }
      if (Date.now() > deadline) { child.kill(); return reject(new Error("server did not start")); }
      setTimeout(poll, 200);
    })();
  });
}

describe("v12 RBAC guard matrix", () => {
  let child, api, tmp;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rbac-guards-"));
    const port = 3990 + Math.floor((Date.now() % 6)); // spare, low-collision
    const booted = await bootServer({ port, dataDir: tmp });
    child = booted.child;
    api = makeClient(booted.base);

    // Seed the store as the LOCAL admin (no forged headers on localhost →
    // synthetic admin per auth.js). This is also the admin-CRUD happy path.
    let r = await api("POST", "/api/admin/tenants", { body: { name: "AM", tenantId: "am.consulting" } });
    assert.equal(r.status, 200, "admin can create a tenant");
    r = await api("POST", "/api/admin/roles", { body: { name: "User RO", tenants: ["am"], reports: { areas: ["User Reports"], ids: [] } } });
    assert.equal(r.status, 200);
    r = await api("POST", "/api/admin/roles", { body: { name: "Groups One", tenants: "*", reports: { areas: [], ids: ["all-groups"] } } });
    assert.equal(r.status, 200);
    // area-scoped user, id-scoped user
    await api("POST", "/api/admin/assignments", { body: { principalType: "user", principal: "area@am.consulting", roles: ["user-ro"] } });
    await api("POST", "/api/admin/assignments", { body: { principalType: "user", principal: "id@am.consulting", roles: ["groups-one"] } });
  });

  after(() => {
    killTree(child);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test("health is reachable without authentication", async () => {
    const r = await api("GET", "/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
  });

  test("local dev (no Easy Auth header) is a full admin", async () => {
    const r = await api("GET", "/api/admin/store");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.tenants));
  });

  test("Easy Auth admin (admin group) reaches admin routes", async () => {
    const r = await api("GET", "/api/admin/store", { as: { upn: "boss@am.consulting", groups: [ADMIN_GROUP] } });
    assert.equal(r.status, 200);
  });

  test("Global Administrator (wids) is a tool admin without any group membership", async () => {
    const as = { upn: "ga@am.consulting", groups: [], wids: [GLOBAL_ADMIN_WID] };
    assert.equal((await api("GET", "/api/admin/store", { as })).status, 200);
    const cfg = await api("GET", "/api/config", { as });
    assert.equal(cfg.json.admin, true);
    assert.deepEqual(cfg.json.me.adminVia, ["global-admin-role"], "admin conferred by the role, not a group");
  });

  test("a non-admin directory role (wids) does not confer tool admin", async () => {
    const as = { upn: "helpdesk@am.consulting", groups: [], wids: ["88888888-8888-8888-8888-888888888888"] };
    assert.equal((await api("GET", "/api/admin/store", { as })).status, 403);
  });

  test("no-access identity is denied everything but health (403)", async () => {
    const as = { upn: "nobody@am.consulting", groups: [] };
    assert.equal((await api("GET", "/api/reports", { as })).status, 403);
    assert.equal((await api("GET", "/api/config", { as })).status, 403);
    assert.equal((await api("GET", "/api/admin/store", { as })).status, 403);
  });

  test("access-group member has tool access but sees no reports (default-deny)", async () => {
    const as = { upn: "member@am.consulting", groups: [ACCESS_GROUP] };
    const cfg = await api("GET", "/api/config", { as });
    assert.equal(cfg.status, 200, "in the access group → tool access");
    assert.equal(cfg.json.admin, false);
    const reps = await api("GET", "/api/reports", { as });
    assert.equal(reps.status, 200);
    assert.deepEqual(reps.json, [], "no role grants → no reports visible");
  });

  test("area-scoped user sees only that area's reports", async () => {
    const as = { upn: "area@am.consulting", groups: [] };
    const reps = await api("GET", "/api/reports", { as });
    assert.equal(reps.status, 200);
    assert.equal(reps.json.length, 1, "exactly one category");
    assert.equal(reps.json[0].category, "User Reports");
    assert.ok(reps.json[0].items.some(i => i.id === "all-users"));
  });

  test("id-scoped user sees only the single granted report", async () => {
    const as = { upn: "id@am.consulting", groups: [] };
    const reps = await api("GET", "/api/reports", { as });
    assert.equal(reps.status, 200);
    assert.equal(reps.json.length, 1);
    assert.equal(reps.json[0].items.length, 1);
    assert.equal(reps.json[0].items[0].id, "all-groups");
  });

  test("non-admin cannot mutate the store (403) or read the full audit", async () => {
    const as = { upn: "area@am.consulting", groups: [] };
    assert.equal((await api("POST", "/api/admin/tenants", { as, body: { name: "Sneaky" } })).status, 403);
    assert.equal((await api("PUT", "/api/admin/groups", { as, body: {} })).status, 403);
    assert.equal((await api("GET", "/api/audit", { as })).status, 403);
  });

  test("admin CRUD round-trips: create → visible → delete → gone", async () => {
    let r = await api("POST", "/api/admin/tenants", { body: { name: "Temp Tenant", tenantId: "temp.example" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.id, "temp-tenant");
    r = await api("GET", "/api/admin/store");
    assert.ok(r.json.tenants.some(t => t.id === "temp-tenant"));
    r = await api("DELETE", "/api/admin/tenants/temp-tenant");
    assert.equal(r.status, 200);
    r = await api("GET", "/api/admin/store");
    assert.ok(!r.json.tenants.some(t => t.id === "temp-tenant"));
  });

  test("deleting a role scrubs it from assignments (cascade)", async () => {
    await api("POST", "/api/admin/roles", { body: { name: "Doomed", tenants: "*", reports: "*" } });
    await api("POST", "/api/admin/assignments", { body: { principalType: "user", principal: "casc@am.consulting", roles: ["doomed"] } });
    await api("DELETE", "/api/admin/roles/doomed");
    const r = await api("GET", "/api/admin/store");
    const a = r.json.assignments.find(x => x.principal === "casc@am.consulting");
    assert.ok(a, "assignment still present");
    assert.ok(!a.roles.includes("doomed"), "role reference scrubbed");
  });

  test("the persisted store never contains the internal __audit marker", async () => {
    const raw = fs.readFileSync(path.join(tmp, "access", "rbac.json"), "utf8");
    assert.ok(!raw.includes("__audit"), "audit marker must not leak to disk");
  });
});

describe("v12 RBAC — DOCKER_MODE requires authentication", () => {
  let child, api, tmp;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rbac-docker-"));
    const booted = await bootServer({ port: 3997, dataDir: tmp, docker: true });
    child = booted.child; api = makeClient(booted.base);
  });
  after(() => { killTree(child); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test("no Easy Auth identity → 401 on guarded routes, health still open", async () => {
    assert.equal((await api("GET", "/api/health")).status, 200);
    assert.equal((await api("GET", "/api/reports")).status, 401);
    assert.equal((await api("GET", "/api/config")).status, 401);
  });
});
