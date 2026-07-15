/*
 * sessions.js — v12 RBAC Phase 4b: per-tenant PowerShell session pool.
 *
 * Owns the PowerShell execution engine and a pool of per-tenant sessions,
 * replacing v11's single process-global session. Each tenant slug gets its own
 * pwsh process, connection state, and FIFO job queue, so:
 *   - two tenants can be connected concurrently (no last-connect-wins), and
 *   - no acting user ever rides another user's connection (the pre-4b bleed:
 *     one shared delegated session meant every caller's reports ran against
 *     whoever connected last — see docs/PLAN-v12-phase4b.md).
 *
 * Sessions are keyed by TENANT, not user: under app-only certificate auth the
 * connection identity is the app service principal (never a person), so all
 * users authorized for a tenant safely share that tenant's session. Cost is
 * bounded by the number of tenants, not users.
 *
 * Concurrency model unchanged WITHIN a session: one pwsh stdin ⇒ one command in
 * flight, FIFO. Concurrency is ACROSS sessions (each has its own process/queue).
 *
 * The execution internals (structured envelope, dot-sourced script files, parse-
 * error recovery, done-file polling) are ported verbatim from v11's server.js —
 * only the state they read/write moved from module globals onto a session object.
 *
 * server.js injects its PowerShell detection + logger via configure(); this
 * module owns TEMP_DIR and the shared `jobs` map (jobId → job status).
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Ephemeral IPC scratch (NOT under DATA_DIR — see server.js note) ──────
const TEMP_DIR = path.join(os.tmpdir(), "m365-admin-reports");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Shared job registry (jobId → { status, output, error, info, ... }). server.js
// reads it in /api/job/:jobId; the engine writes it here.
const jobs = new Map();

// ── Injected dependencies (from server.js configure()) ───────────────────
let getPS = () => ({ exe: null });        // returns the live detectedPS object
let log = () => {};                        // diagnostic logger
let moduleFix = "";                        // MODULE_PATH_FIX preamble
function configure(deps = {}) {
  if (deps.getPS) getPS = deps.getPS;
  if (deps.log) log = deps.log;
  if (typeof deps.moduleFix === "string") moduleFix = deps.moduleFix;
}

// Most recent device-code prompt across sessions ({ url, code, at } | null).
// Device code only occurs on the local-dev delegated fallback (single session)
// or an admin bootstrap connect, so a single latest-value is sufficient for the
// UI to surface; app-only never emits one.
let _latestDeviceCode = null;
function latestDeviceCode() { return _latestDeviceCode; }
function clearDeviceCode() { _latestDeviceCode = null; }

// ══════════════════════════════════════════════════════════════════════
//  SESSION POOL
// ══════════════════════════════════════════════════════════════════════

// Map<tenantSlug, Session>. The local-dev fallback uses the slug "local".
const pool = new Map();

function createSession(slug) {
  return {
    slug,
    psProc: null,
    psAlive: false,
    // Connection state (what this tenant session is connected as).
    connectionInfo: { graphConnected: false, exchangeConnected: false, account: null, tenantId: null, clientId: null },
    // Per-session FIFO queue (one command in flight through the single stdin).
    jobQueue: [],
    activeJobId: null,
    // Staged Key Vault certificate temp file for this tenant (unlinked on evict).
    certPath: null,
    // Per-tenant caches. MUST be per-session: a global browse/dashboard cache
    // would serve tenant A's users/counts to a tenant B viewer.
    entityCache: { users: { data: null, at: null }, groups: { data: null, at: null }, licenses: { data: null, at: null } },
    dashCache: { at: 0, data: null },
    lastUsedAt: Date.now(),
  };
}

// Get (lazy-create + start) the session for a tenant slug. Touches lastUsedAt.
function getSession(slug) {
  let s = pool.get(slug);
  if (!s) {
    s = createSession(slug);
    pool.set(slug, s);
    startSession(s);
  } else if (!s.psAlive) {
    // Session existed but its process died (crash/kill); revive it.
    startSession(s);
  }
  s.lastUsedAt = Date.now();
  return s;
}

// Peek without creating (for status endpoints that must not spin up a session).
function peekSession(slug) { return pool.get(slug) || null; }

function allSessions() { return [...pool.values()]; }

// Tear down a session: kill its pwsh, unlink its staged cert, drop from pool.
function destroySession(slug) {
  const s = pool.get(slug);
  if (!s) return;
  if (s.psProc) { try { s.psProc.kill(); } catch { /* already gone */ } }
  s.psAlive = false;
  if (s.certPath) { try { fs.unlinkSync(s.certPath); } catch { /* best effort */ } s.certPath = null; }
  pool.delete(slug);
  log(`[${slug}] session destroyed`);
}

// Evict sessions idle longer than idleMs (frees ~250-400MB pwsh + cert each).
function evictIdle(idleMs) {
  const now = Date.now();
  for (const [slug, s] of pool) {
    if (now - s.lastUsedAt > idleMs) destroySession(slug);
  }
}

let _evictTimer = null;
function startEviction(idleMs = 30 * 60 * 1000, everyMs = 60 * 1000) {
  if (_evictTimer) clearInterval(_evictTimer);
  _evictTimer = setInterval(() => { try { evictIdle(idleMs); } catch (e) { log(`evictIdle error: ${e.message}`); } }, everyMs);
  if (_evictTimer.unref) _evictTimer.unref();
}

// ══════════════════════════════════════════════════════════════════════
//  PERSISTENT SESSION (per tenant)
// ══════════════════════════════════════════════════════════════════════

function startSession(s) {
  const ps = getPS();
  if (!ps || !ps.exe) { log(`[${s.slug}] cannot start session: no PowerShell`); return; }
  log(`[${s.slug}] Starting session: ${ps.exe}`);
  // -NonInteractive is required: without it PSReadLine loads and renders the
  // session as a terminal, emitting escape sequences that swallow MSAL's
  // device-code prompt. With it, `Connect-MgGraph -UseDeviceAuthentication`
  // prints the code as a clean line we can capture and surface to the UI.
  s.psProc = spawn(ps.exe, ["-NoProfile", "-NonInteractive", "-NoExit", "-Command", "-"], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"], shell: false });
  s.psAlive = true;
  log(`[${s.slug}] Session PID: ${s.psProc.pid}`);

  s.psProc.stdout.on("data", d => {
    const str = d.toString();
    // MSAL device-code prompt: "...open the page https://microsoft.com/devicelogin
    // and enter the code ABCD1234 to authenticate." Capture so the UI can show it.
    const m = str.match(/open the page\s+(\S+)\s+and enter the code\s+([A-Za-z0-9]+)/i);
    if (m) { _latestDeviceCode = { url: m[1], code: m[2], at: Date.now() }; log(`[${s.slug}][device-code] enter ${_latestDeviceCode.code} at ${_latestDeviceCode.url}`); }
    const t = str.trim();
    if (t && t.length < 300) log(`[${s.slug}][PS out] ${t}`);
  });
  s.psProc.stderr.on("data", d => { const t = d.toString().replace(/\x1b\[[0-9;]*m/g, "").trim(); if (t && !t.startsWith(">>")) log(`[${s.slug}][PS err] ${t.slice(0, 200)}`); });
  s.psProc.on("close", code => { log(`[${s.slug}] Session closed (${code})`); s.psAlive = false; });
  s.psProc.on("error", err => { log(`[${s.slug}] Session error: ${err.message}`); s.psAlive = false; });

  const init = `$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'\n${moduleFix}\n@('Microsoft.Graph.Authentication','Microsoft.Graph.Users','Microsoft.Graph.Groups','Microsoft.Graph.Identity.DirectoryManagement','Microsoft.Graph.Identity.SignIns','Microsoft.Graph.Reports','Microsoft.Graph.DeviceManagement','Microsoft.Graph.Sites','Microsoft.Graph.Files')|ForEach-Object{if(Get-Module -ListAvailable -Name $_ -EA SilentlyContinue){Import-Module $_ -EA SilentlyContinue}}\nif(Get-Module -ListAvailable -Name ExchangeOnlineManagement -EA SilentlyContinue){Import-Module ExchangeOnlineManagement -EA SilentlyContinue}\nWrite-Host "[M365] Session initialized"`;
  s.psProc.stdin.write(init + "\n");
}

// Restart a session's pwsh (drops the connection). Returns after respawn kickoff.
function restartSession(s) {
  if (s.psProc) { try { s.psProc.kill(); } catch {} }
  s.psAlive = false;
  s.connectionInfo = { graphConnected: false, exchangeConnected: false, account: null, tenantId: null, clientId: null };
  setTimeout(() => startSession(s), 1000);
}

// ══════════════════════════════════════════════════════════════════════
//  FILE-BASED COMMAND EXECUTION (per-session FIFO)
// ══════════════════════════════════════════════════════════════════════

function runInSession(s, command, jobId, opts = {}) {
  const job = { status: "queued", output: "", error: "", info: "", slug: s.slug, startedAt: new Date().toISOString(), completedAt: null };
  jobs.set(jobId, job);
  s.jobQueue.push({ command, jobId, opts });
  pumpQueue(s);
  return jobId;
}

function pumpQueue(s) {
  if (s.activeJobId !== null || s.jobQueue.length === 0) return;
  const item = s.jobQueue.shift();
  s.activeJobId = item.jobId;
  executeInSession(s, item);
}

function finishActive(s) { s.activeJobId = null; setImmediate(() => pumpQueue(s)); }

// Structured envelope: captures ALL PowerShell streams (output/error/warning/
// information) into one JSON envelope written to the .out file.
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

// Passthrough execution: the command runs at statement level (not captured, not
// piped to Out-Null) so host/Success-stream output (the MSAL device-code prompt)
// streams to stdout live. The command writes its own result to __OUTFILE__.
function buildRawScript(command, shortId, outFile, errFile, doneFile, esc) {
  const cmd = command.replace(/__OUTFILE__/g, esc(outFile));
  return `# Job: ${shortId} (raw)\ntry {\n${cmd}\n} catch {\n  $_.Exception.Message | Out-File -FilePath '${esc(errFile)}' -Encoding utf8\n  $_.ScriptStackTrace | Out-File -FilePath '${esc(errFile)}' -Append -Encoding utf8\n}\n'done' | Out-File -FilePath '${esc(doneFile)}' -Encoding utf8`;
}

function executeInSession(s, { command, jobId, opts }) {
  const { timeout = 300000, structured = false, raw = false } = opts;
  const job = jobs.get(jobId);
  job.status = "running";
  const shortId = jobId.slice(0, 8);
  log(`[${s.slug}][${shortId}] JOB${structured ? " (structured)" : ""}: ${command.replace(/\s+/g, " ").slice(0, 80)}...`);

  if (!s.psAlive || !s.psProc || !s.psProc.stdin || s.psProc.stdin.destroyed) {
    job.status = "error"; job.error = "PowerShell session not running."; job.completedAt = new Date().toISOString();
    finishActive(s); return;
  }

  const outFile = path.join(TEMP_DIR, `${jobId}.out`);
  const errFile = path.join(TEMP_DIR, `${jobId}.err`);
  const doneFile = path.join(TEMP_DIR, `${jobId}.done`);
  const scriptFile = path.join(TEMP_DIR, `${jobId}.ps1`);
  const esc = str => str.replace(/\\/g, "\\\\");

  const script = structured
    ? buildStructuredScript(command, shortId, outFile, doneFile, esc)
    : raw
      ? buildRawScript(command, shortId, outFile, errFile, doneFile, esc)
      : buildLegacyScript(command, shortId, outFile, errFile, doneFile, esc);
  fs.writeFileSync(scriptFile, script, "utf8");

  let jobStderr = "";
  const stderrW = d => { jobStderr += d.toString().replace(/\x1b\[[0-9;]*m/g, ""); };
  s.psProc.stderr.on("data", stderrW);

  try { s.psProc.stdin.write(`. '${scriptFile.replace(/'/g, "''")}'\n`); } catch (e) {
    s.psProc.stderr.removeListener("data", stderrW);
    job.status = "error"; job.error = e.message; job.completedAt = new Date().toISOString();
    finishActive(s); return;
  }

  const cleanupFiles = () => setTimeout(() => { for (const f of [scriptFile, outFile, errFile, doneFile]) try { fs.unlinkSync(f); } catch {} }, 5000);
  const startTime = Date.now();
  let pollCount = 0;
  const iv = setInterval(() => {
    pollCount++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Parse error recovery: with dot-sourced files, a parse error means the file
    // simply didn't run — the stdin parser is NOT left dangling, so nothing must
    // be injected. (Historical: injecting "\n)\n\n" here cascaded failures.)
    if (jobStderr && (jobStderr.includes("ParserError") || jobStderr.includes("ParseException")) && !fs.existsSync(doneFile)) {
      clearInterval(iv); s.psProc.stderr.removeListener("data", stderrW);
      log(`[${s.slug}][${shortId}] PARSE ERROR — command file failed to parse`);
      job.status = "error"; job.error = `Parse error:\n${jobStderr.trim()}`; job.completedAt = new Date().toISOString();
      cleanupFiles(); finishActive(s);
      return;
    }

    // Check done FIRST (before timeout).
    if (fs.existsSync(doneFile)) {
      clearInterval(iv); s.psProc.stderr.removeListener("data", stderrW);
      log(`[${s.slug}][${shortId}] DONE after ${elapsed}s`);
      let rawOut = "";
      try { if (fs.existsSync(outFile)) { rawOut = fs.readFileSync(outFile, "utf8").trim(); if (rawOut.charCodeAt(0) === 0xFEFF) rawOut = rawOut.slice(1); } } catch {}

      if (structured) {
        try {
          const env = JSON.parse(rawOut);
          let data = env.Data;
          if (data !== null && data !== undefined && !Array.isArray(data)) data = [data];
          job.output = (data && data.length) ? JSON.stringify(data) : "";
          job.error = Array.isArray(env.Errors) ? env.Errors.join("\n") : (env.Errors || "");
          const extra = [].concat(env.Warnings || [], env.Information || []);
          job.info = extra.join("\n");
          job.status = (job.error && !job.output) ? "error" : "completed";
        } catch (e) {
          job.output = rawOut;
          job.error = `Envelope parse failed: ${e.message}`;
          job.status = "error";
        }
      } else {
        job.output = rawOut;
        try { if (fs.existsSync(errFile)) { job.error = fs.readFileSync(errFile, "utf8").trim(); if (job.error.charCodeAt(0) === 0xFEFF) job.error = job.error.slice(1); } } catch {}
        job.status = (job.error && !job.output) ? "error" : "completed";
      }
      job.completedAt = new Date().toISOString();
      log(`[${s.slug}][${shortId}] Status: ${job.status} | Out: ${job.output.length}c | Err: ${job.error.slice(0, 100)}`);
      cleanupFiles(); finishActive(s);
      return;
    }

    // Timeout.
    if (Date.now() - startTime > timeout) {
      clearInterval(iv); s.psProc.stderr.removeListener("data", stderrW);
      log(`[${s.slug}][${shortId}] TIMEOUT ${elapsed}s`);
      try { if (fs.existsSync(errFile)) { job.error = fs.readFileSync(errFile, "utf8").trim(); } } catch {}
      if (!job.error) job.error = `Timed out after ${elapsed}s.`;
      job.status = "error"; job.completedAt = new Date().toISOString();
      finishActive(s);
      return;
    }

    if (pollCount % 10 === 0) log(`[${s.slug}][${shortId}] Polling ${elapsed}s...`);
  }, 500);
}

// One-shot (non-session) command — used for module installs. Not tenant-bound;
// spawns a throwaway pwsh. Kept here so all pwsh execution lives in one module.
function runOneShot(command, jobId, { timeout = 600000 } = {}) {
  const job = { status: "running", output: "", error: "", startedAt: new Date().toISOString(), completedAt: null };
  jobs.set(jobId, job);
  const ps = getPS();
  if (!ps || !ps.exe) { job.status = "error"; job.error = "No PowerShell."; job.completedAt = new Date().toISOString(); return jobId; }
  const proc = spawn(ps.exe, ["-NoProfile", "-NonInteractive", "-Command", command], { env: { ...process.env }, shell: false, timeout });
  proc.stdout.on("data", d => { job.output += d.toString(); });
  proc.stderr.on("data", d => { job.error += d.toString().replace(/\x1b\[[0-9;]*m/g, ""); });
  proc.on("close", code => { job.status = (code === 0 || job.output.trim()) ? "completed" : "error"; job.completedAt = new Date().toISOString(); });
  proc.on("error", err => { job.status = "error"; job.error += err.message; job.completedAt = new Date().toISOString(); });
  return jobId;
}

// Await a job's terminal state (used by pack/dashboard orchestration).
function waitForJob(jobId, timeout = 320000) {
  return new Promise(resolve => {
    const start = Date.now();
    const iv = setInterval(() => {
      const j = jobs.get(jobId);
      if (j && j.status !== "running" && j.status !== "queued") { clearInterval(iv); resolve(j); }
      else if (Date.now() - start > timeout) { clearInterval(iv); resolve(j || { status: "error", error: "Job timed out", output: "" }); }
    }, 500);
  });
}

module.exports = {
  TEMP_DIR, jobs, configure,
  getSession, peekSession, allSessions, destroySession, evictIdle, startEviction,
  startSession, restartSession,
  runInSession, runOneShot, waitForJob,
  latestDeviceCode, clearDeviceCode,
};
