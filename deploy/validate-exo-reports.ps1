#Requires -Version 7
<#
.SYNOPSIS
  ADR-0011 phase-1 validation: run the rewritten Exchange report bodies over the
  app-only REST helpers, in-container, against live data. Read-only.
.DESCRIPTION
  Mirrors tenants.js buildExchangeAppOnlyConnect (helper defs) then executes the
  four phase-1 report command bodies verbatim and prints row counts + a sample.
#>
$ErrorActionPreference = 'Stop'
$tid = '50e2cd3f-026a-42af-8e33-cc360a602f0d'
$cid = '25407385-9354-471d-8532-6ea147a00f42'
$vault = $env:KEY_VAULT_NAME

# --- fetch cert via managed identity (same as production keyvault.js) ---
$idEp = $env:IDENTITY_ENDPOINT; $idHdr = $env:IDENTITY_HEADER
$kvTok = (Invoke-RestMethod -Uri "${idEp}?resource=https://vault.azure.net&api-version=2019-08-01" -Headers @{ 'X-IDENTITY-HEADER' = $idHdr }).access_token
$sec = Invoke-RestMethod -Uri "https://${vault}.vault.azure.net/secrets/m365-report-am?api-version=7.4" -Headers @{ Authorization = "Bearer $kvTok" }
$certPath = "/app/data/_val.pfx"
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

function Show($name, $rows) {
  $rows = @($rows)
  $sample = if ($rows.Count) { ($rows[0] | ConvertTo-Json -Compress -Depth 4) } else { '(none)' }
  Write-Host "REPORT $name -> rows=$($rows.Count) sample=$sample"
}

# connect verify
$o = @(Invoke-ExoRest -Cmdlet Get-OrganizationConfig -Parameters @{})
Write-Host "CONNECT -> org=$($o[0].Name)"

# 1. shared-mailboxes
Show 'shared-mailboxes' (Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{RecipientTypeDetails = 'SharedMailbox'; ResultSize = 'Unlimited' } | Select-Object DisplayName, PrimarySmtpAddress, Alias, WhenCreated)

# 2. mail-forwarding
Show 'mail-forwarding' (Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{ResultSize = 'Unlimited' } | Where-Object { $_.ForwardingAddress -or $_.ForwardingSmtpAddress } | Select-Object DisplayName, PrimarySmtpAddress, ForwardingAddress, ForwardingSmtpAddress, DeliverToMailboxAndForward)

# 3. mailbox-sizes  (cap the per-mailbox stat loop for the probe; note total scale)
$mbx = Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{ResultSize = 'Unlimited' }
Write-Host "SCALE total mailboxes=$(@($mbx).Count) (size report stats each one)"
$mbxCap = @($mbx) | Select-Object -First 8
$rows = foreach ($m in $mbxCap) {
  $st = @(Invoke-ExoRest -Cmdlet Get-MailboxStatistics -Parameters @{Identity = $m.PrimarySmtpAddress })
  if ($st.Count) {
    $sz = $st[0].TotalItemSize
    $bytes = 0; if ($sz -and ($sz -match '\(([\d,]+) bytes\)')) { $bytes = [int64]($Matches[1] -replace ',', '') }
    [PSCustomObject]@{DisplayName = $m.DisplayName; TotalSize = $sz; ItemCount = $st[0].ItemCount; __Bytes = $bytes }
  }
}
Show 'mailbox-sizes' ($rows | Sort-Object __Bytes -Descending | Select-Object -First 50 DisplayName, TotalSize, ItemCount)

# 4. user-mailbox (first shared mailbox as the target)
$u = ($mbx | Select-Object -First 1).PrimarySmtpAddress
$m1 = @(Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{Identity = $u }) | Select-Object -First 1
$s1 = @(Invoke-ExoRest -Cmdlet Get-MailboxStatistics -Parameters @{Identity = $u }) | Select-Object -First 1
Show 'user-mailbox' ([PSCustomObject]@{DisplayName = $m1.DisplayName; PrimarySmtp = $m1.PrimarySmtpAddress; Type = $m1.RecipientTypeDetails; TotalSize = $(if ($s1 -and $s1.TotalItemSize) { $s1.TotalItemSize }else { '0' }); Items = $(if ($s1) { $s1.ItemCount }else { 0 }); Created = $m1.WhenCreated; LastLogon = $(if ($s1) { $s1.LastLogonTime }else { $null }) })

Remove-Item $certPath -Force -ErrorAction SilentlyContinue
Write-Host "VALIDATION COMPLETE"
