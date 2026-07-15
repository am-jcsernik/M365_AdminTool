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
const { REPORTS, findReport, buildCommand } = require("./reports.js");
const { saveSnapshot, listSnapshots, loadSnapshot, deleteSnapshot, diffRows } = require("./snapshots.js");
const { audit, readAudit, setConnectionIdentityProvider } = require("./audit.js");
const { PACKS, findPack } = require("./packs.js");
const { userMiddleware } = require("./auth.js");
const rbac = require("./rbac.js");

const app = express();
const PORT = process.env.PORT || 3365;
const DOCKER_MODE = !!process.env.DOCKER_MODE;
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
const TEMP_DIR = path.join(os.tmpdir(), "m365-admin-reports");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
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
//  PERSISTENT SESSION
// ══════════════════════════════════════════════════════════════════════

let psProc = null, psAlive = false;

function startSession() {
  if (!detectedPS.exe) return;
  log(`Starting session: ${detectedPS.exe}`);
  // -NonInteractive is required: without it PSReadLine loads and renders the
  // session as a terminal, emitting escape sequences that swallow MSAL's
  // device-code prompt. With it, `Connect-MgGraph -UseDeviceAuthentication`
  // prints the code as a clean line we can capture and surface to the UI.
  psProc = spawn(detectedPS.exe, ["-NoProfile", "-NonInteractive", "-NoExit", "-Command", "-"], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"], shell: false });
  psAlive = true;
  log(`Session PID: ${psProc.pid}`);

  psProc.stdout.on("data", d => {
    const s = d.toString();
    // MSAL device-code prompt, e.g. "To sign in, use a web browser to open the
    // page https://microsoft.com/devicelogin and enter the code ABCD1234 to
    // authenticate." Capture it so the UI can display the link + code instead
    // of the operator having to tail the server/container console.
    const m = s.match(/open the page\s+(\S+)\s+and enter the code\s+([A-Za-z0-9]+)/i);
    if (m) { deviceCode = { url: m[1], code: m[2], at: Date.now() }; log(`[device-code] enter ${deviceCode.code} at ${deviceCode.url}`); }
    const t = s.trim();
    if (t && t.length < 300) log(`[PS out] ${t}`);
  });
  psProc.stderr.on("data", d => { const t = d.toString().replace(/\x1b\[[0-9;]*m/g, "").trim(); if (t && !t.startsWith(">>")) log(`[PS err] ${t.slice(0, 200)}`); });
  psProc.on("close", code => { log(`Session closed (${code})`); psAlive = false; });
  psProc.on("error", err => { log(`Session error: ${err.message}`); psAlive = false; });

  const init = `$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'\n${MODULE_PATH_FIX}\n@('Microsoft.Graph.Authentication','Microsoft.Graph.Users','Microsoft.Graph.Groups','Microsoft.Graph.Identity.DirectoryManagement','Microsoft.Graph.Identity.SignIns','Microsoft.Graph.Reports','Microsoft.Graph.DeviceManagement','Microsoft.Graph.Sites','Microsoft.Graph.Files')|ForEach-Object{if(Get-Module -ListAvailable -Name $_ -EA SilentlyContinue){Import-Module $_ -EA SilentlyContinue}}\nif(Get-Module -ListAvailable -Name ExchangeOnlineManagement -EA SilentlyContinue){Import-Module ExchangeOnlineManagement -EA SilentlyContinue}\nWrite-Host "[M365] Session initialized"`;
  psProc.stdin.write(init + "\n");
}

// ══════════════════════════════════════════════════════════════════════
//  FILE-BASED COMMAND EXECUTION
// ══════════════════════════════════════════════════════════════════════

const jobs = new Map();
let connectionInfo = { graphConnected: false, exchangeConnected: false, account: null, tenantId: null };
// Most recent device-code prompt ({ url, code, at }), surfaced to the client
// during a device-code connect. Null when none is pending.
let deviceCode = null;
setConnectionIdentityProvider(() => connectionInfo.account || null);
let entityCache = { users: { data: null, at: null }, groups: { data: null, at: null }, licenses: { data: null, at: null } };

// ── Job queue ─────────────────────────────────────────────────────────
// The persistent pwsh session has ONE stdin. Concurrent jobs would
// interleave scripts and corrupt each other's output, so all session
// commands flow through a FIFO queue: one command in flight at a time.
const jobQueue = [];
let activeJobId = null;

function runInSession(command, jobId, opts = {}) {
  const session = { status: "queued", output: "", error: "", info: "", startedAt: new Date().toISOString(), completedAt: null };
  jobs.set(jobId, session);
  jobQueue.push({ command, jobId, opts });
  pumpQueue();
  return jobId;
}

function pumpQueue() {
  if (activeJobId !== null || jobQueue.length === 0) return;
  const item = jobQueue.shift();
  activeJobId = item.jobId;
  executeInSession(item);
}

function finishActive() { activeJobId = null; setImmediate(pumpQueue); }

// Structured envelope: runs the command capturing ALL PowerShell streams
// (output, error, warning, information) and writes a single JSON envelope
// to the .out file. This replaces the old wrapper whose & { } block
// swallowed diagnostics (errors went to .err with no context — the root
// of the long SharePoint debugging saga).
function buildStructuredScript(command, shortId, outFile, doneFile, esc) {
  return `# Job: ${shortId} (structured)
$__data = @(); $__errs = @(); $__warns = @(); $__infos = @()
try {
  $__all = & {
${command}
  } *>&1
  foreach ($__x in $__all) {
    if ($__x -is [System.Management.Automation.ErrorRecord]) { $__errs += $__x.ToString() }
    elseif ($__x -is [System.Management.Automation.WarningRecord]) { $__warns += $__x.ToString() }
    elseif ($__x -is [System.Management.Automation.InformationRecord]) { $__infos += $__x.ToString() }
    elseif ($__x -is [System.Management.Automation.VerboseRecord]) { }
    elseif ($__x -is [System.Management.Automation.DebugRecord]) { }
    else { $__data += $__x }
  }
} catch {
  $__errs += $_.Exception.Message
  if ($_.ScriptStackTrace) { $__errs += $_.ScriptStackTrace }
}
[PSCustomObject]@{ Success = ($__errs.Count -eq 0); Data = $__data; Errors = $__errs; Warnings = $__warns; Information = $__infos } | ConvertTo-Json -Depth 7 -WarningAction SilentlyContinue | Out-File -FilePath '${esc(outFile)}' -Encoding utf8 -Width 99999
'done' | Out-File -FilePath '${esc(doneFile)}' -Encoding utf8`;
}

function buildLegacyScript(command, shortId, outFile, errFile, doneFile, esc) {
  return `# Job: ${shortId}\ntry {\n  $__r = & {\n${command}\n  }\n  if ($null -ne $__r) { $__r | Out-File -FilePath '${esc(outFile)}' -Encoding utf8 -Width 99999 } else { '' | Out-File -FilePath '${esc(outFile)}' -Encoding utf8 }\n} catch {\n  $_.Exception.Message | Out-File -FilePath '${esc(errFile)}' -Encoding utf8\n  $_.ScriptStackTrace | Out-File -FilePath '${esc(errFile)}' -Append -Encoding utf8\n}\n'done' | Out-File -FilePath '${esc(doneFile)}' -Encoding utf8`;
}

// Passthrough execution: the command runs at statement level — NOT captured
// into a variable and NOT piped to Out-Null — so host/Success-stream output
// (notably the MSAL device-code prompt emitted during Connect-MgGraph) streams
// to the session stdout live, where startSession()'s handler can surface it.
// The command writes its own result to __OUTFILE__ (token replaced here).
function buildRawScript(command, shortId, outFile, errFile, doneFile, esc) {
  const cmd = command.replace(/__OUTFILE__/g, esc(outFile));
  return `# Job: ${shortId} (raw)\ntry {\n${cmd}\n} catch {\n  $_.Exception.Message | Out-File -FilePath '${esc(errFile)}' -Encoding utf8\n  $_.ScriptStackTrace | Out-File -FilePath '${esc(errFile)}' -Append -Encoding utf8\n}\n'done' | Out-File -FilePath '${esc(doneFile)}' -Encoding utf8`;
}

function executeInSession({ command, jobId, opts }) {
  const { timeout = 300000, structured = false, raw = false } = opts;
  const session = jobs.get(jobId);
  session.status = "running";
  const shortId = jobId.slice(0, 8);
  log(`[${shortId}] JOB${structured ? " (structured)" : ""}: ${command.replace(/\s+/g, " ").slice(0, 80)}...`);

  if (!psAlive || !psProc || !psProc.stdin || psProc.stdin.destroyed) {
    session.status = "error"; session.error = "PowerShell session not running."; session.completedAt = new Date().toISOString();
    finishActive(); return;
  }

  const outFile = path.join(TEMP_DIR, `${jobId}.out`);
  const errFile = path.join(TEMP_DIR, `${jobId}.err`);
  const doneFile = path.join(TEMP_DIR, `${jobId}.done`);
  const scriptFile = path.join(TEMP_DIR, `${jobId}.ps1`);
  const esc = s => s.replace(/\\/g, "\\\\");

  const script = structured
    ? buildStructuredScript(command, shortId, outFile, doneFile, esc)
    : raw
      ? buildRawScript(command, shortId, outFile, errFile, doneFile, esc)
      : buildLegacyScript(command, shortId, outFile, errFile, doneFile, esc);
  fs.writeFileSync(scriptFile, script, "utf8");

  let jobStderr = "";
  const stderrW = d => { jobStderr += d.toString().replace(/\x1b\[[0-9;]*m/g, ""); };
  psProc.stderr.on("data", stderrW);

  try { psProc.stdin.write(`. '${scriptFile.replace(/'/g, "''")}'\n`); } catch (e) {
    psProc.stderr.removeListener("data", stderrW);
    session.status = "error"; session.error = e.message; session.completedAt = new Date().toISOString();
    finishActive(); return;
  }

  const cleanupFiles = () => setTimeout(() => { for (const f of [scriptFile, outFile, errFile, doneFile]) try { fs.unlinkSync(f); } catch {} }, 5000);
  const startTime = Date.now();
  let pollCount = 0;
  const iv = setInterval(() => {
    pollCount++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Parse error recovery: with dot-sourced files, a parse error means the
    // file simply didn't run — the session's stdin parser is NOT left
    // dangling, so nothing must be injected. (v11.4.0 and earlier injected
    // "\n)\n\n" here — a relic of pre-file-IPC piping — and that lone ")"
    // itself threw a parse error that the NEXT queued job's stderr watcher
    // caught, cascading one bad report into failures of the following jobs.)
    if (jobStderr && (jobStderr.includes("ParserError") || jobStderr.includes("ParseException")) && !fs.existsSync(doneFile)) {
      clearInterval(iv); psProc.stderr.removeListener("data", stderrW);
      log(`[${shortId}] PARSE ERROR — command file failed to parse`);
      session.status = "error"; session.error = `Parse error:\n${jobStderr.trim()}`; session.completedAt = new Date().toISOString();
      cleanupFiles(); finishActive();
      return;
    }

    // Check done FIRST (before timeout)
    if (fs.existsSync(doneFile)) {
      clearInterval(iv); psProc.stderr.removeListener("data", stderrW);
      log(`[${shortId}] DONE after ${elapsed}s`);
      let raw = "";
      try { if (fs.existsSync(outFile)) { raw = fs.readFileSync(outFile, "utf8").trim(); if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); } } catch {}

      if (structured) {
        try {
          const env = JSON.parse(raw);
          let data = env.Data;
          if (data !== null && data !== undefined && !Array.isArray(data)) data = [data];
          session.output = (data && data.length) ? JSON.stringify(data) : "";
          session.error = Array.isArray(env.Errors) ? env.Errors.join("\n") : (env.Errors || "");
          const extra = [].concat(env.Warnings || [], env.Information || []);
          session.info = extra.join("\n");
          session.status = (session.error && !session.output) ? "error" : "completed";
        } catch (e) {
          session.output = raw;
          session.error = `Envelope parse failed: ${e.message}`;
          session.status = "error";
        }
      } else {
        session.output = raw;
        try { if (fs.existsSync(errFile)) { session.error = fs.readFileSync(errFile, "utf8").trim(); if (session.error.charCodeAt(0) === 0xFEFF) session.error = session.error.slice(1); } } catch {}
        session.status = (session.error && !session.output) ? "error" : "completed";
      }
      session.completedAt = new Date().toISOString();
      log(`[${shortId}] Status: ${session.status} | Out: ${session.output.length}c | Err: ${session.error.slice(0, 100)}`);
      cleanupFiles(); finishActive();
      return;
    }

    // Timeout
    if (Date.now() - startTime > timeout) {
      clearInterval(iv); psProc.stderr.removeListener("data", stderrW);
      log(`[${shortId}] TIMEOUT ${elapsed}s`);
      try { if (fs.existsSync(errFile)) { session.error = fs.readFileSync(errFile, "utf8").trim(); } } catch {}
      if (!session.error) session.error = `Timed out after ${elapsed}s.`;
      session.status = "error"; session.completedAt = new Date().toISOString();
      finishActive();
      return;
    }

    if (pollCount % 10 === 0) log(`[${shortId}] Polling ${elapsed}s...`);
  }, 500);
}

function runOneShot(command, jobId, { timeout = 600000 } = {}) {
  const session = { status: "running", output: "", error: "", startedAt: new Date().toISOString(), completedAt: null };
  jobs.set(jobId, session);
  if (!detectedPS.exe) { session.status = "error"; session.error = "No PowerShell."; session.completedAt = new Date().toISOString(); return jobId; }
  const ps = spawn(detectedPS.exe, ["-NoProfile", "-NonInteractive", "-Command", command], { env: { ...process.env }, shell: false, timeout });
  ps.stdout.on("data", d => { session.output += d.toString(); });
  ps.stderr.on("data", d => { session.error += d.toString().replace(/\x1b\[[0-9;]*m/g, ""); });
  ps.on("close", code => { session.status = (code === 0 || session.output.trim()) ? "completed" : "error"; session.completedAt = new Date().toISOString(); });
  ps.on("error", err => { session.status = "error"; session.error += err.message; session.completedAt = new Date().toISOString(); });
  return jobId;
}

function cacheWhenDone(jobId, key) {
  const iv = setInterval(() => { const j = jobs.get(jobId); if (j && j.status !== "running" && j.status !== "queued") { clearInterval(iv); if (j.output.trim()) { try { let d = JSON.parse(j.output.trim()); if (!Array.isArray(d)) d = [d]; entityCache[key] = { data: d, at: Date.now() }; } catch {} } } }, 500);
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

// Map the currently connected Entra tenant to a store tenant slug (or null).
function connectedTenantSlug() {
  const tid = connectionInfo.tenantId;
  if (!tid) return null;
  const t = (rbac.getStore().tenants || []).find(x => x.tenantId === tid || x.id === tid);
  return t ? t.id : null;
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

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: VERSION, ...connectionInfo, sessionAlive: psAlive, dockerMode: DOCKER_MODE, ps: { exe: detectedPS.exe, version: detectedPS.version, graphModule: detectedPS.graphModule, graphUsersModule: detectedPS.graphUsersModule, exoModule: detectedPS.exoModule, ready: detectedPS.ready, probing: detectedPS.probing, error: detectedPS.probeError }, platform: os.platform() });
});

app.get("/api/logs", (req, res) => { res.json({ logs: diagLog, sessionAlive: psAlive, connectionInfo }); });

app.post("/api/test-session", (req, res) => {
  const jobId = uuidv4();
  runInSession(`[PSCustomObject]@{test='ok';time=(Get-Date -Format o);pid=$PID}|ConvertTo-Json -Compress`, jobId, { timeout: 15000 });
  res.json({ jobId });
});

app.post("/api/reprobe", async (req, res) => { detectedPS.probing = true; await detectPowerShell(); if (detectedPS.ready && !psAlive) startSession(); res.json({ ps: detectedPS }); });

app.post("/api/install-graph", (req, res) => {
  if (!detectedPS.exe) return res.status(400).json({ error: "No PowerShell." });
  const jobId = uuidv4();
  runOneShot(`$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop'\n${MODULE_PATH_FIX}\nWrite-Output "Installing..."\ntry{@('Microsoft.Graph.Authentication','Microsoft.Graph.Users','Microsoft.Graph.Groups','Microsoft.Graph.Identity.DirectoryManagement','Microsoft.Graph.Identity.SignIns','Microsoft.Graph.Reports','Microsoft.Graph.DeviceManagement','Microsoft.Graph.Sites','Microsoft.Graph.Files')|ForEach-Object{Write-Output "  $_...";Install-Module -Name $_ -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop};Write-Output "SUCCESS"}catch{Write-Error "Failed: $($_.Exception.Message)"}`, jobId);
  res.json({ jobId });
});

// ── Connect Graph (interactive browser OR device code) ──────────────
app.post("/api/connect/graph", (req, res) => {
  const { account, tenantId, useDeviceCode } = req.body || {};
  // Tenant guard: a non-admin may only connect to a tenant they are granted.
  if (!rbac.isAdmin(req.user, rbac.getStore())) {
    const allowed = rbac.allowedTenants(req.user, rbac.getStore());
    if (tenantId && tenantId.trim()) {
      if (!allowed.find(t => t.tenantId === tenantId || t.id === tenantId))
        return denyAudit(req, res, 403, "Not authorized for this tenant", { tenantId });
    } else if (allowed.length === 0) {
      return denyAudit(req, res, 403, "No tenant access");
    }
  }
  const useDevCode = useDeviceCode || DOCKER_MODE;
  deviceCode = null; // clear any stale prompt from a prior attempt
  log(`CONNECT GRAPH: account=${account || '(none)'} tenant=${tenantId || '(none)'} deviceCode=${useDevCode}`);
  audit(req, "connect.graph", { account: account || null, tenantId: tenantId || null, deviceCode: useDevCode });

  const scopes = ["User.Read.All", "Group.Read.All", "Directory.Read.All", "Organization.Read.All", "AuditLog.Read.All", "Reports.Read.All", "Policy.Read.All", "RoleManagement.Read.Directory", "Sites.Read.All", "IdentityRiskyUser.Read.All", "DeviceManagementManagedDevices.Read.All", "DeviceManagementConfiguration.Read.All"];
  let args = `-Scopes "${scopes.join('","')}"`;
  if (tenantId && tenantId.trim()) args += ` -TenantId "${tenantId.replace(/[`$"'{}();&|]/g, "")}"`;
  if (useDevCode) args += ` -UseDeviceAuthentication`;
  const safeAcct = account ? account.replace(/[`$"'{}();&|]/g, "") : "";

  const jobId = uuidv4();
  // Run raw (no output capture / no Out-Null) so the device-code prompt streams
  // to stdout live; the context result is written to the job out-file instead.
  const cmd = `try { Disconnect-MgGraph -EA SilentlyContinue } catch {}\n${safeAcct ? `$env:AZURE_USERNAME = "${safeAcct}"\n` : ""}Connect-MgGraph ${args} -ErrorAction Stop\n$ctx = Get-MgContext\n[PSCustomObject]@{Account=$ctx.Account;TenantId=$ctx.TenantId;Scopes=($ctx.Scopes -join ", ")} | ConvertTo-Json -Compress | Out-File -FilePath '__OUTFILE__' -Encoding utf8`;

  runInSession(cmd, jobId, { timeout: useDevCode ? 300000 : 120000, raw: true });

  const iv = setInterval(() => {
    const j = jobs.get(jobId);
    if (j && j.status !== "running" && j.status !== "queued") {
      clearInterval(iv);
      deviceCode = null; // sign-in resolved (success or timeout); drop the prompt
      log(`CONNECT GRAPH done: ${j.status}`);
      if (j.output.trim()) {
        const raw = j.output.trim();
        const js = raw.indexOf("{"), je = raw.lastIndexOf("}");
        if (js !== -1 && je !== -1) {
          try { const d = JSON.parse(raw.substring(js, je + 1)); connectionInfo.graphConnected = true; connectionInfo.account = d.Account || account; connectionInfo.tenantId = d.TenantId || tenantId; log(`CONNECTED as ${connectionInfo.account}`); } catch {}
        }
        if (!connectionInfo.graphConnected && !j.error) { connectionInfo.graphConnected = true; connectionInfo.account = account; }
      }
    }
  }, 500);
  res.json({ jobId });
});

// ── Connect Exchange ────────────────────────────────────────────────
app.post("/api/connect/exchange", (req, res) => {
  const { account } = req.body || {};
  const useDevCode = DOCKER_MODE;
  const upn = account ? account.replace(/[`$"'{}();&|]/g, "") : "";
  deviceCode = null; // clear any stale prompt from a prior attempt
  audit(req, "connect.exchange", { account: upn || null, deviceCode: useDevCode });
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
  runInSession(cmd, jobId, { timeout: useDevCode ? 300000 : 120000, raw: true });
  const iv = setInterval(() => { const j = jobs.get(jobId); if (j && j.status !== "running" && j.status !== "queued") { clearInterval(iv); deviceCode = null; if (j.status === "completed" && j.output.trim()) connectionInfo.exchangeConnected = true; } }, 500);
  res.json({ jobId });
});

app.post("/api/disconnect", (req, res) => {
  audit(req, "disconnect", { account: connectionInfo.account });
  const jobId = uuidv4();
  runInSession(`try{Disconnect-MgGraph -EA SilentlyContinue}catch{}\ntry{Disconnect-ExchangeOnline -Confirm:$false -EA SilentlyContinue}catch{}\n[PSCustomObject]@{status='disconnected'}|ConvertTo-Json -Compress`, jobId);
  connectionInfo = { graphConnected: false, exchangeConnected: false, account: null, tenantId: null };
  entityCache = { users: { data: null, at: null }, groups: { data: null, at: null }, licenses: { data: null, at: null } };
  deviceCode = null;
  res.json({ jobId });
});

app.post("/api/restart-session", (req, res) => {
  audit(req, "session.restart", {});
  if (psProc) try { psProc.kill(); } catch {}
  psAlive = false;
  connectionInfo = { graphConnected: false, exchangeConnected: false, account: null, tenantId: null };
  setTimeout(() => startSession(), 1000);
  res.json({ status: "restarting" });
});

// ── Browse ──────────────────────────────────────────────────────────
app.get("/api/browse/users", (req, res) => {
  if (entityCache.users.data && (Date.now() - entityCache.users.at) < 300000) return res.json({ cached: true, data: entityCache.users.data });
  const jobId = uuidv4(); runInSession(`Get-MgUser -All -Property "Id,DisplayName,UserPrincipalName,Mail,Department,JobTitle,AccountEnabled,UserType"|Select-Object Id,DisplayName,UserPrincipalName,Mail,Department,JobTitle,AccountEnabled,UserType|ConvertTo-Json -Depth 3 -Compress`, jobId); cacheWhenDone(jobId, "users"); res.json({ jobId });
});
app.get("/api/browse/groups", (req, res) => {
  if (entityCache.groups.data && (Date.now() - entityCache.groups.at) < 300000) return res.json({ cached: true, data: entityCache.groups.data });
  const jobId = uuidv4(); runInSession(`Get-MgGroup -All -Property "Id,DisplayName,Mail,GroupTypes,SecurityEnabled,MailEnabled,Description"|Select-Object Id,DisplayName,Mail,@{N='Type';E={if($_.GroupTypes -contains 'Unified'){'Microsoft 365'}elseif($_.SecurityEnabled -and $_.MailEnabled){'Mail-Enabled Security'}elseif($_.SecurityEnabled){'Security'}elseif($_.MailEnabled){'Distribution'}else{'Other'}}},@{N='Dynamic';E={if($_.GroupTypes -contains 'DynamicMembership'){'Yes'}else{'No'}}},Description|ConvertTo-Json -Depth 3 -Compress`, jobId); cacheWhenDone(jobId, "groups"); res.json({ jobId });
});
app.get("/api/browse/licenses", (req, res) => {
  if (entityCache.licenses.data && (Date.now() - entityCache.licenses.at) < 300000) return res.json({ cached: true, data: entityCache.licenses.data });
  const jobId = uuidv4(); runInSession(`Get-MgSubscribedSku -All|Select-Object SkuId,SkuPartNumber,@{N='Total';E={$_.PrepaidUnits.Enabled}},@{N='Assigned';E={$_.ConsumedUnits}},@{N='Available';E={$_.PrepaidUnits.Enabled-$_.ConsumedUnits}}|ConvertTo-Json -Depth 3 -Compress`, jobId); cacheWhenDone(jobId, "licenses"); res.json({ jobId });
});
app.post("/api/browse/refresh", (req, res) => { entityCache = { users: { data: null, at: null }, groups: { data: null, at: null }, licenses: { data: null, at: null } }; res.json({ ok: true }); });

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
  // Authorization: the report must be allowed for the caller in the connected tenant.
  if (!rbac.can(req.user, { tenant: connectedTenantSlug(), reportId }, rbac.getStore()))
    return denyAudit(req, res, 403, "Not authorized for this report", { reportId });
  const cmd = buildCommand(report, fields, params);
  const c = isSafe(cmd);
  if (!c.ok) { log(`RUN ${reportId} REJECTED: ${c.why}`); audit(req, "report.rejected", { reportId, why: c.why }); return res.status(403).json({ error: c.why }); }
  audit(req, "report.run", { reportId, params: params || null, fields: fields || null });
  const jobId = uuidv4();
  // NOTE: no ConvertTo-Json here — the structured envelope serializes Data.
  runInSession(cmd, jobId, { structured: true });
  res.json({ jobId });
});

app.get("/api/job/:jobId", (req, res) => {
  const s = jobs.get(req.params.jobId);
  if (!s) return res.status(404).json({ error: "Job not found — the run request may have been rejected (check server logs)" });
  res.json({ status: s.status, output: s.output, error: s.error ? s.error.replace(/\x1b\[[0-9;]*m/g, "") : "", info: s.info || "", startedAt: s.startedAt, completedAt: s.completedAt, deviceCode });
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

function waitForJob(jobId, timeout = 320000) {
  return new Promise(resolve => {
    const start = Date.now();
    const iv = setInterval(() => {
      const j = jobs.get(jobId);
      if (j && j.status !== "running" && j.status !== "queued") { clearInterval(iv); resolve(j); }
      else if (Date.now() - start > timeout) { clearInterval(iv); resolve(j || { status: "error", error: "Pack step timed out", output: "" }); }
    }, 500);
  });
}

async function runPack(packJob, pack, { snapshot, label }) {
  for (const rid of pack.reports) {
    const report = findReport(rid);
    const entry = packJob.results.find(r => r.reportId === rid);
    if (!report) { entry.status = "error"; entry.error = "Unknown report"; continue; }
    if (report.ex && !connectionInfo.exchangeConnected) { entry.status = "skipped"; entry.error = "Exchange not connected"; continue; }
    entry.status = "running";
    const cmd = buildCommand(report, null, {});
    const c = isSafe(cmd);
    if (!c.ok) { entry.status = "error"; entry.error = c.why; continue; }
    const jobId = uuidv4();
    runInSession(cmd, jobId, { structured: true });
    const j = await waitForJob(jobId);
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
  if (!connectionInfo.graphConnected) return res.status(409).json({ error: "Connect to Graph before running a pack" });
  // Authorization: every report in the pack must be allowed for the caller.
  const tenantSlug = connectedTenantSlug();
  const store = rbac.getStore();
  const denied = pack.reports.filter(rid => !rbac.can(req.user, { tenant: tenantSlug, reportId: rid }, store));
  if (denied.length) return denyAudit(req, res, 403, "Not authorized for one or more reports in this pack", { packId, denied });
  const cleanLabel = label ? String(label).slice(0, 120) : "";
  audit(req, "pack.run", { packId, snapshot: !!snapshot, label: cleanLabel || null });
  const packJob = {
    id: uuidv4(),
    packId,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    results: pack.reports.map(rid => { const r = findReport(rid); return { reportId: rid, name: r ? r.name : rid, status: "pending", rowCount: null, error: null, snapshotId: null, rows: null }; }),
  };
  packJobs.set(packJob.id, packJob);
  runPack(packJob, pack, { snapshot: !!snapshot, label: cleanLabel }); // fire and forget
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
// eventual) — cheap even on large tenants. Cached for 5 minutes;
// ?refresh=1 forces a re-run.
let dashCache = { at: 0, data: null };
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
  if (!connectionInfo.graphConnected) return res.status(409).json({ error: "Connect to Graph first" });
  const force = req.query.refresh === "1";
  if (!force && dashCache.data && Date.now() - dashCache.at < 5 * 60 * 1000) {
    return res.json({ ...dashCache.data, cachedAt: new Date(dashCache.at).toISOString(), cached: true });
  }
  const c = isSafe(DASH_CMD);
  if (!c.ok) return res.status(500).json({ error: c.why }); // defense-in-depth; should never fire
  audit(req, "dashboard.refresh", { forced: force });
  const jobId = uuidv4();
  runInSession(DASH_CMD, jobId, { structured: true });
  const j = await waitForJob(jobId, 120000);
  if (j.status !== "completed" || !j.output) return res.status(502).json({ error: j.error || "Dashboard query failed" });
  try {
    let data = JSON.parse(j.output);
    if (Array.isArray(data)) data = data[0] || {};
    dashCache = { at: Date.now(), data };
    res.json({ ...data, cachedAt: new Date(dashCache.at).toISOString(), cached: false });
  } catch (e) { res.status(502).json({ error: `Dashboard parse failed: ${e.message}` }); }
});

// ── Config & audit ──────────────────────────────────────────────────
app.get("/api/config", (req, res) => {
  // Only the tenants the caller may reach (friendly-name dropdown source).
  const tenants = rbac.allowedTenants(req.user, rbac.getStore())
    .map(t => ({ id: t.id, name: t.name, tenantId: t.tenantId }));
  res.json({ tenants });
});
app.get("/api/audit", requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  res.json({ entries: readAudit(limit) });
});

// ── Static ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Startup ─────────────────────────────────────────────────────────
(async () => {
  console.log(`\n  M365 Admin Reports Server v${VERSION}\n`);
  await detectPowerShell();
  if (detectedPS.exe) startSession();
  app.listen(PORT, HOST, () => { console.log(`  → http://localhost:${PORT} (bound to ${HOST})\n  → Session: ${psAlive ? "ALIVE" : "NOT RUNNING"}\n`); });
})();

process.on("SIGINT", () => { if (psProc) try { psProc.kill(); } catch {} process.exit(0); });
process.on("SIGTERM", () => { if (psProc) try { psProc.kill(); } catch {} process.exit(0); });
