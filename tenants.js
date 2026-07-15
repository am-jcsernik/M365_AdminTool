/*
 * tenants.js — v12 RBAC Phase 4: per-tenant app-only (certificate) connection.
 *
 * Resolves a store tenant, stages its Key Vault certificate, and builds the
 * app-only Connect-MgGraph / Connect-ExchangeOnline commands. This is the
 * unattended successor to device-code auth (removes cold-start re-auth).
 *
 * Phase 4a keeps the existing single persistent session; the concurrent
 * per-tenant connection POOL and the maxReplicas lift are Phase 4b (see
 * docs/PLAN-v12-rbac.md). Until then only one tenant is connected at a time.
 */

const { getCertificateSecret, writeCertTemp } = require("./keyvault.js");

// PowerShell single-quoted string escape: double any embedded single quote.
const psq = (s) => String(s == null ? "" : s).replace(/'/g, "''");
// Strip shell/PowerShell metacharacters from identifiers (defense in depth).
const ident = (s) => String(s == null ? "" : s).replace(/[`$"'{}();&|<>\\]/g, "");

// Parse a certSecret reference like "kv:m365-report-am" -> { secretName }.
function parseCertRef(ref) {
  if (!ref) return null;
  const m = /^kv:(.+)$/.exec(ref);
  return { secretName: m ? m[1] : ref };
}

function tenantBySlug(store, slug) {
  return ((store && store.tenants) || []).find(t => t.id === slug) || null;
}

// A tenant can use app-only auth only if it carries all three fields.
function isAppOnlyConfigured(t) {
  return !!(t && t.tenantId && t.clientId && t.certSecret);
}

// Fetch the tenant's certificate from Key Vault and stage it to a temp file.
async function stageTenantCert(tenant, vaultName) {
  const ref = parseCertRef(tenant.certSecret);
  if (!ref) throw new Error(`Tenant '${tenant.id}' has no certSecret reference.`);
  const secret = await getCertificateSecret(vaultName, ref.secretName);
  return writeCertTemp(secret, tenant.id);
}

// Build the app-only Graph connect command (result written to __OUTFILE__).
function buildGraphAppOnlyConnect(tenant, certPath) {
  const tid = ident(tenant.tenantId);
  const cid = ident(tenant.clientId);
  const p = psq(certPath);
  return `try { Disconnect-MgGraph -EA SilentlyContinue } catch {}
$cert = Get-PfxCertificate -FilePath '${p}'
Connect-MgGraph -TenantId '${tid}' -ClientId '${cid}' -Certificate $cert -NoWelcome -ErrorAction Stop
$ctx = Get-MgContext
[PSCustomObject]@{Account=$ctx.AppName;ClientId=$ctx.ClientId;TenantId=$ctx.TenantId;AuthType=$ctx.AuthType} | ConvertTo-Json -Compress | Out-File -FilePath '__OUTFILE__' -Encoding utf8`;
}

// Build the app-only Exchange connect command. -Organization must be a verified
// domain (or <tenant>.onmicrosoft.com) — taken from orgDomain or tenant.tenantId.
function buildExchangeAppOnlyConnect(tenant, certPath, orgDomain) {
  const org = ident(orgDomain || tenant.tenantId);
  const cid = ident(tenant.clientId);
  const p = psq(certPath);
  return `$cert = Get-PfxCertificate -FilePath '${p}'
Connect-ExchangeOnline -AppId '${cid}' -Certificate $cert -Organization '${org}' -ShowBanner:$false -ErrorAction Stop
[PSCustomObject]@{status='connected'} | ConvertTo-Json -Compress | Out-File -FilePath '__OUTFILE__' -Encoding utf8`;
}

module.exports = {
  parseCertRef, tenantBySlug, isAppOnlyConfigured, stageTenantCert,
  buildGraphAppOnlyConnect, buildExchangeAppOnlyConnect,
};
