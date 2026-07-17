/*
 * M365 Admin Reports — Server (Persistent Session, Interactive Auth)
 *
 * Architecture:
 *   - One persistent pwsh process keeps the Graph/Exchange connection alive
 *   - Commands pass through temp .ps1 files (file-based IPC)
 *   - Reports execute by ID from the server-owned catalog (reports.js);
 *     the client never sends raw PowerShell
 *   - Jobs are serialized through a FIFO queue (one command in flight)
 *   - All report output is captured via a structured envelope (all PS
 *     streams: output, error, warning, information)
 *   - Interactive browser auth for Graph and Exchange (works on Windows)
 *   - Device code auth available as opt-in checkbox
 *
 * Security:
 *   - Binds 127.0.0.1 by default; 0.0.0.0 only in DOCKER_MODE or via HOST env
 *   - Read-only blocklist (mutating cmdlets rejected); Invoke-MgGraphRequest
 *     permitted with -Method GET only
 *   - Report parameters are sanitized and fields validated against the
 *     catalog whitelist (see reports.js)
 *
 * Usage:  npm install && npm start  →  http://localhost:3365
 */

// Version comes from package.json — the ONLY place it is declared.
const VERSION = require("./package.json").version;

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const os = require("os");
const { REPORTS, findReport, buildCommand, allAreas } = require("./reports.js");
const { saveSnapshot, listSnapshots, loadSnapshot, deleteSnapshot, diffRows } = require("./snapshots.js");
const { audit, readAudit, verifyAuditChain, setConnectionIdentityProvider } = require("./audit.js");
const { PACKS, findPack } = require("./packs.js");
const { userMiddleware } = require("./auth.js");
const rbac = require("./rbac.js");
const tenants = require("./tenants.js");
const sessions = require("./sessions.js");

const app = express();
const PORT = process.env.PORT || 3365;
const DOCKER_MODE = !!process.env.DOCKER_MODE;
// v12 RBAC Phase 4: when set, per-tenant app-only certificate auth is used for
// tenants that carry cert config (clientId + certSecret). Unset => device-code.
const KEY_VAULT_NAME = process.env.KEY_VAULT_NAME || null;
// SECURITY: localhost-only by default. The UI drives a PowerShell session
// that may hold an authenticated Graph token — never expose it to the LAN
// unless explicitly requested (Docker needs 0.0.0.0 inside the container).
const HOST = process.env.HOST || (DOCKER_MODE ? "0.0.0.0" : "127.0.0.1");

// ── Optional config (config.json) ───────────────────────────────────
// { "tenants": [ { "name": "AM Consulting", "tenantId": "am.consulting", "default": true } ] }
// See README. The "access" section is reserved for the planned RBAC
// feature (RBAC-ROADMAP.md) and is not enforced yet.
let CONFIG = { tenants: [] };
try {
  if (fs.existsSync(path.join(__dirname, "config.json"))) {
    CONFIG = { tenants: [], ...JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")) };
    console.log(`  Config loaded: ${CONFIG.tenants.length} tenant(s)`);
  }
} catch (e) { console.error("  config.json invalid:", e.message); }
app.use(express.json({ limit: "2mb" }));
// v12 RBAC Phase 1: resolve the acting user (Easy Auth) onto req.user for every
// request. AuthN only — no access enforcement here (that is Phase 3).
app.use(userMiddleware);

// ── Persistent data directory ────────────────────────────────────────
// All durable state (snapshots, audit log, console logs, CSV exports) lives
// under DATA_DIR. Defaults to the working directory so local runs behave
// exactly as before; in a container, point DATA_DIR at a mounted volume
// (e.g. Azure Files) so state survives restarts and scale-to-zero.
// TEMP_DIR (below) is deliberately NOT under DATA_DIR — it is ephemeral IPC
// scratch and belongs on fast local/ephemeral storage.
const DATA_DIR = process.env.DATA_DIR || process.cwd();

// v12 RBAC: initialize the authorization store (seeds from config.json tenants
// on first run). Guards below read it via rbac.getStore().
try { rbac.initStore(CONFIG.tenants); } catch (e) { console.error("  RBAC store init failed:", e.message); }

// ── Temp directory ──────────────────────────────────────────────────
// TEMP_DIR now lives in sessions.js (the pwsh engine owns IPC scratch). Sweep
// stale IPC files here so a crashed job can't leak temp files indefinitely.
const TEMP_DIR = sessions.TEMP_DIR;
setInterval(() => {
  try {
    const cut = Date.now() - 600000;
    for (const f of fs.readdirSync(TEMP_DIR)) {
      try { if (fs.statSync(path.join(TEMP_DIR, f)).mtimeMs < cut) fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
    }
  } catch {}
}, 60000);

// ── Diagnostic log ──────────────────────────────────────────────────
const diagLog = [];
// Console/diagnostic log: kept in memory for the Debug panel AND appended
// to ./M365Logs/console-YYYY-MM.log — container console output (e.g. Azure
// Container Apps) is ephemeral, files on a mounted volume are not.
const LOGS_DIR = path.join(DATA_DIR, "M365Logs");
function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${msg}`;
  console.log(`  ${line}`);
  diagLog.push(line);
  if (diagLog.length > 200) diagLog.shift();
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const d = new Date();
    const f = path.join(LOGS_DIR, `console-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.log`);
    fs.appendFile(f, `${d.toISOString().slice(0, 10)} ${line}\n`, () => {});
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════
//  POWERSHELL DETECTION
// ══════════════════════════════════════════════════════════════════════

let detectedPS = { exe: null, version: null, graphModule: null, graphUsersModule: null, exoModule: null, probeError: null, ready: false, probing: true };

const MODULE_PATH_FIX = `
$_mpDocs = [Environment]::GetFolderPath('MyDocuments')
@(
  [IO.Path]::Combine($_mpDocs,'PowerShell','Modules'),
  [IO.Path]::Combine($_mpDocs,'WindowsPowerShell','Modules'),
  [IO.Path]::Combine($HOME,'Documents','PowerShell','Modules'),
  [IO.Path]::Combine($HOME,'Documents','WindowsPowerShell','Modules'),
  [IO.Path]::Combine($HOME,'.local','share','powershell','Modules')
) + $(if($env:ProgramFiles){@(
  [IO.Path]::Combine($env:ProgramFiles,'PowerShell','Modules'),
  [IO.Path]::Combine($env:ProgramFiles,'PowerShell','7','Modules')
)}else{@()}) + $(if($env:LOCALAPPDATA){@(
  [IO.Path]::Combine($env:LOCALAPPDATA,'PowerShell','Modules')
)}else{@()}) | ForEach-Object {
  if ($_ -and (Test-Path $_ -EA SilentlyContinue)) {
    $cur = ($env:PSModulePath -split [IO.Path]::PathSeparator)
    if ($_ -notin $cur) { $env:PSModulePath = $_ + [IO.Path]::PathSeparator + $env:PSModulePath }
  }
}
`;

function probePS(exe) {
  return new Promise(resolve => {
    const cmd = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'\n${MODULE_PATH_FIX}\n$info=@{PSVersion=$PSVersionTable.PSVersion.ToString();DocsFolder=[Environment]::GetFolderPath('MyDocuments');GraphAuth=$null;GraphUsers=$null;ExoMgmt=$null}\n$g=Get-Module -ListAvailable -Name Microsoft.Graph.Authentication -EA SilentlyContinue|Select -First 1;if($g){$info.GraphAuth=$g.Version.ToString()}\n$gu=Get-Module -ListAvailable -Name Microsoft.Graph.Users -EA SilentlyContinue|Select -First 1;if($gu){$info.GraphUsers=$gu.Version.ToString()}\n$e=Get-Module -ListAvailable -Name ExchangeOnlineManagement -EA SilentlyContinue|Select -First 1;if($e){$info.ExoMgmt=$e.Version.ToString()}\n$info|ConvertTo-Json -Compress`;
    let stdout = "";
    const ps = spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", cmd], { timeout: 30000, shell: false });
    ps.stdout.on("data", d => { stdout += d.toString(); });
    ps.stderr.on("data", () => {});
    ps.on("error", () => resolve(null));
    ps.on("close", code => {
      if (code !== 0 || !stdout.trim()) return resolve(null);
      try { resolve({ exe, ...JSON.parse(stdout.trim()) }); } catch { resolve(null); }
    });
  });
}

async function detectPowerShell() {
  const candidates = os.platform() === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh"];
  for (const exe of candidates) {
    const r = await probePS(exe);
    if (r) {
      log(`Found ${exe} v${r.PSVersion} | Graph.Auth:${r.GraphAuth||"MISSING"} | Graph.Users:${r.GraphUsers||"MISSING"} | Exchange:${r.ExoMgmt||"MISSING"}`);
      if (r.GraphAuth) {
        detectedPS = { exe, version: r.PSVersion, graphModule: r.GraphAuth, graphUsersModule: r.GraphUsers, exoModule: r.ExoMgmt, probeError: null, ready: true, probing: false };
        return;
      }
    }
  }
  for (const exe of candidates) {
    const r = await probePS(exe);
    if (r) { detectedPS = { exe, version: r.PSVersion, graphModule: null, graphUsersModule: null, exoModule: r.ExoMgmt, probeError: "Microsoft.Graph not installed.", ready: false, probing: false }; return; }
  }
  detectedPS = { exe: null, version: null, graphModule: null, exoModule: null, probeError: "No PowerShell found.", ready: false, probing: false };
}

// ══════════════════════════════════════════════════════════════════════
//  SESSION POOL WIRING (v12 Phase 4b)
//
//  The per-tenant PowerShell engine + pool live in sessions.js. v11's single
//  process-global session/connection/queue is gone: each tenant slug gets its
//  own pwsh process, connection state, and FIFO queue. This removes the
//  shared-session credential bleed (a second user's reports ran against
//  whoever connected last). server.js injects PowerShell detection + the
//  logger, then resolves the caller's tenant session per request.
// ══════════════════════════════════════════════════════════════════════
sessions.configure({ getPS: () => detectedPS, log, moduleFix: MODULE_PATH_FIX });
const { jobs } = sessions;
// Evict tenant sessions idle > 30 min (frees the pwsh process + staged cert).
sessions.startEviction(30 * 60 * 1000);

// Audit "connection" identity: under the per-tenant pool there is no single
// global connection. Per-entry connection detail is recorded at each call site;
// this global provider is retained only for the local-dev single session.
setConnectionIdentityProvider(() => {
  const s = sessions.peekSession("local");
  return s ? s.connectionInfo.account : null;
});

// Local dev uses one implicit session ("local"); deployed callers name their
// tenant (the UI sends the selected tenant slug on every data request).
function slugForReq(req, explicit) {
  if (req.user && req.user.source === "local-dev") return explicit || "local";
  return explicit || null;
}

// Resolve (and authorize) the tenant session for a request. On failure it sends
// the error response and returns null. `requireGraph` → 409 if not connected.
function resolveSession(req, res, { requireGraph = false } = {}) {
  const explicit = (req.body && req.body.tenant) || req.query.tenant || null;
  const slug = slugForReq(req, explicit);
  if (!slug) { res.status(400).json({ error: "No tenant selected" }); return null; }
  // Tenant authorization (admins + local-dev bypass inside rbac.can). Never
  // trust the client's tenant choice without re-checking here.
  if (slug !== "local" && !rbac.can(req.user, { tenant: slug }, rbac.getStore())) {
    denyAudit(req, res, 403, "Not authorized for this tenant", { tenant: slug }); return null;
  }
  const s = sessions.getSession(slug);
  if (requireGraph && !s.connectionInfo.graphConnected) { res.status(409).json({ error: "Connect to Graph first" }); return null; }
  return s;
}

// Cache browse results (into the tenant session's cache) when a job finishes.
function cacheWhenDone(s, jobId, key) {
  const iv = setInterval(() => { const j = jobs.get(jobId); if (j && j.status !== "running" && j.status !== "queued") { clearInterval(iv); if (j.output.trim()) { try { let d = JSON.parse(j.output.trim()); if (!Array.isArray(d)) d = [d]; s.entityCache[key] = { data: d, at: Date.now() }; } catch {} } } }, 500);
}


// ══════════════════════════════════════════════════════════════════════
//  COMMAND SAFETY
// ══════════════════════════════════════════════════════════════════════

// Mutating / dangerous patterns. NOTE: Invoke-MgGraphRequest is deliberately
// NOT matched by the Invoke-Mg pattern (negative lookahead) — it is the
// read-path for REST calls and is validated separately for -Method GET.
// (v10 blocked ALL Invoke-Mg*, which silently 403'd every SharePoint report;
// the frontend then polled /api/job/undefined and displayed its 404 "Not
// found" as if it came from Graph. See CHANGELOG v11.0.0.)
const BLOCKED = [/\bSet-Mg/i, /\bNew-Mg/i, /\bRemove-Mg/i, /\bUpdate-Mg/i, /\bInvoke-Mg(?!GraphRequest\b)/i, /\bSet-EXO/i, /\bNew-EXO/i, /\bRemove-EXO/i, /\bSet-Mailbox\b/i, /\bNew-Mailbox\b/i, /\bRemove-Mailbox\b/i, /Invoke-Expression/i, /\biex\s/i, /Invoke-Command\b/i, /Start-Process/i, /Invoke-WebRequest/i, /Invoke-RestMethod/i];
function isSafe(cmd) {
  for (const line of cmd.split("\n")) {
    const t = line.trim();
    if (t.startsWith("#") || t === "") continue;
    if (/\bInvoke-MgGraphRequest\b/i.test(t)) {
      const m = t.match(/-Method\s+['"]?([A-Za-z]+)/i);
      const method = m ? m[1].toUpperCase() : "GET";
      // Exception: POST to the Microsoft Search API /search/query endpoint —
      // semantically a read-only query; required because delegated auth has
      // no GET endpoint that lists all site collections.
      const isSearchQuery = /-Uri\s+'https:\/\/graph\.microsoft\.com\/v1\.0\/search\/query'/i.test(t);
      if (!(method === "GET" || (method === "POST" && isSearchQuery)))
        return { ok: false, why: "Invoke-MgGraphRequest is permitted with -Method GET only (read-only tool; exception: POST to /search/query)" };
    }
    for (const p of BLOCKED) if (p.test(t)) return { ok: false, why: `Blocked: ${p}` };
  }
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════
//  API
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
//  v12 RBAC — access + authorization guards (Phase 3)
//
//  Layers: (1) an access gate on all /api/* (except health) requires an
//  authenticated caller who may use the tool; (2) per-route tenant/report
//  guards; (3) admin-only routes. Every DENY is audited (allows are covered by
//  each action's own audit call). Localhost dev is a full admin (see auth.js),
//  so local behavior is unchanged.
// ══════════════════════════════════════════════════════════════════════
function denyAudit(req, res, code, reason, extra = {}) {
  audit(req, "authz.deny", { reason, path: req.originalUrl, ...extra });
  return res.status(code).json({ error: reason });
}

// Overall access gate — mounted on /api, skips the unauthenticated health probe.
app.use("/api", (req, res, next) => {
  if (req.path === "/health") return next();
  let store;
  try { store = rbac.getStore(); } catch (e) { return res.status(500).json({ error: "Authorization store unavailable" }); }
  const u = req.user;
  if (!u || !u.upn) return denyAudit(req, res, 401, "Not authenticated");
  if (!rbac.hasToolAccess(u, store)) return denyAudit(req, res, 403, "Not authorized to use this tool");
  next();
});

// Report guard (report-only): reportId from body or route params.
function guardReport(req, res, next) {
  const reportId = (req.body && req.body.reportId) || req.params.reportId || null;
  if (!reportId) return next(); // missing-id shape errors are handled by the route
  if (!rbac.can(req.user, { reportId }, rbac.getStore()))
    return denyAudit(req, res, 403, "Not authorized for this report", { reportId });
  next();
}

// Admin-only guard.
function requireAdmin(req, res, next) {
  if (!rbac.isAdmin(req.user, rbac.getStore())) return denyAudit(req, res, 403, "Admin only");
  next();
}

// Liveness probe (unauthenticated; the access gate skips it). Connection state
// is per-tenant now, so it moved to /api/connection (authenticated) below.
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: VERSION, dockerMode: DOCKER_MODE, ps: { exe: detectedPS.exe, version: detectedPS.version, graphModule: detectedPS.graphModule, graphUsersModule: detectedPS.graphUsersModule, exoModule: detectedPS.exoModule, ready: detectedPS.ready, probing: detectedPS.probing, error: detectedPS.probeError }, platform: os.platform() });
});

// Per-tenant connection status for the caller's selected tenant. The UI polls
// this (with ?tenant=slug) to render the connection banner. Does NOT spin up a
// session — peek only — so polling is cheap and side-effect-free.
app.get("/api/connection", (req, res) => {
  const explicit = req.query.tenant || null;
  const slug = slugForReq(req, explicit);
  const empty = { graphConnected: false, exchangeConnected: false, account: null, tenantId: null, clientId: null };
  if (!slug) return res.json({ tenant: null, ...empty });
  if (slug !== "local" && !rbac.can(req.user, { tenant: slug }, rbac.getStore()))
    return denyAudit(req, res, 403, "Not authorized for this tenant", { tenant: slug });
  const s = sessions.peekSession(slug);
  res.json({ tenant: slug, psReady: detectedPS.ready, ...(s ? s.connectionInfo : empty) });
});

app.get("/api/logs", (req, res) => {
  res.json({
    logs: diagLog, psReady: detectedPS.ready,
    sessions: sessions.allSessions().map(s => ({ slug: s.slug, alive: s.psAlive, graph: s.connectionInfo.graphConnected, exchange: s.connectionInfo.exchangeConnected, account: s.connectionInfo.account, lastUsedAt: new Date(s.lastUsedAt).toISOString() })),
  });
});

app.post("/api/test-session", (req, res) => {
  const s = sessions.getSession(slugForReq(req, req.body && req.body.tenant) || "local");
  const jobId = uuidv4();
  sessions.runInSession(s, `[PSCustomObject]@{test='ok';time=(Get-Date -Format o);pid=$PID}|ConvertTo-Json -Compress`, jobId, { timeout: 15000 });
  res.json({ jobId });
});

// Re-probe PowerShell. Sessions start lazily on first use, so nothing to spin up.
app.post("/api/reprobe", async (req, res) => { detectedPS.probing = true; await detectPowerShell(); res.json({ ps: detectedPS }); });

app.post("/api/install-graph", (req, res) => {
  if (!detectedPS.exe) return res.status(400).json({ error: "No PowerShell." });
  const jobId = uuidv4();
  sessions.runOneShot(`$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop'\n${MODULE_PATH_FIX}\nWrite-Output "Installing..."\ntry{@('Microsoft.Graph.Authentication','Microsoft.Graph.Users','Microsoft.Graph.Groups','Microsoft.Graph.Identity.DirectoryManagement','Microsoft.Graph.Identity.SignIns','Microsoft.Graph.Reports','Microsoft.Graph.DeviceManagement','Microsoft.Graph.Sites','Microsoft.Graph.Files')|ForEach-Object{Write-Output "  $_...";Install-Module -Name $_ -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop};Write-Output "SUCCESS"}catch{Write-Error "Failed: $($_.Exception.Message)"}`, jobId);
  res.json({ jobId });
});

// ── Connect Graph (app-only cert per tenant; delegated only on localhost) ──
app.post("/api/connect/graph", (req, res) => {
  const { account, tenantId, useDeviceCode } = req.body || {};
  const store = rbac.getStore();
  const explicitSlug = (req.body && req.body.tenant) || null;
  const appTenant = tenants.tenantBySlug(store, explicitSlug)
    || (tenantId ? (store.tenants || []).find(t => t.tenantId === tenantId || t.id === tenantId) : null);

  // Tenant guard: a non-admin may only connect to a tenant they are granted.
  if (!rbac.isAdmin(req.user, store)) {
    const allowed = rbac.allowedTenants(req.user, store);
    const wanted = appTenant ? appTenant.id : (explicitSlug || tenantId);
    if (wanted) {
      if (!allowed.find(t => t.id === wanted || t.tenantId === wanted))
        return denyAudit(req, res, 403, "Not authorized for this tenant", { tenant: wanted });
    } else if (allowed.length === 0) {
      return denyAudit(req, res, 403, "No tenant access");
    }
  }

  // ── App-only (certificate) path — the norm in the deployed tool ──────
  // Connection identity is the app SP (never a person), so all users authorized
  // for this tenant safely share its session.
  if (KEY_VAULT_NAME && !useDeviceCode && tenants.isAppOnlyConfigured(appTenant)) {
    const s = sessions.getSession(appTenant.id);
    const jobId = uuidv4();
    // Pre-register the job so a fast poll doesn't 404 while the cert stages.
    jobs.set(jobId, { status: "running", output: "", error: "", info: "", slug: s.slug, startedAt: new Date().toISOString(), completedAt: null });
    sessions.clearDeviceCode();
    log(`CONNECT GRAPH (app-only): tenant=${appTenant.id}`);
    audit(req, "connect.graph", { tenant: appTenant.id, mode: "app-only", clientId: appTenant.clientId });
    (async () => {
      try {
        const cert = await tenants.stageTenantCert(appTenant, KEY_VAULT_NAME);
        s.certPath = cert.path;
        const cmd = tenants.buildGraphAppOnlyConnect(appTenant, cert.path);
        // raw: the connect command writes its own result to __OUTFILE__ (token
        // substituted only in raw mode). Without raw the token isn't replaced,
        // the result isn't captured, and the connect is never detected.
        sessions.runInSession(s, cmd, jobId, { timeout: 120000, raw: true });
        const iv = setInterval(() => {
          const j = jobs.get(jobId);
          if (j && j.status !== "running" && j.status !== "queued") {
            clearInterval(iv);
            if (j.output && j.output.trim()) {
              const raw = j.output.trim(); const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
              if (a !== -1 && b !== -1) { try { const d = JSON.parse(raw.substring(a, b + 1)); s.connectionInfo.graphConnected = true; s.connectionInfo.account = d.Account || appTenant.clientId; s.connectionInfo.clientId = d.ClientId || appTenant.clientId; s.connectionInfo.tenantId = d.TenantId || appTenant.tenantId; log(`CONNECTED (app-only) as ${s.connectionInfo.account} [${appTenant.id}]`); } catch {} }
            }
          }
        }, 500);
      } catch (e) {
        log(`APP-ONLY connect failed: ${e.message}`);
        jobs.set(jobId, { status: "error", output: "", error: `App-only connect failed: ${e.message}`, info: "", slug: s.slug, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
      }
    })();
    return res.json({ jobId });
  }

  // ── Delegated / device-code path — localhost dev ONLY ────────────────
  // SECURITY (v12 Phase 4b): refused in the deployed (multi-user) tool. A shared
  // delegated session would place one user's personal token in front of every
  // caller — exactly the bleed 4b removes. Delegated auth survives only as the
  // localhost-dev fallback (single implicit "local" session).
  if (DOCKER_MODE) {
    audit(req, "connect.graph.refused", { reason: "delegated-disabled-in-hosted", tenant: explicitSlug || tenantId || null });
    return res.status(400).json({ error: "Delegated sign-in is disabled in the hosted tool. Select an app-only configured tenant (certificate auth)." });
  }

  const s = sessions.getSession(slugForReq(req, explicitSlug) || "local");
  sessions.clearDeviceCode();
  log(`CONNECT GRAPH (delegated/local): session=${s.slug} account=${account || '(none)'} tenant=${tenantId || '(none)'} deviceCode=${!!useDeviceCode}`);
  audit(req, "connect.graph", { account: account || null, tenantId: tenantId || null, deviceCode: !!useDeviceCode, mode: "delegated" });

  const scopes = ["User.Read.All", "Group.Read.All", "Directory.Read.All", "Organization.Read.All", "AuditLog.Read.All", "Reports.Read.All", "Policy.Read.All", "RoleManagement.Read.Directory", "Sites.Read.All", "IdentityRiskyUser.Read.All", "DeviceManagementManagedDevices.Read.All", "DeviceManagementConfiguration.Read.All"];
  let args = `-Scopes "${scopes.join('","')}"`;
  if (tenantId && tenantId.trim()) args += ` -TenantId "${tenantId.replace(/[`$"'{}();&|]/g, "")}"`;
  if (useDeviceCode) args += ` -UseDeviceAuthentication`;
  const safeAcct = account ? account.replace(/[`$"'{}();&|]/g, "") : "";

  const jobId = uuidv4();
  // Run raw (no output capture / no Out-Null) so the device-code prompt streams
  // to stdout live; the context result is written to the job out-file instead.
  const cmd = `try { Disconnect-MgGraph -EA SilentlyContinue } catch {}\n${safeAcct ? `$env:AZURE_USERNAME = "${safeAcct}"\n` : ""}Connect-MgGraph ${args} -ErrorAction Stop\n$ctx = Get-MgContext\n[PSCustomObject]@{Account=$ctx.Account;TenantId=$ctx.TenantId;Scopes=($ctx.Scopes -join ", ")} | ConvertTo-Json -Compress | Out-File -FilePath '__OUTFILE__' -Encoding utf8`;

  sessions.runInSession(s, cmd, jobId, { timeout: useDeviceCode ? 300000 : 120000, raw: true });

  const iv = setInterval(() => {
    const j = jobs.get(jobId);
    if (j && j.status !== "running" && j.status !== "queued") {
      clearInterval(iv);
      sessions.clearDeviceCode();
      log(`CONNECT GRAPH done: ${j.status}`);
      if (j.output.trim()) {
        const raw = j.output.trim();
        const js = raw.indexOf("{"), je = raw.lastIndexOf("}");
        if (js !== -1 && je !== -1) {
          try { const d = JSON.parse(raw.substring(js, je + 1)); s.connectionInfo.graphConnected = true; s.connectionInfo.account = d.Account || account; s.connectionInfo.tenantId = d.TenantId || tenantId; log(`CONNECTED as ${s.connectionInfo.account}`); } catch {}
        }
        if (!s.connectionInfo.graphConnected && !j.error) { s.connectionInfo.graphConnected = true; s.connectionInfo.account = account; }
      }
    }
  }, 500);
  res.json({ jobId });
});

// ── Connect Exchange (app-only cert per tenant; delegated only on localhost) ──
app.post("/api/connect/exchange", (req, res) => {
  const { account } = req.body || {};
  const store = rbac.getStore();
  const explicitSlug = (req.body && req.body.tenant) || null;
  const appTenant = tenants.tenantBySlug(store, explicitSlug);

  // Tenant guard for the app-only path.
  if (appTenant && !rbac.isAdmin(req.user, store)) {
    if (!rbac.allowedTenants(req.user, store).find(t => t.id === appTenant.id))
      return denyAudit(req, res, 403, "Not authorized for this tenant", { tenant: appTenant.id });
  }

  // App-only (certificate) path — connects on the tenant's own session.
  if (KEY_VAULT_NAME && tenants.isAppOnlyConfigured(appTenant)) {
    const s = sessions.getSession(appTenant.id);
    const jobId = uuidv4();
    jobs.set(jobId, { status: "running", output: "", error: "", info: "", slug: s.slug, startedAt: new Date().toISOString(), completedAt: null });
    audit(req, "connect.exchange", { tenant: appTenant.id, mode: "app-only", clientId: appTenant.clientId });
    (async () => {
      try {
        const cert = await tenants.stageTenantCert(appTenant, KEY_VAULT_NAME);
        s.certPath = cert.path;
        const org = (req.body && req.body.org) || appTenant.orgDomain || null;
        const cmd = tenants.buildExchangeAppOnlyConnect(appTenant, cert.path, org);
        // raw: see the Graph app-only note — the command writes to __OUTFILE__.
        sessions.runInSession(s, cmd, jobId, { timeout: 120000, raw: true });
        const iv = setInterval(() => { const j = jobs.get(jobId); if (j && j.status !== "running" && j.status !== "queued") { clearInterval(iv); if (j.status === "completed" && j.output && j.output.trim()) s.connectionInfo.exchangeConnected = true; } }, 500);
      } catch (e) {
        log(`APP-ONLY exchange connect failed: ${e.message}`);
        jobs.set(jobId, { status: "error", output: "", error: `App-only Exchange connect failed: ${e.message}`, info: "", slug: s.slug, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
      }
    })();
    return res.json({ jobId });
  }

  // Delegated path — localhost dev ONLY (see the Graph route's security note).
  if (DOCKER_MODE) {
    audit(req, "connect.exchange.refused", { reason: "delegated-disabled-in-hosted", tenant: explicitSlug || null });
    return res.status(400).json({ error: "Delegated sign-in is disabled in the hosted tool. Select an app-only configured tenant (certificate auth)." });
  }
  const s = sessions.getSession(slugForReq(req, explicitSlug) || "local");
  const useDevCode = false; // DOCKER_MODE returned above; localhost uses browser
  const upn = account ? account.replace(/[`$"'{}();&|]/g, "") : "";
  sessions.clearDeviceCode();
  audit(req, "connect.exchange", { account: upn || null, deviceCode: useDevCode, mode: "delegated" });
  const jobId = uuidv4();
  // -DisableWAM (EXO 3.7+) skips the WAM broker path whose
  // WithBroker(BrokerOptions) overload is missing when the Graph SDK has
  // already loaded a different Microsoft.Identity.Client into the session.
  // -Device (EXO 3.x) uses device-code auth instead of launching a browser —
  // required in a headless container, where xdg-open/gnome-open don't exist.
  // Both are probed so older module versions still work. Runs raw so the
  // device-code prompt streams to stdout (surfaced to the UI), and the result
  // is written to the job out-file.
  const cmd = `$exoCmd = Get-Command Connect-ExchangeOnline -ErrorAction Stop
$exoParams = @{ ShowBanner = $false; ErrorAction = 'Stop' }
if ($exoCmd.Parameters.ContainsKey('DisableWAM')) { $exoParams['DisableWAM'] = $true }
${useDevCode ? `if ($exoCmd.Parameters.ContainsKey('Device')) { $exoParams['Device'] = $true }\n` : ""}${upn ? `$exoParams['UserPrincipalName'] = '${upn}'\n` : ""}try {
  Connect-ExchangeOnline @exoParams
  [PSCustomObject]@{status='connected'} | ConvertTo-Json -Compress | Out-File -FilePath '__OUTFILE__' -Encoding utf8
} catch {
  if ($_.Exception.Message -like '*WithBroker*' -or $_.Exception.Message -like '*Method not found*') {
    throw ("MSAL assembly conflict between the Graph SDK and ExchangeOnlineManagement in this session. Fixes, in order: (1) Restart Session, then connect EXCHANGE FIRST, then Graph. (2) Update both modules in an elevated PowerShell: Update-Module ExchangeOnlineManagement -Force; Update-Module Microsoft.Graph -Force; then restart the server. Original error: " + $_.Exception.Message)
  } else { throw }
}`;
  sessions.runInSession(s, cmd, jobId, { timeout: useDevCode ? 300000 : 120000, raw: true });
  const iv = setInterval(() => { const j = jobs.get(jobId); if (j && j.status !== "running" && j.status !== "queued") { clearInterval(iv); sessions.clearDeviceCode(); if (j.status === "completed" && j.output.trim()) s.connectionInfo.exchangeConnected = true; } }, 500);
  res.json({ jobId });
});

app.post("/api/disconnect", (req, res) => {
  const s = resolveSession(req, res);
  if (!s) return;
  audit(req, "disconnect", { tenant: s.slug, account: s.connectionInfo.account });
  const jobId = uuidv4();
  sessions.runInSession(s, `try{Disconnect-MgGraph -EA SilentlyContinue}catch{}\ntry{Disconnect-ExchangeOnline -Confirm:$false -EA SilentlyContinue}catch{}\n[PSCustomObject]@{status='disconnected'}|ConvertTo-Json -Compress`, jobId);
  s.connectionInfo = { graphConnected: false, exchangeConnected: false, account: null, tenantId: null, clientId: null };
  s.entityCache = { users: { data: null, at: null }, groups: { data: null, at: null }, licenses: { data: null, at: null } };
  s.dashCache = { at: 0, data: null };
  sessions.clearDeviceCode();
  res.json({ jobId });
});

app.post("/api/restart-session", (req, res) => {
  const s = resolveSession(req, res);
  if (!s) return;
  audit(req, "session.restart", { tenant: s.slug });
  sessions.restartSession(s);
  res.json({ status: "restarting" });
});

// ── Browse ──────────────────────────────────────────────────────────
app.get("/api/browse/users", (req, res) => {
  const s = resolveSession(req, res, { requireGraph: true });
  if (!s) return;
  if (s.entityCache.users.data && (Date.now() - s.entityCache.users.at) < 300000) return res.json({ cached: true, data: s.entityCache.users.data });
  const jobId = uuidv4(); sessions.runInSession(s, `Get-MgUser -All -Property "Id,DisplayName,UserPrincipalName,Mail,Department,JobTitle,AccountEnabled,UserType"|Select-Object Id,DisplayName,UserPrincipalName,Mail,Department,JobTitle,AccountEnabled,UserType|ConvertTo-Json -Depth 3 -Compress`, jobId); cacheWhenDone(s, jobId, "users"); res.json({ jobId });
});
app.get("/api/browse/groups", (req, res) => {
  const s = resolveSession(req, res, { requireGraph: true });
  if (!s) return;
  if (s.entityCache.groups.data && (Date.now() - s.entityCache.groups.at) < 300000) return res.json({ cached: true, data: s.entityCache.groups.data });
  const jobId = uuidv4(); sessions.runInSession(s, `Get-MgGroup -All -Property "Id,DisplayName,Mail,GroupTypes,SecurityEnabled,MailEnabled,Description"|Select-Object Id,DisplayName,Mail,@{N='Type';E={if($_.GroupTypes -contains 'Unified'){'Microsoft 365'}elseif($_.SecurityEnabled -and $_.MailEnabled){'Mail-Enabled Security'}elseif($_.SecurityEnabled){'Security'}elseif($_.MailEnabled){'Distribution'}else{'Other'}}},@{N='Dynamic';E={if($_.GroupTypes -contains 'DynamicMembership'){'Yes'}else{'No'}}},Description|ConvertTo-Json -Depth 3 -Compress`, jobId); cacheWhenDone(s, jobId, "groups"); res.json({ jobId });
});
app.get("/api/browse/licenses", (req, res) => {
  const s = resolveSession(req, res, { requireGraph: true });
  if (!s) return;
  if (s.entityCache.licenses.data && (Date.now() - s.entityCache.licenses.at) < 300000) return res.json({ cached: true, data: s.entityCache.licenses.data });
  const jobId = uuidv4(); sessions.runInSession(s, `Get-MgSubscribedSku -All|Select-Object SkuId,SkuPartNumber,@{N='Total';E={$_.PrepaidUnits.Enabled}},@{N='Assigned';E={$_.ConsumedUnits}},@{N='Available';E={$_.PrepaidUnits.Enabled-$_.ConsumedUnits}}|ConvertTo-Json -Depth 3 -Compress`, jobId); cacheWhenDone(s, jobId, "licenses"); res.json({ jobId });
});
app.post("/api/browse/refresh", (req, res) => { const s = resolveSession(req, res); if (!s) return; s.entityCache = { users: { data: null, at: null }, groups: { data: null, at: null }, licenses: { data: null, at: null } }; res.json({ ok: true }); });

// ── Report catalog (server-owned; client renders from this) ─────────
app.get("/api/reports", (req, res) => {
  const store = rbac.getStore();
  if (rbac.isAdmin(req.user, store)) return res.json(REPORTS);
  // Return only the areas/reports the caller may run; drop empty categories.
  const filtered = REPORTS
    .map(c => ({ ...c, items: c.items.filter(it => rbac.can(req.user, { reportId: it.id }, store)) }))
    .filter(c => c.items.length);
  res.json(filtered);
});

// ── Run report by ID ────────────────────────────────────────────────
// The client sends { reportId, params, fields } — never raw PowerShell.
// The command is built server-side from the catalog (reports.js), with
// params sanitized and fields validated against the whitelist. isSafe()
// remains as defense-in-depth.
app.post("/api/run", (req, res) => {
  const { reportId, params, fields } = req.body || {};
  if (!reportId) return res.status(400).json({ error: "No reportId" });
  const report = findReport(reportId);
  if (!report) return res.status(404).json({ error: `Unknown report: ${reportId}` });
  // Resolve + authorize the tenant session, then check the report for that tenant.
  const s = resolveSession(req, res);
  if (!s) return;
  if (!rbac.can(req.user, { tenant: s.slug, reportId }, rbac.getStore()))
    return denyAudit(req, res, 403, "Not authorized for this report", { tenant: s.slug, reportId });
  const cmd = buildCommand(report, fields, params);
  const c = isSafe(cmd);
  if (!c.ok) { log(`RUN ${reportId} REJECTED: ${c.why}`); audit(req, "report.rejected", { tenant: s.slug, reportId, why: c.why }); return res.status(403).json({ error: c.why }); }
  audit(req, "report.run", { tenant: s.slug, connection: s.connectionInfo.account, reportId, params: params || null, fields: fields || null });
  const jobId = uuidv4();
  // NOTE: no ConvertTo-Json here — the structured envelope serializes Data.
  sessions.runInSession(s, cmd, jobId, { structured: true });
  res.json({ jobId });
});

app.get("/api/job/:jobId", (req, res) => {
  const s = jobs.get(req.params.jobId);
  if (!s) return res.status(404).json({ error: "Job not found — the run request may have been rejected (check server logs)" });
  res.json({ status: s.status, output: s.output, error: s.error ? s.error.replace(/\x1b\[[0-9;]*m/g, "") : "", info: s.info || "", startedAt: s.startedAt, completedAt: s.completedAt, deviceCode: sessions.latestDeviceCode() });
});

app.post("/api/export", (req, res) => {
  const { data, filename } = req.body;
  if (!data) return res.status(400).json({ error: "No data" });
  const dir = path.join(DATA_DIR, "M365Reports");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `${filename || "report"}_${ts}.csv`);
  try {
    let rows = typeof data === "string" ? JSON.parse(data) : data;
    if (!Array.isArray(rows)) rows = [rows]; if (!rows.length) return res.status(400).json({ error: "Empty" });
    const hdr = Object.keys(rows[0]);
    const csv = [hdr.join(","), ...rows.map(r => hdr.map(h => { const v = String(r[h] ?? "").replace(/"/g, '""'); return v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v}"` : v; }).join(","))].join("\n");
    fs.writeFileSync(file, csv, "utf8"); res.json({ path: file, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Snapshots & diff ────────────────────────────────────────────────
// Point-in-time copies of report results, stored under ./M365Snapshots.
// Diff answers "what changed since <snapshot>" — the audit primitive.
app.post("/api/snapshots", guardReport, (req, res) => {
  const { reportId, rows, label, params, fields } = req.body || {};
  if (!reportId || !findReport(reportId)) return res.status(400).json({ error: "Unknown reportId" });
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "No rows to snapshot" });
  audit(req, "snapshot.save", { reportId, rowCount: rows.length, label: label || null });
  try { res.json(saveSnapshot(reportId, rows, { label, params, fields })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/snapshots/:reportId", guardReport, (req, res) => {
  if (!findReport(req.params.reportId)) return res.status(400).json({ error: "Unknown reportId" });
  res.json(listSnapshots(req.params.reportId));
});

app.get("/api/snapshots/:reportId/:id", guardReport, (req, res) => {
  const s = loadSnapshot(req.params.reportId, req.params.id);
  if (!s) return res.status(404).json({ error: "Snapshot not found" });
  res.json(s);
});

app.delete("/api/snapshots/:reportId/:id", guardReport, (req, res) => {
  audit(req, "snapshot.delete", { reportId: req.params.reportId, id: req.params.id });
  res.json({ deleted: deleteSnapshot(req.params.reportId, req.params.id) });
});

// Diff a snapshot (fromId) against either current rows (toRows) or a second
// snapshot (toId). Direction: from = older baseline, to = newer state.
app.post("/api/diff", guardReport, (req, res) => {
  const { reportId, fromId, toId, toRows } = req.body || {};
  if (!reportId || !findReport(reportId)) return res.status(400).json({ error: "Unknown reportId" });
  const from = loadSnapshot(reportId, fromId);
  if (!from) return res.status(404).json({ error: "Baseline snapshot not found" });
  let to;
  if (toId) { const s = loadSnapshot(reportId, toId); if (!s) return res.status(404).json({ error: "Comparison snapshot not found" }); to = s.rows; }
  else if (Array.isArray(toRows)) to = toRows;
  else return res.status(400).json({ error: "Provide toRows (current results) or toId (second snapshot)" });
  audit(req, "snapshot.diff", { reportId, fromId, toId: toId || "(current results)" });
  const d = diffRows(reportId, from.rows, to);
  res.json({ ...d, baseline: { id: from.id, takenAt: from.takenAt, label: from.label } });
});

// ── Audit packs ─────────────────────────────────────────────────────
// Runs a pack's reports sequentially (the job queue enforces serial
// execution anyway), optionally auto-snapshotting each result. Rows are
// held in memory for export and cleared after 30 minutes.
const packJobs = new Map();

async function runPack(packJob, pack, s, { snapshot, label }) {
  for (const rid of pack.reports) {
    const report = findReport(rid);
    const entry = packJob.results.find(r => r.reportId === rid);
    if (!report) { entry.status = "error"; entry.error = "Unknown report"; continue; }
    if (report.ex && !s.connectionInfo.exchangeConnected) { entry.status = "skipped"; entry.error = "Exchange not connected"; continue; }
    entry.status = "running";
    const cmd = buildCommand(report, null, {});
    const c = isSafe(cmd);
    if (!c.ok) { entry.status = "error"; entry.error = c.why; continue; }
    const jobId = uuidv4();
    sessions.runInSession(s, cmd, jobId, { structured: true });
    const j = await sessions.waitForJob(jobId);
    if (j.status === "completed" && j.output) {
      try {
        let rows = JSON.parse(j.output);
        if (!Array.isArray(rows)) rows = [rows];
        entry.rows = rows;
        entry.rowCount = rows.length;
        entry.status = "completed";
        if (snapshot && rows.length) {
          try { entry.snapshotId = saveSnapshot(rid, rows, { label: label || `pack:${pack.id}`, params: {}, fields: null }).id; }
          catch (e) { entry.snapshotError = e.message; }
        }
      } catch (e) { entry.status = "error"; entry.error = `Result parse failed: ${e.message}`; }
    } else if (j.status === "completed") {
      entry.status = "completed"; entry.rowCount = 0; entry.rows = [];
      if (j.error) entry.error = j.error;
    } else {
      entry.status = "error"; entry.error = j.error || "Failed";
    }
  }
  packJob.status = "completed";
  packJob.completedAt = new Date().toISOString();
  audit(null, "pack.complete", { packId: pack.id, results: packJob.results.map(r => ({ reportId: r.reportId, status: r.status, rowCount: r.rowCount ?? null })) });
  setTimeout(() => packJobs.delete(packJob.id), 30 * 60 * 1000);
}

app.get("/api/packs", (req, res) => {
  // Decorate with report names and Exchange requirements for the UI.
  res.json(PACKS.map(p => ({
    ...p,
    reports: p.reports.map(rid => { const r = findReport(rid); return { id: rid, name: r ? r.name : rid, ex: r ? !!r.ex : false }; }),
  })));
});

app.post("/api/pack/run", (req, res) => {
  const { packId, snapshot = true, label } = req.body || {};
  const pack = findPack(packId);
  if (!pack) return res.status(404).json({ error: `Unknown pack: ${packId}` });
  const s = resolveSession(req, res, { requireGraph: true });
  if (!s) return;
  // Authorization: every report in the pack must be allowed for the caller.
  const store = rbac.getStore();
  const denied = pack.reports.filter(rid => !rbac.can(req.user, { tenant: s.slug, reportId: rid }, store));
  if (denied.length) return denyAudit(req, res, 403, "Not authorized for one or more reports in this pack", { tenant: s.slug, packId, denied });
  const cleanLabel = label ? String(label).slice(0, 120) : "";
  audit(req, "pack.run", { tenant: s.slug, packId, snapshot: !!snapshot, label: cleanLabel || null });
  const packJob = {
    id: uuidv4(),
    packId,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    results: pack.reports.map(rid => { const r = findReport(rid); return { reportId: rid, name: r ? r.name : rid, status: "pending", rowCount: null, error: null, snapshotId: null, rows: null }; }),
  };
  packJobs.set(packJob.id, packJob);
  runPack(packJob, pack, s, { snapshot: !!snapshot, label: cleanLabel }); // fire and forget
  res.json({ packJobId: packJob.id });
});

// Status: everything except the row data (kept lean for polling).
app.get("/api/pack/job/:id", (req, res) => {
  const p = packJobs.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Pack job not found or expired" });
  res.json({ ...p, results: p.results.map(({ rows, ...rest }) => rest) });
});

// Rows for one report in a finished pack (for client-side CSV export).
app.get("/api/pack/job/:id/rows/:reportId", (req, res) => {
  const p = packJobs.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Pack job not found or expired" });
  const entry = p.results.find(r => r.reportId === req.params.reportId);
  if (!entry) return res.status(404).json({ error: "Report not in this pack" });
  res.json({ reportId: entry.reportId, name: entry.name, rows: entry.rows || [] });
});

// ── Dashboard ───────────────────────────────────────────────────────
// One aggregated Graph pass using $count queries (ConsistencyLevel:
// eventual) — cheap even on large tenants. Cached for 5 minutes per tenant
// session; ?refresh=1 forces a re-run.
const DASH_CMD = `$H = @{ ConsistencyLevel = 'eventual' }
$totalUsers = (Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/users?$count=true&$top=1&$select=id' -Headers $H)['@odata.count']
$disabled = (Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/users?$filter=accountEnabled%20eq%20false&$count=true&$top=1&$select=id' -Headers $H)['@odata.count']
$guests = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/users?\`$filter=userType%20eq%20'Guest'&\`$count=true&\`$top=1&\`$select=id" -Headers $H)['@odata.count']
$groups = (Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/groups?$count=true&$top=1&$select=id' -Headers $H)['@odata.count']
$devices = (Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/devices?$count=true&$top=1&$select=id' -Headers $H)['@odata.count']
$skus = (Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/subscribedSkus').value
$licTotal = 0; $licUsed = 0; $licExcluded = 0
foreach ($s in $skus) {
  $en = [int]$s.prepaidUnits.enabled
  if ($en -ge 10000) { $licExcluded++; continue }
  $licTotal += $en; $licUsed += [int]$s.consumedUnits
}
$ca = (Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies?$select=id,state' -ErrorAction SilentlyContinue).value
[PSCustomObject]@{
  TotalUsers = $totalUsers; EnabledUsers = ($totalUsers - $disabled); DisabledUsers = $disabled; GuestUsers = $guests
  Groups = $groups; Devices = $devices
  LicensesTotal = $licTotal; LicensesUsed = $licUsed; SkuCount = @($skus).Count; SkusExcluded = $licExcluded
  CAPolicies = @($ca).Count; CAEnabled = @($ca | Where-Object { $_.state -eq 'enabled' }).Count
}`;

app.get("/api/dashboard", async (req, res) => {
  const s = resolveSession(req, res, { requireGraph: true });
  if (!s) return;
  const force = req.query.refresh === "1";
  if (!force && s.dashCache.data && Date.now() - s.dashCache.at < 5 * 60 * 1000) {
    return res.json({ ...s.dashCache.data, cachedAt: new Date(s.dashCache.at).toISOString(), cached: true });
  }
  const c = isSafe(DASH_CMD);
  if (!c.ok) return res.status(500).json({ error: c.why }); // defense-in-depth; should never fire
  audit(req, "dashboard.refresh", { tenant: s.slug, forced: force });
  const jobId = uuidv4();
  sessions.runInSession(s, DASH_CMD, jobId, { structured: true });
  const j = await sessions.waitForJob(jobId, 120000);
  if (j.status !== "completed" || !j.output) return res.status(502).json({ error: j.error || "Dashboard query failed" });
  try {
    let data = JSON.parse(j.output);
    if (Array.isArray(data)) data = data[0] || {};
    s.dashCache = { at: Date.now(), data };
    res.json({ ...data, cachedAt: new Date(s.dashCache.at).toISOString(), cached: false });
  } catch (e) { res.status(502).json({ error: `Dashboard parse failed: ${e.message}` }); }
});

// ── Config & audit ──────────────────────────────────────────────────
app.get("/api/config", (req, res) => {
  const store = rbac.getStore();
  // Only the tenants the caller may reach (friendly-name dropdown source).
  const tenants = rbac.allowedTenants(req.user, store)
    .map(t => ({ id: t.id, name: t.name, tenantId: t.tenantId }));
  // admin flag drives whether the client renders the admin (access-control) UI;
  // every admin route is independently server-gated by requireAdmin regardless.
  // `me` echoes only the caller's OWN resolved identity (no leak) so the admin
  // signal path — notably Global Admin via the wids claim — can be confirmed live.
  res.json({
    tenants,
    admin: rbac.isAdmin(req.user, store),
    me: { upn: req.user.upn || null, adminVia: req.user.adminVia || [] },
  });
});
app.get("/api/audit", requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  // integrity = the tamper-evident hash chain's verdict (Phase 4b).
  let integrity; try { integrity = verifyAuditChain(); } catch (e) { integrity = { ok: false, error: e.message }; }
  res.json({ entries: readAudit(limit), integrity });
});

// ══════════════════════════════════════════════════════════════════════
//  v12 RBAC Phase 5 — admin management API (admin-gated CRUD over the store)
//
//  Every route below is guarded by requireAdmin and writes through
//  rbac.saveStore (atomic temp-file + rename). Mutations clone the cached
//  store so the in-memory cache is never edited in place; the mtime-cache in
//  rbac.js reloads the fresh copy on the next read, so edits take effect live.
//  Writes are serialized by Node's single-threaded event loop + the atomic
//  rename; the single-admin-writer assumption from Phase 2 still holds.
// ══════════════════════════════════════════════════════════════════════

// The report catalog the role editor needs: areas, each with its report ids.
function adminCatalog() {
  return REPORTS.map(c => ({ area: c.category, items: c.items.map(i => ({ id: i.id, name: i.name })) }));
}

// Derive a stable slug (mirrors rbac.js's internal slug()).
const adminSlug = (s) => (s ? String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "");

// Load → clone → mutate → save, with uniform error handling. `fn(next)` mutates
// the clone and returns the response payload (or throws a message for a 400).
function mutateStore(req, res, action, fn) {
  let store;
  try { store = rbac.getStore(); } catch (e) { return res.status(500).json({ error: `Store unavailable: ${e.message}` }); }
  const next = JSON.parse(JSON.stringify(store));
  let payload;
  try { payload = fn(next); } catch (e) { return res.status(400).json({ error: e.message }); }
  try { rbac.saveStore(next); } catch (e) { return res.status(500).json({ error: `Save failed: ${e.message}` }); }
  audit(req, action, payload && payload.__audit ? payload.__audit : {});
  if (payload && payload.__audit) delete payload.__audit;
  return res.json(payload || { ok: true });
}

// Normalize a role's tenant scope: "*" (all) or an array of tenant slugs.
function normTenants(t) {
  if (t === "*") return "*";
  return Array.isArray(t) ? [...new Set(t.map(String).filter(Boolean))] : [];
}
// Normalize a role's report scope: "*" (all) or { areas: "*"|[], ids: [] }.
function normReports(r) {
  if (r === "*" || (r && r.areas === "*")) return "*";
  if (r && typeof r === "object") {
    return {
      areas: Array.isArray(r.areas) ? [...new Set(r.areas.map(String).filter(Boolean))] : [],
      ids: Array.isArray(r.ids) ? [...new Set(r.ids.map(String).filter(Boolean))] : [],
    };
  }
  return { areas: [], ids: [] }; // default-deny: no explicit grant → nothing
}

// Full authZ model + the catalog metadata the role editor renders from.
app.get("/api/admin/store", requireAdmin, (req, res) => {
  const s = rbac.getStore();
  res.json({
    accessGroupId: s.accessGroupId || "",
    adminGroupId: s.adminGroupId || "",
    tenants: s.tenants || [],
    roles: s.roles || [],
    assignments: s.assignments || [],
    catalog: adminCatalog(),
    areas: allAreas(),
  });
});

// ── Tenants ───────────────────────────────────────────────────────────
app.post("/api/admin/tenants", requireAdmin, (req, res) => {
  const { id, name, tenantId, clientId, certSecret, orgDomain } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Tenant name is required" });
  mutateStore(req, res, "admin.tenant.save", (s) => {
    const sid = (id && String(id).trim()) || adminSlug(name);
    if (!sid) throw new Error("Could not derive a tenant id from the name");
    const entry = {
      id: sid, name: String(name).trim(),
      tenantId: (tenantId && String(tenantId).trim()) || null,
      clientId: (clientId && String(clientId).trim()) || null,
      certSecret: (certSecret && String(certSecret).trim()) || null,
      // Exchange app-only -Organization: a verified/.onmicrosoft.com domain (NOT
      // the tenant GUID). Optional; falls back to tenantId only if unset.
      orgDomain: (orgDomain && String(orgDomain).trim()) || null,
    };
    const i = s.tenants.findIndex(t => t.id === sid);
    if (i >= 0) s.tenants[i] = entry; else s.tenants.push(entry);
    // Return a copy (not the stored object) so the audit marker never persists.
    return { ...entry, __audit: { id: sid, updated: i >= 0 } };
  });
});

app.delete("/api/admin/tenants/:id", requireAdmin, (req, res) => {
  mutateStore(req, res, "admin.tenant.delete", (s) => {
    const id = req.params.id;
    s.tenants = (s.tenants || []).filter(t => t.id !== id);
    // Scrub the deleted tenant from any role that scoped to it.
    for (const r of s.roles || []) if (Array.isArray(r.tenants)) r.tenants = r.tenants.filter(t => t !== id);
    return { ok: true, id, __audit: { id } };
  });
});

// ── Roles ─────────────────────────────────────────────────────────────
app.post("/api/admin/roles", requireAdmin, (req, res) => {
  const { id, name, tenants: rt, reports } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Role name is required" });
  mutateStore(req, res, "admin.role.save", (s) => {
    const sid = (id && String(id).trim()) || adminSlug(name);
    if (!sid) throw new Error("Could not derive a role id from the name");
    const entry = { id: sid, name: String(name).trim(), tenants: normTenants(rt), reports: normReports(reports) };
    const i = s.roles.findIndex(r => r.id === sid);
    if (i >= 0) s.roles[i] = entry; else s.roles.push(entry);
    return { ...entry, __audit: { id: sid, updated: i >= 0 } };
  });
});

app.delete("/api/admin/roles/:id", requireAdmin, (req, res) => {
  mutateStore(req, res, "admin.role.delete", (s) => {
    const id = req.params.id;
    s.roles = (s.roles || []).filter(r => r.id !== id);
    // Scrub the deleted role from every assignment that granted it.
    for (const a of s.assignments || []) if (Array.isArray(a.roles)) a.roles = a.roles.filter(x => x !== id);
    return { ok: true, id, __audit: { id } };
  });
});

// ── Assignments (user/group → roles) ──────────────────────────────────
app.post("/api/admin/assignments", requireAdmin, (req, res) => {
  const { principalType, principal, roles } = req.body || {};
  if (principalType !== "user" && principalType !== "group")
    return res.status(400).json({ error: "principalType must be 'user' or 'group'" });
  if (!principal || !String(principal).trim()) return res.status(400).json({ error: "A principal (UPN or group object id) is required" });
  mutateStore(req, res, "admin.assignment.save", (s) => {
    const p = String(principal).trim();
    const entry = { principalType, principal: p, roles: Array.isArray(roles) ? [...new Set(roles.map(String).filter(Boolean))] : [] };
    const i = (s.assignments || []).findIndex(a => a.principalType === principalType && String(a.principal).toLowerCase() === p.toLowerCase());
    if (i >= 0) s.assignments[i] = entry; else s.assignments.push(entry);
    return { ...entry, __audit: { principalType, principal: p, roles: entry.roles, updated: i >= 0 } };
  });
});

app.delete("/api/admin/assignments/:principalType/:principal", requireAdmin, (req, res) => {
  mutateStore(req, res, "admin.assignment.delete", (s) => {
    const pt = req.params.principalType;
    const p = decodeURIComponent(req.params.principal).toLowerCase();
    s.assignments = (s.assignments || []).filter(a => !(a.principalType === pt && String(a.principal).toLowerCase() === p));
    return { ok: true, __audit: { principalType: pt, principal: p } };
  });
});

// ── Bootstrap group ids (overall-access gate + admin bootstrap) ───────
app.put("/api/admin/groups", requireAdmin, (req, res) => {
  const { accessGroupId, adminGroupId } = req.body || {};
  const clean = (v) => (v && String(v).trim() ? String(v).trim() : null);
  mutateStore(req, res, "admin.groups.save", (s) => {
    s.accessGroupId = clean(accessGroupId);
    s.adminGroupId = clean(adminGroupId);
    return { accessGroupId: s.accessGroupId, adminGroupId: s.adminGroupId, __audit: { accessGroupId: s.accessGroupId, adminGroupId: s.adminGroupId } };
  });
});

// ── Static ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Startup ─────────────────────────────────────────────────────────
(async () => {
  console.log(`\n  M365 Admin Reports Server v${VERSION}\n`);
  await detectPowerShell();
  // Tenant sessions start lazily on first connect (per-tenant pool, Phase 4b);
  // nothing to spin up at boot.
  app.listen(PORT, HOST, () => { console.log(`  → http://localhost:${PORT} (bound to ${HOST})\n  → PowerShell: ${detectedPS.ready ? "READY" : "NOT READY"} | sessions start on demand\n`); });
})();

// Tear down every tenant session's pwsh on exit (don't orphan child processes).
function shutdown() { for (const s of sessions.allSessions()) { try { s.psProc && s.psProc.kill(); } catch {} } process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
