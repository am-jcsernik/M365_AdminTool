#!/usr/bin/env node
/*
 * lint-copy.js — guard against the "module missing from the Docker image" class
 * of crash-loop (ADR-0007 auth.js/rbac.js; v12.1.1 sessions.js).
 *
 * It walks the local require() graph starting at server.js and verifies that:
 *   1. every require("./x") resolves to a file that exists on disk, and
 *   2. the Dockerfile actually copies every such top-level module into the image
 *      (either by an explicit `COPY x.js` or a glob like `COPY *.js`).
 *
 * Runs offline (no deps). Exit 1 on any gap so it can gate a build/pre-package.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "server.js");
const DOCKERFILE = path.join(ROOT, "Dockerfile");

// ── 1. Resolve the transitive local require() graph ────────────────────
const LOCAL_RE = /require\(\s*["'](\.\/[^"']+)["']\s*\)/g;

function resolveLocal(fromFile, spec) {
  let p = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  for (const ext of [".js", ".json"]) if (fs.existsSync(p + ext)) return p + ext;
  return null; // unresolved
}

const seen = new Set();
const missing = []; // { from, spec }
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  let src;
  try { src = fs.readFileSync(file, "utf8"); } catch { return; }
  // Collect all require specs for THIS file up front. Recursing inside a shared
  // global regex's exec() loop would reset its lastIndex and silently skip
  // siblings — so gather first (matchAll makes its own iterator), then recurse.
  const specs = [...src.matchAll(LOCAL_RE)].map(m => m[1]);
  for (const spec of specs) {
    const resolved = resolveLocal(file, spec);
    if (!resolved) { missing.push({ from: path.relative(ROOT, file), spec }); continue; }
    if (resolved.endsWith(".js")) walk(resolved);
  }
}
walk(ENTRY);

// Top-level .js modules the image must contain (package.json is copied separately).
const requiredModules = [...seen]
  .filter(f => path.dirname(f) === ROOT && f.endsWith(".js"))
  .map(f => path.basename(f));

// ── 2. Confirm the Dockerfile copies each required module ──────────────
const dockerfile = fs.existsSync(DOCKERFILE) ? fs.readFileSync(DOCKERFILE, "utf8") : "";
const copyLines = dockerfile.split("\n").filter(l => /^\s*COPY\b/i.test(l));
const hasJsGlob = copyLines.some(l => /\*\.js/i.test(l));
function copiedByDockerfile(mod) {
  if (hasJsGlob) return true;
  return copyLines.some(l => new RegExp(`(^|[\\s"'./])${mod.replace(/\./g, "\\.")}(\\s|$)`).test(l));
}
const notCopied = requiredModules.filter(m => !copiedByDockerfile(m));

// ── Report ─────────────────────────────────────────────────────────────
let failed = false;
if (missing.length) {
  failed = true;
  console.error("Unresolved local require()s (file does not exist):");
  for (const x of missing) console.error(`  ${x.from}  →  require("${x.spec}")`);
}
if (notCopied.length) {
  failed = true;
  console.error("Modules required by server.js but NOT copied in the Dockerfile:");
  for (const m of notCopied) console.error(`  ${m}`);
  console.error("Add them to a COPY line (or use `COPY *.js ./`).");
}
if (failed) process.exit(1);
console.log(`lint-copy: OK — ${requiredModules.length} local modules, all resolved and image-copied${hasJsGlob ? " (via *.js glob)" : ""}.`);
