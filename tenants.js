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

// Build the app-only Exchange connect command (ADR-0011).
//
// The ExchangeOnlineManagement module (3.7.2) is broken for app-only REST cmdlets
// on PowerShell 7.5/.NET (its error path calls the removed HttpResponseMessage
// .GetResponseHeader, so every call 401s regardless of correct permissions). We
// bypass the module entirely: mint an app-only token for outlook.office365.com via
// a client-assertion signed with the tenant's KV cert, then call the EXO REST admin
// API (adminapi InvokeCommand) directly. Proven end-to-end in-container.
//
// This command DEFINES two session-global helpers so reports can reuse them:
//   Get-ExoRestToken   mint/cache the app-only token (re-mints ~2min before expiry)
//   Invoke-ExoRest     run any EXO cmdlet over adminapi InvokeCommand (with paging)
// and stashes connection config on $global:ExoRest. It then verifies connectivity
// with a cheap Get-OrganizationConfig before declaring connected.
//
// -org must be a verified domain (or <tenant>.onmicrosoft.com) — from orgDomain or
// the tenant GUID as a last resort.
function buildExchangeAppOnlyConnect(tenant, certPath, orgDomain) {
  const tid = ident(tenant.tenantId);
  const cid = ident(tenant.clientId);
  const org = ident(orgDomain || tenant.orgDomain || tenant.tenantId);
  const p = psq(certPath);
  // NOTE: no PowerShell ${var} syntax below — this is a JS template literal, so
  // only ${...} JS interpolation is expanded; PowerShell vars use $x or $($x).
  return `# ADR-0011: app-only Exchange via direct adminapi REST (bypasses the broken EXO module).
$global:ExoRest = @{ Tid='${tid}'; ClientId='${cid}'; Org='${org}'; Cert=$null; Token=$null; Exp=[int64]0 }
$global:ExoRest.Cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new('${p}', '', 'Exportable')

function global:Get-ExoRestToken {
  # Client-credentials via signed client-assertion. Cached; re-minted ~2min early.
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  if ($global:ExoRest.Token -and $now -lt ($global:ExoRest.Exp - 120)) { return $global:ExoRest.Token }
  $c = $global:ExoRest.Cert; $tid = $global:ExoRest.Tid; $cid = $global:ExoRest.ClientId
  $enc = { param([byte[]]$b) [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_') }
  $aud = "https://login.microsoftonline.com/$tid/oauth2/v2.0/token"
  $hdr = @{ alg='RS256'; typ='JWT'; x5t=(& $enc $c.GetCertHash()) } | ConvertTo-Json -Compress
  $pl  = @{ aud=$aud; iss=$cid; sub=$cid; jti=[guid]::NewGuid().ToString(); nbf=$now; exp=$now+600 } | ConvertTo-Json -Compress
  $unsigned = (& $enc ([Text.Encoding]::UTF8.GetBytes($hdr))) + '.' + (& $enc ([Text.Encoding]::UTF8.GetBytes($pl)))
  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c)
  $sig = & $enc ($rsa.SignData([Text.Encoding]::UTF8.GetBytes($unsigned), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1))
  $body = @{ client_id=$cid; scope='https://outlook.office365.com/.default'; client_assertion_type='urn:ietf:params:oauth:client-assertion-type:jwt-bearer'; client_assertion="$unsigned.$sig"; grant_type='client_credentials' }
  $resp = Invoke-RestMethod -Method POST -Uri $aud -Body $body -ContentType 'application/x-www-form-urlencoded'
  $global:ExoRest.Token = $resp.access_token
  $global:ExoRest.Exp = $now + [int64]$resp.expires_in
  return $global:ExoRest.Token
}

function global:Invoke-ExoRest {
  # Run one EXO cmdlet over adminapi InvokeCommand; follow @odata.nextLink paging.
  param([Parameter(Mandatory)][string]$Cmdlet, [hashtable]$Parameters = @{})
  $tid = $global:ExoRest.Tid
  $headers = @{ Authorization = "Bearer $(Get-ExoRestToken)"; Accept = 'application/json' }
  $uri = "https://outlook.office365.com/adminapi/beta/$tid/InvokeCommand"
  $body = @{ CmdletInput = @{ CmdletName = $Cmdlet; Parameters = $Parameters } } | ConvertTo-Json -Depth 8
  $method = 'POST'
  $acc = [System.Collections.Generic.List[object]]::new()
  $guard = 0
  while ($uri -and $guard -lt 500) {
    $guard++
    try {
      $r = Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -Body $body -ContentType 'application/json'
    } catch {
      $msg = $_.Exception.Message
      try { if ($_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message } } catch {}
      throw "EXO REST $Cmdlet failed: $msg"
    }
    if ($r.value) { foreach ($v in $r.value) { $acc.Add($v) } }
    $uri = $r.'@odata.nextLink'
    $method = 'GET'; $body = $null  # nextLink continuations are GET, no body
  }
  return $acc.ToArray()
}

# Verify connectivity with a cheap call before declaring connected.
$__org = @(Invoke-ExoRest -Cmdlet Get-OrganizationConfig -Parameters @{})
[PSCustomObject]@{ status='connected'; mode='app-only-rest'; org=$(if($__org.Count){$__org[0].Name}else{$global:ExoRest.Org}); via='adminapi' } | ConvertTo-Json -Compress | Out-File -FilePath '__OUTFILE__' -Encoding utf8`;
}

module.exports = {
  parseCertRef, tenantBySlug, isAppOnlyConfigured, stageTenantCert,
  buildGraphAppOnlyConnect, buildExchangeAppOnlyConnect,
};
