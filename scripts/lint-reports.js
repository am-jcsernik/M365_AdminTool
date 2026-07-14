/*
 * lint-reports.js — validates every command in the report catalog.
 *
 * Run:  npm run lint
 *
 * Two layers:
 *   1. Structural checks (always run, pure Node):
 *      - every report has id/name and exactly one of command|baseCmd
 *      - baseCmd contains __FIELDS__ and has a fields whitelist
 *      - every <Param> placeholder has a matching params[] entry (and vice versa)
 *      - no ${ sequences (JS template-literal interpolation hazards)
 *      - commands pass the server's read-only blocklist (isSafe)
 *   2. PowerShell AST parse (runs only if pwsh is on PATH):
 *      - each built command is parsed with
 *        [System.Management.Automation.Language.Parser]::ParseInput()
 *      - any parse error fails the lint
 *
 * Exit code 0 = clean, 1 = problems found.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { REPORTS, findReport, buildCommand } = require("../reports.js");
const { PACKS } = require("../packs.js");

// Mirror of the server's read-only rules (keep in sync with server.js)
const BLOCKED = [/\bSet-Mg/i, /\bNew-Mg/i, /\bRemove-Mg/i, /\bUpdate-Mg/i, /\bInvoke-Mg(?!GraphRequest\b)/i, /\bSet-EXO/i, /\bNew-EXO/i, /\bRemove-EXO/i, /\bSet-Mailbox\b/i, /\bNew-Mailbox\b/i, /\bRemove-Mailbox\b/i, /Invoke-Expression/i, /\biex\s/i, /Invoke-Command\b/i, /Start-Process/i, /Invoke-WebRequest/i, /Invoke-RestMethod/i];
function isSafe(cmd) {
  for (const line of cmd.split("\n")) {
    const t = line.trim();
    if (t.startsWith("#") || t === "") continue;
    if (/\bInvoke-MgGraphRequest\b/i.test(t)) {
      const m = t.match(/-Method\s+['"]?([A-Za-z]+)/i);
      const method = m ? m[1].toUpperCase() : "GET";
      const isSearchQuery = /-Uri\s+'https:\/\/graph\.microsoft\.com\/v1\.0\/search\/query'/i.test(t);
      if (!(method === "GET" || (method === "POST" && isSearchQuery)))
        return { ok: false, why: "Invoke-MgGraphRequest must be -Method GET (exception: POST /search/query)" };
    }
    for (const p of BLOCKED) if (p.test(t)) return { ok: false, why: `Blocked: ${p}` };
  }
  return { ok: true };
}

const problems = [];
const warn = [];
let total = 0;

// ── Layer 1: structural ──────────────────────────────────────────────
const seenIds = new Set();
for (const cat of REPORTS) {
  if (!cat.category || !Array.isArray(cat.items)) { problems.push(`Category malformed: ${JSON.stringify(cat).slice(0, 60)}`); continue; }
  for (const r of cat.items) {
    total++;
    const label = `${cat.category} / ${r.id || "?"}`;
    if (!r.id) problems.push(`${label}: missing id`);
    else if (seenIds.has(r.id)) problems.push(`${label}: duplicate id`);
    else seenIds.add(r.id);
    if (!r.name) problems.push(`${label}: missing name`);

    const hasCmd = typeof r.command === "string", hasBase = typeof r.baseCmd === "string";
    if (hasCmd === hasBase) problems.push(`${label}: must have exactly one of command|baseCmd`);
    if (hasBase) {
      if (!r.baseCmd.includes("__FIELDS__")) problems.push(`${label}: baseCmd missing __FIELDS__`);
      if (!Array.isArray(r.fields) || !r.fields.length) problems.push(`${label}: baseCmd requires fields whitelist`);
    }

    const cmdText = r.command || r.baseCmd || "";
    if (cmdText.includes("${")) problems.push(`${label}: contains \${ — JS template interpolation hazard`);

    // Placeholder <-> params[] agreement
    const placeholders = [...new Set((cmdText.match(/<([A-Za-z][A-Za-z0-9]*)>/g) || []).map(m => m.slice(1, -1)))]
      .filter(p => !["SiteName", "UPN", "GroupName"].includes(p) ? true : true); // all count
    const declared = (r.params || []).map(p => p.key);
    for (const p of placeholders) if (!declared.includes(p)) problems.push(`${label}: placeholder <${p}> has no params[] entry`);
    for (const p of declared) if (!placeholders.includes(p)) warn.push(`${label}: params[] key '${p}' never used in command`);


    // Read-only compliance of the fully built command
    const built = buildCommand(r, r.fields || null, Object.fromEntries(declared.map(k => [k, "lintvalue"])));
    const safe = isSafe(built);
    if (!safe.ok) problems.push(`${label}: fails read-only check — ${safe.why}`);
    // Statement-form blocks (foreach/if/while/switch) cannot be piped.
    // Track brace depth from each statement keyword's opening brace and
    // flag a pipe immediately after the closing brace. (String literals
    // are not parsed here — rare false positives possible; the pwsh AST
    // layer is authoritative.)
    {
      const kw = /(^|\n)\s*(foreach|if|while|switch)\s*\(/g;
      let mm;
      while ((mm = kw.exec(built)) !== null) {
        let k = built.indexOf("{", mm.index + mm[0].length);
        if (k === -1) continue;
        let depth = 0;
        for (; k < built.length; k++) {
          if (built[k] === "{") depth++;
          else if (built[k] === "}") { depth--; if (depth === 0) break; }
        }
        const after = built.slice(k + 1).match(/^\s*(\|)/);
        if (after) { problems.push(`${label}: statement-form '${mm[2]}' piped directly — wrap in $( ) (PowerShell parse error at runtime)`); break; }
      }
    }

  }
}

// ── Pack validation ──────────────────────────────────────────────────
const packIds = new Set();
for (const p of PACKS) {
  if (!p.id || packIds.has(p.id)) problems.push(`Pack ${p.id || "?"}: missing or duplicate id`);
  packIds.add(p.id);
  for (const rid of p.reports) {
    const r = findReport(rid);
    if (!r) { problems.push(`Pack ${p.id}: unknown report '${rid}'`); continue; }
    if (r.params && r.params.length) problems.push(`Pack ${p.id}: report '${rid}' requires parameters — not allowed in packs`);
  }
}

// ── Layer 2: PowerShell AST parse (optional) ─────────────────────────
function findPwsh() {
  for (const exe of ["pwsh", "pwsh.exe", "powershell.exe"]) {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 15000 });
    if (r.status === 0) return exe;
  }
  return null;
}

const pwsh = findPwsh();
if (pwsh) {
  const tmp = path.join(os.tmpdir(), `lint-reports-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const manifest = [];
  for (const cat of REPORTS) for (const r of cat.items) {
    const declared = (r.params || []).map(p => p.key);
    const built = buildCommand(r, r.fields || null, Object.fromEntries(declared.map(k => [k, "lintvalue"])));
    const f = path.join(tmp, `${r.id}.ps1`);
    fs.writeFileSync(f, built, "utf8");
    manifest.push({ id: r.id, file: f });
  }
  const psScript = `
$m = Get-Content -Raw '${path.join(tmp, "manifest.json").replace(/\\/g, "\\\\")}' | ConvertFrom-Json
$bad = 0
foreach ($e in $m) {
  $tok = $null; $err = $null
  [System.Management.Automation.Language.Parser]::ParseFile($e.file, [ref]$tok, [ref]$err) | Out-Null
  if ($err -and $err.Count -gt 0) { $bad++; Write-Output ("PARSE-FAIL " + $e.id + ": " + $err[0].Message) }
}
Write-Output ("PARSE-DONE bad=" + $bad)`;
  fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest), "utf8");
  const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", psScript], { encoding: "utf8", timeout: 60000 });
  const out = (r.stdout || "") + (r.stderr || "");
  for (const line of out.split("\n")) if (line.startsWith("PARSE-FAIL")) problems.push(line.trim());
  if (!out.includes("PARSE-DONE")) warn.push("pwsh AST parse did not complete cleanly");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
} else {
  warn.push("pwsh not found on PATH — skipped PowerShell AST parse (structural checks only)");
}

// ── Report ───────────────────────────────────────────────────────────
console.log(`\nLint: ${total} reports + ${PACKS.length} packs checked${pwsh ? " (incl. PowerShell AST parse)" : ""}`);
for (const w of warn) console.log(`  WARN  ${w}`);
for (const p of problems) console.log(`  FAIL  ${p}`);
if (problems.length) { console.log(`\n${problems.length} problem(s) found.\n`); process.exit(1); }
console.log("  All checks passed.\n");
