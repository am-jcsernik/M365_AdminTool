#Requires -Version 7
<#
.SYNOPSIS
  ADR-0011 phase-3 transport probe (read-only). Tests whether Get-MessageTraceV2 /
  Get-MessageTrace run over the app-only adminapi InvokeCommand surface (like the
  other EXO cmdlets), and dumps the returned field shapes. Authorized admin diagnostic.
#>
$ErrorActionPreference = 'Stop'
$tid = '50e2cd3f-026a-42af-8e33-cc360a602f0d'
$cid = '25407385-9354-471d-8532-6ea147a00f42'
$vault = $env:KEY_VAULT_NAME
$idEp = $env:IDENTITY_ENDPOINT; $idHdr = $env:IDENTITY_HEADER
$kvTok = (Invoke-RestMethod -Uri "${idEp}?resource=https://vault.azure.net&api-version=2019-08-01" -Headers @{ 'X-IDENTITY-HEADER' = $idHdr }).access_token
$sec = Invoke-RestMethod -Uri "https://${vault}.vault.azure.net/secrets/m365-report-am?api-version=7.4" -Headers @{ Authorization = "Bearer $kvTok" }
$certPath = "/app/data/_mtprobe.pfx"
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

Write-Host "MT PROBE START"
$end = Get-Date
$start = $end.AddDays(-2)
$sIso = $start.ToString('yyyy-MM-ddTHH:mm:ss')
$eIso = $end.ToString('yyyy-MM-ddTHH:mm:ss')
Write-Host "window $sIso .. $eIso"

# --- Attempt A: Get-MessageTraceV2 over InvokeCommand ---
Write-Host "===== A: Get-MessageTraceV2 (StartDate/EndDate ISO, ResultSize 10) ====="
try {
  $v2 = @(Invoke-ExoRest -Cmdlet Get-MessageTraceV2 -Parameters @{StartDate = $sIso; EndDate = $eIso; ResultSize = 10 })
  Write-Host "A OK count=$($v2.Count)"
  if ($v2.Count) { $v2[0] | ConvertTo-Json -Depth 5 | Write-Host }
}
catch { Write-Host "A FAIL: $($_.Exception.Message)" }

# --- Attempt B: Get-MessageTrace (legacy) over InvokeCommand ---
Write-Host "===== B: Get-MessageTrace (StartDate/EndDate ISO, PageSize 10, Page 1) ====="
try {
  $v1 = @(Invoke-ExoRest -Cmdlet Get-MessageTrace -Parameters @{StartDate = $sIso; EndDate = $eIso; PageSize = 10; Page = 1 })
  Write-Host "B OK count=$($v1.Count)"
  if ($v1.Count) { $v1[0] | ConvertTo-Json -Depth 5 | Write-Host }
}
catch { Write-Host "B FAIL: $($_.Exception.Message)" }

# --- Attempt C: MessageTraceDetailV2 needs an id; skip unless A returned one ---
if ($v2 -and $v2.Count -and $v2[0].MessageTraceId) {
  $mtid = $v2[0].MessageTraceId; $rcpt = $v2[0].RecipientAddress
  Write-Host "===== C: Get-MessageTraceDetailV2 (mtid=$mtid rcpt=$rcpt) ====="
  try {
    $d = @(Invoke-ExoRest -Cmdlet Get-MessageTraceDetailV2 -Parameters @{MessageTraceId = $mtid; RecipientAddress = $rcpt })
    Write-Host "C OK count=$($d.Count)"
    if ($d.Count) { $d[0] | ConvertTo-Json -Depth 5 | Write-Host }
  }
  catch { Write-Host "C FAIL: $($_.Exception.Message)" }
}

Remove-Item $certPath -Force -ErrorAction SilentlyContinue
Write-Host "MT PROBE COMPLETE"
