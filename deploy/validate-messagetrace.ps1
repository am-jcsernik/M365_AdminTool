#Requires -Version 7
<#
.SYNOPSIS
  ADR-0011 phase-3 end-to-end validation (read-only). Runs the rewritten
  message-trace and message-trace-detail report bodies over Invoke-ExoRest
  (Get-MessageTraceV2 / Get-MessageTraceDetailV2) against the live AM tenant.
  Authorized admin diagnostic.
#>
$ErrorActionPreference = 'Stop'
$tid = '50e2cd3f-026a-42af-8e33-cc360a602f0d'
$cid = '25407385-9354-471d-8532-6ea147a00f42'
$vault = $env:KEY_VAULT_NAME
$idEp = $env:IDENTITY_ENDPOINT; $idHdr = $env:IDENTITY_HEADER
$kvTok = (Invoke-RestMethod -Uri "${idEp}?resource=https://vault.azure.net&api-version=2019-08-01" -Headers @{ 'X-IDENTITY-HEADER' = $idHdr }).access_token
$sec = Invoke-RestMethod -Uri "https://${vault}.vault.azure.net/secrets/m365-report-am?api-version=7.4" -Headers @{ Authorization = "Bearer $kvTok" }
$certPath = "/app/data/_mtval.pfx"
[IO.File]::WriteAllBytes($certPath, [Convert]::FromBase64String($sec.value))

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

Write-Host "MT VALIDATE START"

# === message-trace body (recipient filter set; default 48h window) ===
$rcpt = 'jim@am.consulting'
$end = Get-Date; $start = $end.AddDays(-2)
$filters = @{StartDate = $start.ToString('yyyy-MM-ddTHH:mm:ss'); EndDate = $end.ToString('yyyy-MM-ddTHH:mm:ss'); ResultSize = 5000 }
$filters['RecipientAddress'] = $rcpt
$rows = @(Invoke-ExoRest -Cmdlet Get-MessageTraceV2 -Parameters $filters)
Write-Host "MESSAGE-TRACE: OK rows=$($rows.Count) (recipient=$rcpt, last 48h)"
$out = $rows | Select-Object @{N = 'Received'; E = { $_.Received } }, @{N = 'Sender'; E = { $_.SenderAddress } }, @{N = 'Recipient'; E = { $_.RecipientAddress } }, @{N = 'Subject'; E = { $_.Subject } }, @{N = 'Status'; E = { $_.Status } }, @{N = 'SizeKB'; E = { if ($_.Size) { [math]::Round([long]$_.Size / 1KB, 1) } else { $null } } }, @{N = 'MessageTraceId'; E = { $_.MessageTraceId } }
$out | Select-Object -First 3 | ConvertTo-Json -Depth 4 | Write-Host

# === message-trace-detail body (chained from the first row) ===
if ($rows.Count) {
  $mtid = $rows[0].MessageTraceId; $r2 = $rows[0].RecipientAddress
  $det = @(Invoke-ExoRest -Cmdlet Get-MessageTraceDetailV2 -Parameters @{MessageTraceId = $mtid; RecipientAddress = $r2 })
  Write-Host "MESSAGE-TRACE-DETAIL: OK events=$($det.Count) (mtid=$mtid)"
  $det | Select-Object @{N = 'Date'; E = { $_.Date } }, @{N = 'Event'; E = { $_.Event } }, @{N = 'Action'; E = { $_.Action } }, @{N = 'Detail'; E = { $_.Detail } } | ConvertTo-Json -Depth 4 | Write-Host
}
else { Write-Host "MESSAGE-TRACE-DETAIL: skipped (no rows to drill into)" }

Remove-Item $certPath -Force -ErrorAction SilentlyContinue
Write-Host "MT VALIDATE COMPLETE"
