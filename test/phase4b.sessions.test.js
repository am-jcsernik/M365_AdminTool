/*
 * phase4b.sessions.test.js — v12 Phase 4b integration tests.
 *
 * Proves the per-tenant session model's HTTP contract without exercising any
 * PowerShell/Graph (offline in CI):
 *   - delegated/device-code connect is REFUSED in DOCKER_MODE (the hosted tool
 *     is app-only; a shared delegated session was the credential bleed 4b fixes);
 *   - /api/connection reports per-tenant status and is tenant-authorized;
 *   - data routes require a tenant selection and re-check tenant authorization
 *     server-side (never trust the client's chosen tenant).
 *
 * Boots one server child in DOCKER_MODE (forged Easy Auth headers = ACA), seeds
 * the store as a forged admin, then drives the guards as a scoped operator.
 */

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ADMIN_GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ACCESS_GROUP = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function principalHeaders({ upn, groups = [] }) {
  const claims = [{ typ: "preferred_username", val: upn }, ...groups.map(g => ({ typ: "groups", val: g }))];
  const b64 = Buffer.from(JSON.stringify({ claims }), "utf8").toString("base64");
  return { "x-ms-client-principal": b64, "x-ms-client-principal-name": upn };
}

function makeClient(base) {
  return async (method, p, { body, as } = {}) => {
    const headers = { "content-type": "application/json", ...(as ? principalHeaders(as) : {}) };
    const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* not all routes return JSON */ }
    return { status: res.status, json };
  };
}

function killTree(child) {
  if (!child || child.killed) { try { child && child.kill(); } catch {} return; }
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); return; } catch {}
  }
  try { child.kill(); } catch {}
}

function bootServer({ port, dataDir }) {
  const env = {
    ...process.env, PORT: String(port), DATA_DIR: dataDir,
    ADMIN_GROUP_ID: ADMIN_GROUP, ACCESS_GROUP_ID: ACCESS_GROUP, DOCKER_MODE: "1",
  };
  const child = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    (async function poll() {
      try { const r = await fetch(base + "/api/health"); if (r.ok) return resolve({ child, base }); } catch {}
      if (Date.now() > deadline) { child.kill(); return reject(new Error("server did not start")); }
      setTimeout(poll, 200);
    })();
  });
}

describe("v12 Phase 4b — per-tenant sessions + app-only enforcement", () => {
  let child, api, tmp;
  const ADMIN = { upn: "boss@am.consulting", groups: [ADMIN_GROUP] };
  const OP = { upn: "op@am.consulting", groups: [] };      // scoped to tenant "am"
  const OTHER = { upn: "stranger@am.consulting", groups: [ACCESS_GROUP] }; // access, no roles

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p4b-"));
    const port = 3980 + Math.floor((Date.now() % 7));
    const booted = await bootServer({ port, dataDir: tmp });
    child = booted.child; api = makeClient(booted.base);

    // Seed as a forged admin (DOCKER_MODE has no local-dev admin).
    let r = await api("POST", "/api/admin/tenants", { as: ADMIN, body: { name: "AM", tenantId: "am.consulting" } });
    assert.equal(r.status, 200, "admin creates tenant am");
    r = await api("POST", "/api/admin/roles", { as: ADMIN, body: { name: "AM Full", tenants: ["am"], reports: "*" } });
    assert.equal(r.status, 200);
    r = await api("POST", "/api/admin/assignments", { as: ADMIN, body: { principalType: "user", principal: OP.upn, roles: ["am-full"] } });
    assert.equal(r.status, 200);
  });

  after(() => { killTree(child); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test("delegated Graph connect is refused in DOCKER_MODE (400)", async () => {
    const r = await api("POST", "/api/connect/graph", { as: OP, body: { tenant: "am", useDeviceCode: true } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /app-only/i);
  });

  test("delegated Exchange connect is refused in DOCKER_MODE (400)", async () => {
    const r = await api("POST", "/api/connect/exchange", { as: OP, body: { tenant: "am" } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /app-only/i);
  });

  test("connect to an unauthorized tenant is denied (403)", async () => {
    // OP is scoped to "am" only; asking for a different tenant is refused before
    // any session work. (Uses a tenantId the store doesn't grant OP.)
    const r = await api("POST", "/api/connect/graph", { as: OP, body: { tenant: "ghost" } });
    assert.equal(r.status, 403);
  });

  test("/api/connection reports per-tenant status for an authorized caller", async () => {
    const r = await api("GET", "/api/connection?tenant=am", { as: OP });
    assert.equal(r.status, 200);
    assert.equal(r.json.tenant, "am");
    assert.equal(r.json.graphConnected, false, "not connected yet");
  });

  test("/api/connection is tenant-authorized (403 for a tenant the caller lacks)", async () => {
    const r = await api("GET", "/api/connection?tenant=ghost", { as: OP });
    assert.equal(r.status, 403);
  });

  test("/api/run without a tenant selection is a 400", async () => {
    const r = await api("POST", "/api/run", { as: OP, body: { reportId: "all-users" } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /tenant/i);
  });

  test("/api/run for a tenant the caller isn't authorized for is a 403", async () => {
    const r = await api("POST", "/api/run", { as: OP, body: { reportId: "all-users", tenant: "ghost" } });
    assert.equal(r.status, 403);
  });

  test("an access-only user (no roles) cannot select the tenant (403 on run)", async () => {
    const r = await api("POST", "/api/run", { as: OTHER, body: { reportId: "all-users", tenant: "am" } });
    assert.equal(r.status, 403);
  });

  test("audit log reports a valid hash chain (integrity.ok)", async () => {
    // The seeded admin CRUD above already wrote several audited entries.
    const r = await api("GET", "/api/audit?limit=500", { as: ADMIN });
    assert.equal(r.status, 200);
    assert.ok(r.json.entries.length > 0, "entries present");
    assert.ok(r.json.entries.every(e => e.hash && e.prevHash), "each entry is hash-chained");
    assert.equal(r.json.integrity.ok, true, "chain verifies");
  });

  test("tampering with the audit log is detected", async () => {
    // Rewrite a byte in the on-disk log, then re-verify via the endpoint.
    const files = fs.readdirSync(path.join(tmp, "M365AuditLog")).filter(f => /^audit-.*\.jsonl$/.test(f)).sort();
    const target = path.join(tmp, "M365AuditLog", files[0]);
    const lines = fs.readFileSync(target, "utf8").split("\n").filter(Boolean);
    const obj = JSON.parse(lines[0]);
    obj.detail = { ...(obj.detail || {}), tampered: true }; // change core without fixing hash
    lines[0] = JSON.stringify(obj);
    fs.writeFileSync(target, lines.join("\n") + "\n", "utf8");
    const r = await api("GET", "/api/audit?limit=10", { as: ADMIN });
    assert.equal(r.status, 200);
    assert.equal(r.json.integrity.ok, false, "tamper detected");
  });
});
