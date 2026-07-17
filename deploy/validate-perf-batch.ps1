#Requires -Version 7
<#
.SYNOPSIS
  v12.2.0 perf-batching validation (read-only). Proves the new Invoke-ExoRestBatch
  helper against the live AM tenant: serial-vs-parallel timing on a sample, then a
  full-tenant parallel pass for mailbox-sizes (Get-MailboxStatistics) and
  all-forwarding-rules (Get-InboxRule). Self-contained — carries its own copy of the
  connect helpers so it runs on any revision that has the KV-reading managed identity.
  Authorized admin diagnostic on Jim's own tenant. Writes results to a .out file.
.NOTES
  Run in-container:  pwsh -File /app/data/validate-perf-batch.ps1 > /app/data/validate-perf-batch.out 2>&1
#>
$ErrorActionPreference = 'Stop'
try { Start-Transcript -Path '/app/data/validate-perf-batch.out' -Force | Out-Null } catch {}
$tid = '50e2cd3f-026a-42af-8e33-cc360a602f0d'
$cid = '25407385-9354-471d-8532-6ea147a00f42'
$vault = $env:KEY_VAULT_NAME

$idEp = $env:IDENTITY_ENDPOINT; $idHdr = $env:IDENTITY_HEADER
$kvTok = (Invoke-RestMethod -Uri "${idEp}?resource=https://vault.azure.net&api-version=2019-08-01" -Headers @{ 'X-IDENTITY-HEADER' = $idHdr }).access_token
$sec = Invoke-RestMethod -Uri "https://${vault}.vault.azure.net/secrets/m365-report-am?api-version=7.4" -Headers @{ Authorization = "Bearer $kvTok" }
$certPath = "/app/data/_perfval.pfx"
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
# Verbatim copy of the shipped v12.2.0 helper (tenants.js buildExchangeAppOnlyConnect).
function global:Invoke-ExoRestBatch {
  param(
    [Parameter(Mandatory)][string]$Cmdlet,
    [Parameter(Mandatory)][string[]]$Identities,
    [hashtable]$Common = @{},
    [string]$IdentityParam = 'Identity',
    [int]$ThrottleLimit = 8
  )
  if (-not $Identities -or $Identities.Count -eq 0) { return @() }
  $tid = $global:ExoRest.Tid
  $tok = Get-ExoRestToken
  $uri = "https://outlook.office365.com/adminapi/beta/$tid/InvokeCommand"
  $Identities | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {
    $id = [string]$_
    $endpoint = $using:uri; $tok = $using:tok; $cmd = $using:Cmdlet
    $common = $using:Common; $idp = $using:IdentityParam
    $params = @{}; foreach ($k in $common.Keys) { $params[$k] = $common[$k] }
    $params[$idp] = $id
    $headers = @{ Authorization = "Bearer $tok"; Accept = 'application/json' }
    $body = @{ CmdletInput = @{ CmdletName = $cmd; Parameters = $params } } | ConvertTo-Json -Depth 8
    $acc = [System.Collections.Generic.List[object]]::new()
    $curUri = $endpoint; $method = 'POST'; $b = $body; $attempt = 0; $guard = 0
    while ($curUri -and $guard -lt 500) {
      $guard++
      try {
        $r = Invoke-RestMethod -Method $method -Uri $curUri -Headers $headers -Body $b -ContentType 'application/json'
      } catch {
        $status = 0; try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        if (($status -eq 429 -or $status -ge 500) -and $attempt -lt 5) {
          $attempt++
          $wait = 10
          try { $d = $_.Exception.Response.Headers.RetryAfter.Delta; if ($d) { $wait = [int]$d.Value.TotalSeconds } } catch {}
          if ($wait -lt 1) { $wait = 5 }
          Start-Sleep -Seconds $wait
          continue
        }
        $msg = $_.Exception.Message
        try { if ($_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message } } catch {}
        $acc.Add([PSCustomObject]@{ _Identity = $id; _Error = $msg })
        break
      }
      if ($r.value) { foreach ($v in $r.value) { $v | Add-Member -NotePropertyName _Identity -NotePropertyValue $id -Force; $acc.Add($v) } }
      $curUri = $r.'@odata.nextLink'; $method = 'GET'; $b = $null
    }
    $acc.ToArray()
  }
}

Write-Host "PERF-BATCH VALIDATE START  $([DateTimeOffset]::UtcNow.ToString('o'))"
@(Invoke-ExoRest -Cmdlet Get-OrganizationConfig -Parameters @{}) | Out-Null

# Roster of all mailboxes (single call).
$mbx = @(Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{ResultSize = 'Unlimited' })
$ids = @($mbx | Select-Object -ExpandProperty PrimarySmtpAddress)
Write-Host "ROSTER: $($ids.Count) mailboxes"

$sampleN = [Math]::Min(20, $ids.Count)
$sample = $ids[0..($sampleN - 1)]

# === A. Serial vs parallel timing on the same sample (Get-MailboxStatistics) ===
$swSer = [System.Diagnostics.Stopwatch]::StartNew()
$serRows = 0
foreach ($m in $sample) {
  try { $st = @(Invoke-ExoRest -Cmdlet Get-MailboxStatistics -Parameters @{Identity = $m }); if ($st.Count) { $serRows++ } } catch {}
}
$swSer.Stop()
Write-Host ("SERIAL  stats x{0}: {1:N1}s rows={2}" -f $sampleN, $swSer.Elapsed.TotalSeconds, $serRows)

$swPar = [System.Diagnostics.Stopwatch]::StartNew()
$parRes = @(Invoke-ExoRestBatch -Cmdlet Get-MailboxStatistics -Identities $sample)
$swPar.Stop()
$parOk = @($parRes | Where-Object { -not $_._Error }).Count
$parErr = @($parRes | Where-Object { $_._Error }).Count
Write-Host ("PARALLEL stats x{0}: {1:N1}s ok={2} err={3}" -f $sampleN, $swPar.Elapsed.TotalSeconds, $parOk, $parErr)
if ($swPar.Elapsed.TotalSeconds -gt 0) {
  Write-Host ("SPEEDUP (sample): {0:N1}x" -f ($swSer.Elapsed.TotalSeconds / $swPar.Elapsed.TotalSeconds))
}

# === B. Full-tenant parallel: mailbox-sizes (Get-MailboxStatistics) ===
$swB = [System.Diagnostics.Stopwatch]::StartNew()
$stats = @(Invoke-ExoRestBatch -Cmdlet Get-MailboxStatistics -Identities $ids)
$swB.Stop()
$sOk = @($stats | Where-Object { -not $_._Error }).Count
$sErr = @($stats | Where-Object { $_._Error }).Count
Write-Host ("FULL mailbox-sizes: {0:N1}s ok={1} err={2} (of {3})" -f $swB.Elapsed.TotalSeconds, $sOk, $sErr, $ids.Count)
if ($sErr) { $stats | Where-Object { $_._Error } | Select-Object -First 5 | ForEach-Object { Write-Host ("  ERR {0}: {1}" -f $_._Identity, $_._Error) } }

# === C. Full-tenant parallel: all-forwarding-rules (Get-InboxRule) ===
$swC = [System.Diagnostics.Stopwatch]::StartNew()
$raw = @(Invoke-ExoRestBatch -Cmdlet Get-InboxRule -Identities $ids -IdentityParam 'Mailbox')
$swC.Stop()
$rErr = @($raw | Where-Object { $_._Error }).Count
$fwd = @($raw | Where-Object { -not $_._Error -and ($_.ForwardTo -or $_.ForwardAsAttachmentTo -or $_.RedirectTo) }).Count
Write-Host ("FULL all-forwarding-rules: {0:N1}s rules-returned={1} forwarding-hits={2} err={3}" -f $swC.Elapsed.TotalSeconds, @($raw | Where-Object { -not $_._Error }).Count, $fwd, $rErr)
if ($rErr) { $raw | Where-Object { $_._Error } | Select-Object -First 5 | ForEach-Object { Write-Host ("  ERR {0}: {1}" -f $_._Identity, $_._Error) } }

Remove-Item $certPath -Force -ErrorAction SilentlyContinue
Write-Host "PERF-BATCH VALIDATE COMPLETE  $([DateTimeOffset]::UtcNow.ToString('o'))"
try { Stop-Transcript | Out-Null } catch {}
