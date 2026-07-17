#Requires -Version 7
<#
.SYNOPSIS
  ADR-0011 phase-2 shape probe: dump raw REST field shapes for the cmdlets the
  four phase-2 reports depend on, so the report bodies are written to match the
  actual adminapi InvokeCommand serialization (not the module's typed objects).
  Read-only.
.DESCRIPTION
  Mirrors tenants.js buildExchangeAppOnlyConnect (helper defs), then for each
  phase-2 cmdlet fetches a representative record and prints the .NET type of the
  tricky fields plus the full JSON of a sample object. Targets:
    Get-DistributionGroup / Get-DistributionGroupMember  (dl-members)
    Get-InboxRule                                        (user-inbox-rules, all-forwarding-rules)
    Get-MailboxPermission / Get-RecipientPermission      (mailbox-permissions)
#>
$ErrorActionPreference = 'Stop'
$tid = '50e2cd3f-026a-42af-8e33-cc360a602f0d'
$cid = '25407385-9354-471d-8532-6ea147a00f42'
$vault = $env:KEY_VAULT_NAME

# --- fetch cert via managed identity (same as production keyvault.js) ---
$idEp = $env:IDENTITY_ENDPOINT; $idHdr = $env:IDENTITY_HEADER
$kvTok = (Invoke-RestMethod -Uri "${idEp}?resource=https://vault.azure.net&api-version=2019-08-01" -Headers @{ 'X-IDENTITY-HEADER' = $idHdr }).access_token
$sec = Invoke-RestMethod -Uri "https://${vault}.vault.azure.net/secrets/m365-report-am?api-version=7.4" -Headers @{ Authorization = "Bearer $kvTok" }
$certPath = "/app/data/_probe.pfx"
[IO.File]::WriteAllBytes($certPath, [Convert]::FromBase64String($sec.value))

# --- helper defs: copied from tenants.js buildExchangeAppOnlyConnect ---
$global:ExoRest = @{ Tid = $tid; ClientId = $cid; Org = 'am.consulting'; Cert = $null; Token = $null; Exp = [int64]0 }
$global:ExoRest.Cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath, '', 'Exportable')
function global:Get-ExoRestToken {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  if ($global:ExoRest.Token -and $now -lt ($global:ExoRest.Exp - 120)) { return $global:ExoRest.Token }
  $c = $global:ExoRest.Cert; $tid = $global:ExoRest.Tid; $cid = $global:ExoRest.ClientId
  $enc = { param([byte[]]$b) [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  $aud = "https://login.microsoftonline.com/$tid/oauth2/v2.0/token"
  $hdr = @{ alg = 'RS256'; typ = 'JWT'; x5t = (& $enc $c.GetCertHash()) } | ConvertTo-Json -Compress
  $pl = @{ aud = $aud; iss = $cid; sub = $cid; jti = [guid]::NewGuid().ToString(); nbf = $now; exp = $now + 600 } | ConvertTo-Json -Compress
  $unsigned = (& $enc ([Text.Encoding]::UTF8.GetBytes($hdr))) + '.' + (& $enc ([Text.Encoding]::UTF8.GetBytes($pl)))
  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c)
  $sig = & $enc ($rsa.SignData([Text.Encoding]::UTF8.GetBytes($unsigned), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1))
  $body = @{ client_id = $cid; scope = 'https://outlook.office365.com/.default'; client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'; client_assertion = "$unsigned.$sig"; grant_type = 'client_credentials' }
  $resp = Invoke-RestMethod -Method POST -Uri $aud -Body $body -ContentType 'application/x-www-form-urlencoded'
  $global:ExoRest.Token = $resp.access_token; $global:ExoRest.Exp = $now + [int64]$resp.expires_in
  return $global:ExoRest.Token
}
function global:Invoke-ExoRest {
  param([Parameter(Mandatory)][string]$Cmdlet, [hashtable]$Parameters = @{})
  $tid = $global:ExoRest.Tid
  $headers = @{ Authorization = "Bearer $(Get-ExoRestToken)"; Accept = 'application/json' }
  $uri = "https://outlook.office365.com/adminapi/beta/$tid/InvokeCommand"
  $body = @{ CmdletInput = @{ CmdletName = $Cmdlet; Parameters = $Parameters } } | ConvertTo-Json -Depth 8
  $method = 'POST'; $acc = [System.Collections.Generic.List[object]]::new(); $guard = 0
  while ($uri -and $guard -lt 500) {
    $guard++
    try { $r = Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -Body $body -ContentType 'application/json' }
    catch { $msg = $_.Exception.Message; try { if ($_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message } } catch {}; throw "EXO REST $Cmdlet failed: $msg" }
    if ($r.value) { foreach ($v in $r.value) { $acc.Add($v) } }
    $uri = $r.'@odata.nextLink'; $method = 'GET'; $body = $null
  }
  return $acc.ToArray()
}

function TypeOf($v) { if ($null -eq $v) { '<null>' } else { "$($v.GetType().Name)" } }
function Dump($label, $obj) {
  Write-Host "===== $label ====="
  if ($null -eq $obj) { Write-Host '(none)'; return }
  Write-Host ($obj | ConvertTo-Json -Depth 5)
}

Write-Host "PROBE START"
$o = @(Invoke-ExoRest -Cmdlet Get-OrganizationConfig -Parameters @{})
Write-Host "CONNECT org=$($o[0].Name)"

# --- 1. Distribution groups: Guid / PrimarySmtpAddress field shapes ---
$dgs = @(Invoke-ExoRest -Cmdlet Get-DistributionGroup -Parameters @{ResultSize = 10 })
Write-Host "DG count=$($dgs.Count)"
if ($dgs.Count) {
  $g = $dgs[0]
  Write-Host "DG[0] Guid type=$(TypeOf $g.Guid) value=$($g.Guid)"
  Write-Host "DG[0] PrimarySmtpAddress type=$(TypeOf $g.PrimarySmtpAddress) value=$($g.PrimarySmtpAddress)"
  Write-Host "DG[0] Identity type=$(TypeOf $g.Identity) value=$($g.Identity)"
  Dump 'DG[0] (Select DisplayName,Guid,PrimarySmtpAddress,Alias,Identity)' ($g | Select-Object DisplayName, Guid, PrimarySmtpAddress, Alias, Identity)

  # Members, resolved by Guid then PrimarySmtpAddress
  $key = if ($g.Guid) { $g.Guid } else { $g.PrimarySmtpAddress }
  $mem = @(Invoke-ExoRest -Cmdlet Get-DistributionGroupMember -Parameters @{Identity = $key; ResultSize = 'Unlimited' })
  Write-Host "DGMEMBER count=$($mem.Count) (group '$($g.DisplayName)' key=$key)"
  if ($mem.Count) {
    Dump 'DGMEMBER[0] (DisplayName,PrimarySmtpAddress,Alias,RecipientType,RecipientTypeDetails)' ($mem[0] | Select-Object DisplayName, PrimarySmtpAddress, Alias, RecipientType, RecipientTypeDetails)
  }
}

# --- 2. Inbox rules: ForwardTo / RedirectTo / ForwardAsAttachmentTo field shapes ---
# Scan mailboxes until we find one that has rules (prefer one with a forward/redirect).
$mbxs = @(Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{ResultSize = 'Unlimited' } | Select-Object PrimarySmtpAddress)
Write-Host "MAILBOX total=$($mbxs.Count)"
$anyRule = $null; $fwdRule = $null; $scanned = 0
foreach ($m in $mbxs) {
  if ($scanned -ge 60) { break }  # cap scan to stay under time/exec limits
  $scanned++
  try { $rules = @(Invoke-ExoRest -Cmdlet Get-InboxRule -Parameters @{Mailbox = $m.PrimarySmtpAddress }) } catch { continue }
  if ($rules.Count) {
    if (-not $anyRule) { $anyRule = @{ mbx = $m.PrimarySmtpAddress; rule = $rules[0] } }
    $f = @($rules | Where-Object { $_.ForwardTo -or $_.RedirectTo -or $_.ForwardAsAttachmentTo }) | Select-Object -First 1
    if ($f) { $fwdRule = @{ mbx = $m.PrimarySmtpAddress; rule = $f }; break }
  }
}
Write-Host "INBOXRULE scanned=$scanned anyRule=$([bool]$anyRule) fwdRule=$([bool]$fwdRule)"
$probeRule = if ($fwdRule) { $fwdRule } else { $anyRule }
if ($probeRule) {
  $r = $probeRule.rule
  Write-Host "INBOXRULE mbx=$($probeRule.mbx) Name=$($r.Name)"
  Write-Host "INBOXRULE ForwardTo type=$(TypeOf $r.ForwardTo)"
  Write-Host "INBOXRULE RedirectTo type=$(TypeOf $r.RedirectTo)"
  Write-Host "INBOXRULE ForwardAsAttachmentTo type=$(TypeOf $r.ForwardAsAttachmentTo)"
  if ($r.ForwardTo) { Write-Host "INBOXRULE ForwardTo[0] type=$(TypeOf @($r.ForwardTo)[0])" }
  Dump 'INBOXRULE full' $r
}

# --- 3. Mailbox permissions & recipient permissions ---
# Use a shared mailbox (most likely to carry delegates).
$shared = @(Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{RecipientTypeDetails = 'SharedMailbox'; ResultSize = 10 } | Select-Object PrimarySmtpAddress)
$permTarget = if ($shared.Count) { $shared[0].PrimarySmtpAddress } elseif ($mbxs.Count) { $mbxs[0].PrimarySmtpAddress } else { $null }
Write-Host "PERM target=$permTarget"
if ($permTarget) {
  $mp = @(Invoke-ExoRest -Cmdlet Get-MailboxPermission -Parameters @{Identity = $permTarget })
  Write-Host "MAILBOXPERM count=$($mp.Count)"
  if ($mp.Count) {
    $p = $mp[0]
    Write-Host "MAILBOXPERM[0] User type=$(TypeOf $p.User) value=$($p.User)"
    Write-Host "MAILBOXPERM[0] AccessRights type=$(TypeOf $p.AccessRights)"
    if ($p.AccessRights) { Write-Host "MAILBOXPERM[0] AccessRights[0] type=$(TypeOf @($p.AccessRights)[0]) value=$(@($p.AccessRights)[0])" }
    Write-Host "MAILBOXPERM[0] IsInherited type=$(TypeOf $p.IsInherited) value=$($p.IsInherited)"
    Write-Host "MAILBOXPERM[0] Deny type=$(TypeOf $p.Deny) value=$($p.Deny)"
    Dump 'MAILBOXPERM[0] full' $p
  }
  $rp = @(Invoke-ExoRest -Cmdlet Get-RecipientPermission -Parameters @{Identity = $permTarget })
  Write-Host "RECIPPERM count=$($rp.Count)"
  if ($rp.Count) {
    $q = $rp[0]
    Write-Host "RECIPPERM[0] Trustee type=$(TypeOf $q.Trustee) value=$($q.Trustee)"
    Write-Host "RECIPPERM[0] AccessRights type=$(TypeOf $q.AccessRights)"
    if ($q.AccessRights) { Write-Host "RECIPPERM[0] AccessRights[0] type=$(TypeOf @($q.AccessRights)[0]) value=$(@($q.AccessRights)[0])" }
    Dump 'RECIPPERM[0] full' $q
  }
}

Remove-Item $certPath -Force -ErrorAction SilentlyContinue
Write-Host "PROBE COMPLETE"
