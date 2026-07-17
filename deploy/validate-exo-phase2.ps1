#Requires -Version 7
<#
.SYNOPSIS
  ADR-0011 phase-2 end-to-end validation (read-only). Runs the exact rewritten
  command bodies from reports.js (dl-members, user-inbox-rules, mailbox-permissions,
  all-forwarding-rules) against the live AM tenant over Invoke-ExoRest, to confirm
  the phase-2 reports work app-only before shipping. Authorized admin diagnostic.
#>
$ErrorActionPreference = 'Stop'
$tid = '50e2cd3f-026a-42af-8e33-cc360a602f0d'
$cid = '25407385-9354-471d-8532-6ea147a00f42'
$vault = $env:KEY_VAULT_NAME

$idEp = $env:IDENTITY_ENDPOINT; $idHdr = $env:IDENTITY_HEADER
$kvTok = (Invoke-RestMethod -Uri "${idEp}?resource=https://vault.azure.net&api-version=2019-08-01" -Headers @{ 'X-IDENTITY-HEADER' = $idHdr }).access_token
$sec = Invoke-RestMethod -Uri "https://${vault}.vault.azure.net/secrets/m365-report-am?api-version=7.4" -Headers @{ Authorization = "Bearer $kvTok" }
$certPath = "/app/data/_phase2val.pfx"
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

$clean = { param($a) ($a | ForEach-Object { if ($_ -match '^"([^"]+)"') { $Matches[1] } else { $_ } }) -join '; ' }

Write-Host "PHASE2 VALIDATE START"
@(Invoke-ExoRest -Cmdlet Get-OrganizationConfig -Parameters @{}) | Out-Null

# === 1. dl-members (resolve by SMTP, then display name; expand by Guid) ===
$id = 'alyson@alliancesmanagement.com'
$grp = $null
try { $grp = @(Invoke-ExoRest -Cmdlet Get-DistributionGroup -Parameters @{Identity = $id }) | Select-Object -First 1 } catch {}
if (-not $grp) { try { $grp = @(Invoke-ExoRest -Cmdlet Get-DistributionGroup -Parameters @{Filter = "DisplayName -eq '$id'" }) | Select-Object -First 1 } catch {} }
if (-not $grp) { Write-Host "DL-MEMBERS: FAIL resolve"; }
else {
  $members = @(Invoke-ExoRest -Cmdlet Get-DistributionGroupMember -Parameters @{Identity = $grp.Guid; ResultSize = 'Unlimited' })
  Write-Host "DL-MEMBERS: OK grp='$($grp.DisplayName)' members=$($members.Count)"
  $members | Select-Object DisplayName, PrimarySmtpAddress, Alias, RecipientType, @{N = 'Details'; E = { $_.RecipientTypeDetails } } | ConvertTo-Json -Depth 4 | Write-Host
}

# === 2. user-inbox-rules ===
$rules = @(Invoke-ExoRest -Cmdlet Get-InboxRule -Parameters @{Mailbox = 'accounting@am.consulting' })
Write-Host "USER-INBOX-RULES: OK count=$($rules.Count)"
$rules | Select-Object Name, Enabled, Priority, @{N = 'ForwardTo'; E = { & $clean $_.ForwardTo } }, @{N = 'RedirectTo'; E = { & $clean $_.RedirectTo } }, @{N = 'ForwardAsAttach'; E = { & $clean $_.ForwardAsAttachmentTo } }, DeleteMessage, MoveToFolder | ConvertTo-Json -Depth 4 | Write-Host

# === 3. mailbox-permissions ===
$mbx = 'lorri@am.consulting'
$fa = @(Invoke-ExoRest -Cmdlet Get-MailboxPermission -Parameters @{Identity = $mbx }) | Where-Object { $_.User -ne 'NT AUTHORITY\SELF' -and -not $_.IsInherited -and $_.Deny -ne 'True' } | Select-Object @{N = 'Mailbox'; E = { $mbx } }, User, @{N = 'Rights'; E = { $_.AccessRights -join ', ' } }, @{N = 'Type'; E = { 'FullAccess' } }
$sa = @(Invoke-ExoRest -Cmdlet Get-RecipientPermission -Parameters @{Identity = $mbx }) | Where-Object { $_.Trustee -ne 'NT AUTHORITY\SELF' } | Select-Object @{N = 'Mailbox'; E = { $mbx } }, @{N = 'User'; E = { $_.Trustee } }, @{N = 'Rights'; E = { 'SendAs' } }, @{N = 'Type'; E = { 'SendAs' } }
$perm = @($fa) + @($sa) | Where-Object { $_ }
Write-Host "MAILBOX-PERMISSIONS: OK rows=$($perm.Count) (FullAccess=$(@($fa).Count) SendAs=$(@($sa).Count))"
$perm | ConvertTo-Json -Depth 4 | Write-Host

# === 4. all-forwarding-rules (capped to 40 mailboxes for validation speed) ===
$mbxs = @(Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{ResultSize = 'Unlimited' } | Select-Object PrimarySmtpAddress)
$hits = 0; $n = 0
foreach ($m in $mbxs) {
  if ($n -ge 40) { break }; $n++
  try { $r = @(Invoke-ExoRest -Cmdlet Get-InboxRule -Parameters @{Mailbox = $m.PrimarySmtpAddress }) } catch { continue }
  $r | Where-Object { $_.ForwardTo -or $_.ForwardAsAttachmentTo -or $_.RedirectTo } | ForEach-Object {
    $hits++
    [PSCustomObject]@{ Mailbox = $m.PrimarySmtpAddress; Rule = $_.Name; Enabled = $_.Enabled; ForwardTo = (& $clean $_.ForwardTo); Redirect = (& $clean $_.RedirectTo) } | ConvertTo-Json -Compress | Write-Host
  }
}
Write-Host "ALL-FORWARDING-RULES: OK scanned=$n hits=$hits (validation cap 40; ship scans all)"

Remove-Item $certPath -Force -ErrorAction SilentlyContinue
Write-Host "PHASE2 VALIDATE COMPLETE"
