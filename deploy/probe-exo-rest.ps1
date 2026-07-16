#Requires -Version 7
<#
.SYNOPSIS
  ADR-0011 ground-truth probe: prove app-only EXO REST works WITHOUT the module.
.DESCRIPTION
  Runs INSIDE the live container (managed identity can read the KV cert).
  1. MI -> Key Vault: fetch the tenant PFX (private key needed to sign).
  2. Mint an app-only token for outlook.office365.com via client-assertion.
  3. Exercise two transports and record which returns 200:
       (a) raw entity GET  adminapi/beta/{tid}/Mailbox   (proven 200 already)
       (b) POST InvokeCommand  (the general transport ADR-0011 wants to use)
  Writes a plain-text result to /app/data/probe-exo.out for download.
  Read-only: only GET/list cmdlets are issued.
#>
$ErrorActionPreference = 'Stop'
$out = @()
function Add-Line($s) { $script:out += $s }

try {
  $tid = '50e2cd3f-026a-42af-8e33-cc360a602f0d'
  $cid = '25407385-9354-471d-8532-6ea147a00f42'
  $vault = $env:KEY_VAULT_NAME
  $secretName = 'm365-report-am'
  Add-Line "vault=$vault tid=$tid cid=$cid"

  # 1. Managed identity -> Key Vault (fetch cert as secret; base64 PFX).
  $idEp = $env:IDENTITY_ENDPOINT; $idHdr = $env:IDENTITY_HEADER
  Add-Line "idEp.set=$([bool]$idEp) idHdr.set=$([bool]$idHdr)"
  $miUri = "${idEp}?resource=https://vault.azure.net&api-version=2019-08-01"
  Add-Line "miUri=$miUri"
  $kvTok = (Invoke-RestMethod -Uri $miUri -Headers @{ 'X-IDENTITY-HEADER' = $idHdr }).access_token
  Add-Line "kvTok.len=$($kvTok.Length)"
  $kvUri = "https://${vault}.vault.azure.net/secrets/${secretName}?api-version=7.4"
  Add-Line "kvUri=$kvUri"
  $sec = Invoke-RestMethod -Uri $kvUri -Headers @{ Authorization = "Bearer $kvTok" }
  $pfx = [Convert]::FromBase64String($sec.value)
  $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfx, '', 'Exportable')
  Add-Line "cert loaded: thumb=$($cert.Thumbprint) hasPriv=$($cert.HasPrivateKey)"

  # 2. Client-assertion -> app-only token for outlook.office365.com.
  function ConvertTo-B64Url([byte[]]$b) { [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $aud = "https://login.microsoftonline.com/$tid/oauth2/v2.0/token"
  $hdr = @{ alg = 'RS256'; typ = 'JWT'; x5t = (ConvertTo-B64Url $cert.GetCertHash()) } | ConvertTo-Json -Compress
  $pl = @{ aud = $aud; iss = $cid; sub = $cid; jti = [guid]::NewGuid().ToString(); nbf = $now; exp = $now + 600 } | ConvertTo-Json -Compress
  $unsigned = (ConvertTo-B64Url ([Text.Encoding]::UTF8.GetBytes($hdr))) + '.' + (ConvertTo-B64Url ([Text.Encoding]::UTF8.GetBytes($pl)))
  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
  $sig = ConvertTo-B64Url ($rsa.SignData([Text.Encoding]::UTF8.GetBytes($unsigned), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1))
  $assertion = "$unsigned.$sig"
  $body = @{ client_id = $cid; scope = 'https://outlook.office365.com/.default'; client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'; client_assertion = $assertion; grant_type = 'client_credentials' }
  $tokResp = Invoke-RestMethod -Method POST -Uri $aud -Body $body -ContentType 'application/x-www-form-urlencoded'
  $tok = $tokResp.access_token
  Add-Line "token minted: len=$($tok.Length) expires_in=$($tokResp.expires_in)"

  $h = @{ Authorization = "Bearer $tok"; Accept = 'application/json' }

  # Reusable InvokeCommand caller (paging via @odata.nextLink).
  function Invoke-Ic($Cmdlet, $Params) {
    $body = @{ CmdletInput = @{ CmdletName = $Cmdlet; Parameters = $Params } } | ConvertTo-Json -Depth 8
    $uri = "https://outlook.office365.com/adminapi/beta/$tid/InvokeCommand"
    $acc = @()
    do {
      $r = Invoke-RestMethod -Method POST -Uri $uri -Headers $h -Body $body -ContentType 'application/json'
      if ($r.value) { $acc += $r.value }
      $uri = $r.'@odata.nextLink'; $body = $null
      if ($uri) { $r = $null }  # nextLink is a GET
    } while ($false)  # single page for the probe
    return $acc
  }

  # SHAPE DUMP: exact REST field formats phase-1 reports depend on.
  try {
    $mb = (Invoke-Ic 'Get-Mailbox' @{ ResultSize = '1' })[0]
    Add-Line "SHAPE Get-Mailbox keys: $(($mb.PSObject.Properties.Name | Sort-Object) -join ',')"
    Add-Line "SHAPE Get-Mailbox forwarding: FwdAddr=$($mb.ForwardingAddress) FwdSmtp=$($mb.ForwardingSmtpAddress) Deliver=$($mb.DeliverToMailboxAndForward) WhenCreated='$($mb.WhenCreated)' RTD=$($mb.RecipientTypeDetails)"
    $id = $mb.PrimarySmtpAddress
    $st = (Invoke-Ic 'Get-MailboxStatistics' @{ Identity = $id })[0]
    Add-Line "SHAPE Get-MailboxStatistics keys: $(($st.PSObject.Properties.Name | Sort-Object) -join ',')"
    Add-Line "SHAPE Stats: TotalItemSize='$($st.TotalItemSize)' ItemCount=$($st.ItemCount) LastLogon='$($st.LastLogonTime)'"
  } catch {
    Add-Line "SHAPE DUMP FAIL: $($_.Exception.Message)"
  }

  # 3a. Proven transport: raw entity GET.
  $urlGet = 'https://outlook.office365.com/adminapi/beta/' + $tid + '/Mailbox?$top=1&$filter=' + [uri]::EscapeDataString("RecipientTypeDetails eq 'SharedMailbox'")
  try {
    $r1 = Invoke-RestMethod -Uri $urlGet -Headers $h
    Add-Line "GET Mailbox -> OK  value.count=$(@($r1.value).Count)"
  } catch {
    Add-Line "GET Mailbox -> FAIL  $($_.Exception.Message)"
  }

  # 3b. Candidate general transport: InvokeCommand POST.
  $icBody = @{ CmdletInput = @{ CmdletName = 'Get-Mailbox'; Parameters = @{ RecipientTypeDetails = 'SharedMailbox'; ResultSize = 'Unlimited' } } } | ConvertTo-Json -Depth 6
  $urlIc = "https://outlook.office365.com/adminapi/beta/$tid/InvokeCommand"
  foreach ($variant in @('bare', 'anchored')) {
    $hh = $h.Clone()
    if ($variant -eq 'anchored') { $hh['X-AnchorMailbox'] = "UPN:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@am.consulting" }
    try {
      $r2 = Invoke-RestMethod -Method POST -Uri $urlIc -Headers $hh -Body $icBody -ContentType 'application/json'
      $s = ($r2.value | Select-Object -First 1 DisplayName, PrimarySmtpAddress, RecipientTypeDetails | ConvertTo-Json -Compress)
      Add-Line "InvokeCommand[$variant] Get-Mailbox -> OK  value.count=$(@($r2.value).Count)  sample=$s  next=$([bool]$r2.'@odata.nextLink')"
    } catch {
      $code = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
      Add-Line "InvokeCommand[$variant] Get-Mailbox -> FAIL  http=$code  $($_.Exception.Message)"
    }
  }
} catch {
  Add-Line "PROBE FATAL: $($_.Exception.Message)"
  Add-Line $_.ScriptStackTrace
}

$out -join "`n" | Out-File -FilePath '/app/data/probe-exo.out' -Encoding utf8
Write-Host ($out -join "`n")
