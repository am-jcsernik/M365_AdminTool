#Requires -Version 7
<#
.SYNOPSIS
    Phase 0 provisioning for v12 multi-user RBAC: Key Vault access identity,
    Entra access/admin groups, and a per-tenant app-only (certificate) app
    registration. Idempotent where possible; supports -WhatIf.

.DESCRIPTION
    Implements Phase 0 of docs/PLAN-v12-rbac.md. It provisions the Azure- and
    Entra-plane prerequisites that the v12 code (auth.js / rbac.js / tenants.js /
    keyvault.js) will depend on:

      1. Enables a SYSTEM-ASSIGNED managed identity on the Container App and
         grants it the "Key Vault Secrets User" role on the vault (RBAC mode),
         so the app can read certificates at runtime without any secret on disk.
      2. Ensures a Key Vault exists (RBAC-authorization mode).
      3. Ensures two Entra security groups exist and reports their object IDs:
           - an ACCESS group  (membership = "may open the tool at all")
           - an ADMIN  group  (membership = the in-tool admin role bootstrap)
      4. Registers (or reuses) a per-tenant APP-ONLY app registration with the
         read-only Microsoft Graph APPLICATION permissions the reports need
         (plus Exchange.ManageAsApp), generates a certificate INSIDE Key Vault
         (the private key never leaves the vault), and adds the public cert to
         the app registration as a key credential.
      5. Attempts admin consent for the application permissions.

    The certificate is created in Key Vault and only its PUBLIC portion is
    uploaded to the app registration. This satisfies the "secrets only in Key
    Vault" invariant from the plan: the app pulls the cert via managed identity
    at connect time; nothing sensitive lands on the DATA_DIR store or on disk.

    SCOPE / MULTI-TENANT NOTE: app-only auth against a tenant requires the app
    registration to exist AND be admin-consented IN THAT TENANT. This script
    provisions the app registration in the CURRENTLY LOGGED-IN tenant (Phase 0
    targets AM's home tenant first). To onboard a client tenant later
    (GlobalPlatform, EMVCo, ...), re-run the -AppRegistration part while signed
    in to that tenant (or grant admin consent there), and add a matching
    tenants[] entry to the RBAC store.

.PARAMETER ResourceGroup
    Resource group holding the Container App and (to-be-created) Key Vault.

.PARAMETER KeyVaultName
    Key Vault name (3-24 alphanumerics/hyphens, globally unique). Created in
    RBAC-authorization mode if absent.

.PARAMETER ContainerAppName
    The Container App that gets the system-assigned identity + KV access.

.PARAMETER Location
    Azure region for the Key Vault (defaults to the resource group's location).

.PARAMETER AccessGroupName
    Display name of the Entra security group gating overall tool access.

.PARAMETER AdminGroupName
    Display name of the Entra security group that bootstraps the in-tool admin.

.PARAMETER TenantSlug
    Short stable slug for the tenant being onboarded (e.g. 'am'). Used in the
    app-registration display name, the KV certificate name, and as the tenants[]
    id you will paste into the RBAC store.

.PARAMETER TenantDisplayName
    Friendly name shown to users in the tenant dropdown (e.g. 'AM Consulting').

.PARAMETER SkipAppRegistration
    Provision only the shared parts (identity, Key Vault, groups) and skip the
    per-tenant app registration + certificate.

.PARAMETER SkipConsent
    Create the app registration and permissions but do NOT attempt admin
    consent (useful when a Global Administrator will consent separately).

.EXAMPLE
    ./Provision-RbacPhase0.ps1 -ResourceGroup rg-m365admin `
        -KeyVaultName amm365kv -AccessGroupName 'M365 Admin Reports - Access' `
        -AdminGroupName 'M365 Admin Reports - Admins' `
        -TenantSlug am -TenantDisplayName 'AM Consulting' -WhatIf

.EXAMPLE
    # Real run (drop -WhatIf) once the plan looks right:
    ./Provision-RbacPhase0.ps1 -ResourceGroup rg-m365admin -KeyVaultName amm365kv `
        -AccessGroupName 'M365 Admin Reports - Access' `
        -AdminGroupName 'M365 Admin Reports - Admins' `
        -TenantSlug am -TenantDisplayName 'AM Consulting'

.NOTES
    Requires: Azure CLI logged in (az login) with rights to create a Key Vault
    and assign roles in the resource group, and Entra rights to create security
    groups and app registrations. Admin consent requires a Privileged Role
    Administrator / Global Administrator.

    Exchange app-only additionally requires assigning the app's service principal
    an Exchange RBAC role (e.g. View-Only Organization Management) in Exchange
    Online. That is NOT an az/Graph operation and is printed as a manual
    follow-up step at the end.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory)][string] $ResourceGroup,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9-]{3,24}$')][string] $KeyVaultName,
    [string] $ContainerAppName = 'm365-admin-reports',
    [string] $Location,
    [string] $AccessGroupName  = 'M365 Admin Reports - Access',
    [string] $AdminGroupName   = 'M365 Admin Reports - Admins',
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]{1,16}$')][string] $TenantSlug,
    [Parameter(Mandatory)][string] $TenantDisplayName,
    [switch] $SkipAppRegistration,
    [switch] $SkipConsent
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Well-known resource app IDs.
$GraphAppId    = '00000003-0000-0000-c000-000000000000'  # Microsoft Graph
$ExoAppId      = '00000002-0000-0ff1-ce00-000000000000'  # Office 365 Exchange Online

# Read-only Graph APPLICATION permissions mirroring the delegated scopes the
# reports use today (see PERMISSIONS.md). Resolved to role GUIDs at runtime so we
# don't hardcode a brittle list.
$GraphAppRoles = @(
    'User.Read.All', 'Group.Read.All', 'Directory.Read.All', 'Organization.Read.All',
    'AuditLog.Read.All', 'Reports.Read.All', 'Policy.Read.All',
    'RoleManagement.Read.Directory', 'Sites.Read.All', 'IdentityRiskyUser.Read.All',
    'DeviceManagementManagedDevices.Read.All', 'DeviceManagementConfiguration.Read.All'
)
$ExoAppRole = 'Exchange.ManageAsApp'

# ── Helpers ───────────────────────────────────────────────────────────
function Invoke-Az {
    <#.SYNOPSIS Run an az command honoring -WhatIf; fail loudly on nonzero exit.#>
    param([Parameter(Mandatory)][string[]] $Args, [switch] $Quiet, [switch] $AllowFail)
    $display = 'az ' + ($Args -join ' ')
    if ($WhatIfPreference) { Write-Host "  WHATIF> $display" -ForegroundColor DarkYellow; return $null }
    if (-not $Quiet) { Write-Host "  > $display" -ForegroundColor DarkGray }
    $result = & az @Args
    if ($LASTEXITCODE -ne 0 -and -not $AllowFail) { throw "az command failed (exit $LASTEXITCODE): $display" }
    return $result
}

# Read-only az query that runs even under -WhatIf (safe; used for idempotency).
function Get-Az {
    param([Parameter(Mandatory)][string[]] $Args)
    $result = & az @Args 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $result
}

function Write-Step { param([string] $Msg) Write-Host "`n=== $Msg ===" -ForegroundColor Cyan }
function Write-Info { param([string] $Msg) Write-Host "  $Msg" -ForegroundColor Gray }
function Write-Ok   { param([string] $Msg) Write-Host "  [ok] $Msg" -ForegroundColor Green }

# ── 0. Prerequisites ──────────────────────────────────────────────────
Write-Step 'Checking prerequisites'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI (az) not found on PATH.' }
$acct = Get-Az @('account','show','-o','json')
if (-not $acct) { throw 'Not logged in. Run: az login' }
$ctx = $acct | ConvertFrom-Json
Write-Info "Subscription : $($ctx.name) ($($ctx.id))"
Write-Info "Tenant       : $($ctx.tenantId)"
Write-Info "Signed in as : $($ctx.user.name)"
if (-not $Location) {
    $rg = Get-Az @('group','show','-n',$ResourceGroup,'-o','json')
    if ($rg) { $Location = ($rg | ConvertFrom-Json).location }
    if (-not $Location) { throw "Resource group '$ResourceGroup' not found and no -Location given." }
}
Write-Info "Location     : $Location"

$summary = [ordered]@{
    subscriptionId = $ctx.id
    tenantId       = $ctx.tenantId
    keyVault       = $KeyVaultName
}

# ── 1. Key Vault (RBAC-authorization mode) ────────────────────────────
Write-Step "Ensuring Key Vault '$KeyVaultName'"
$existingKv = Get-Az @('keyvault','show','-n',$KeyVaultName,'-g',$ResourceGroup,'-o','json')
if ($existingKv) {
    Write-Ok 'Key Vault already exists.'
} else {
    if ($PSCmdlet.ShouldProcess($KeyVaultName, 'Create Key Vault (RBAC auth)')) {
        Invoke-Az @('keyvault','create','-n',$KeyVaultName,'-g',$ResourceGroup,
            '-l',$Location,'--enable-rbac-authorization','true','-o','none') | Out-Null
        Write-Ok 'Key Vault created.'
    }
}
$kvId = if ($existingKv) { ($existingKv | ConvertFrom-Json).id } else {
    $k = Get-Az @('keyvault','show','-n',$KeyVaultName,'-g',$ResourceGroup,'-o','json')
    if ($k) { ($k | ConvertFrom-Json).id } else { $null }
}

# ── 2. Container App system-assigned identity + KV role ────────────────
Write-Step "Enabling managed identity on '$ContainerAppName' and granting KV access"
$principalId = $null
if ($PSCmdlet.ShouldProcess($ContainerAppName, 'Assign system-assigned identity')) {
    Invoke-Az @('containerapp','identity','assign','-n',$ContainerAppName,'-g',$ResourceGroup,
        '--system-assigned','-o','none') | Out-Null
}
$idJson = Get-Az @('containerapp','identity','show','-n',$ContainerAppName,'-g',$ResourceGroup,'-o','json')
if ($idJson) {
    $idObj = $idJson | ConvertFrom-Json
    # Under -WhatIf the identity isn't assigned yet, so the object is { type: None }
    # with no principalId. Access it defensively (StrictMode is on).
    if ($idObj.PSObject.Properties.Name -contains 'principalId') { $principalId = $idObj.principalId }
}
if ($principalId) {
    Write-Ok "Identity principalId: $principalId"
    if ($kvId -and $PSCmdlet.ShouldProcess($KeyVaultName, "Grant 'Key Vault Secrets User' to app identity")) {
        # Idempotent: az role assignment create is a no-op if it already exists.
        Invoke-Az @('role','assignment','create','--assignee-object-id',$principalId,
            '--assignee-principal-type','ServicePrincipal',
            '--role','Key Vault Secrets User','--scope',$kvId,'-o','none') -AllowFail | Out-Null
        Write-Ok "Granted 'Key Vault Secrets User' on the vault."
    }
} elseif (-not $WhatIfPreference) {
    Write-Warning 'Could not resolve the container app identity principalId; grant KV access manually.'
}
$summary['appIdentityPrincipalId'] = $principalId

# ── 3. Entra security groups (access + admin) ─────────────────────────
function Ensure-SecurityGroup {
    param([string] $DisplayName)
    $mailNick = ($DisplayName -replace '[^a-zA-Z0-9]', '').ToLower()
    $existing = Get-Az @('ad','group','list','--display-name',$DisplayName,'-o','json')
    if ($existing) {
        # Force an array: an empty result ("[]") enumerates to $null, and a
        # single match to a bare object — both break .Count under StrictMode.
        $g = @($existing | ConvertFrom-Json)
        if ($g.Count -ge 1) { return $g[0].id }
    }
    if ($PSCmdlet.ShouldProcess($DisplayName, 'Create Entra security group')) {
        $created = Invoke-Az @('ad','group','create','--display-name',$DisplayName,
            '--mail-nickname',$mailNick,'-o','json')
        if ($created) { return ($created | ConvertFrom-Json).id }
    }
    return $null
}
Write-Step 'Ensuring Entra security groups'
$accessGroupId = Ensure-SecurityGroup -DisplayName $AccessGroupName
$adminGroupId  = Ensure-SecurityGroup -DisplayName $AdminGroupName
Write-Ok "Access group: $AccessGroupName -> $accessGroupId"
Write-Ok "Admin  group: $AdminGroupName -> $adminGroupId"
$summary['accessGroupId'] = $accessGroupId
$summary['adminGroupId']  = $adminGroupId

# ── 4. Per-tenant app-only app registration + cert ────────────────────
if (-not $SkipAppRegistration) {
    $appDisplayName = "M365 Admin Reports - $TenantDisplayName (app-only)"
    $certName       = "m365-report-$TenantSlug"
    Write-Step "Ensuring app registration '$appDisplayName'"

    # Resolve APPLICATION permission role GUIDs from the resource SPs.
    function Resolve-AppRole {
        param([string] $ResourceAppId, [string] $RoleValue)
        $sp = Get-Az @('ad','sp','show','--id',$ResourceAppId,
            '--query',"appRoles[?value=='$RoleValue'].id | [0]",'-o','tsv')
        if (-not $sp) { Write-Warning "Could not resolve app role '$RoleValue' on $ResourceAppId"; }
        return $sp
    }

    # Find or create the app registration.
    $appId = Get-Az @('ad','app','list','--display-name',$appDisplayName,
        '--query','[0].appId','-o','tsv')
    if (-not $appId -and $PSCmdlet.ShouldProcess($appDisplayName, 'Create app registration')) {
        $appId = Invoke-Az @('ad','app','create','--display-name',$appDisplayName,
            '--sign-in-audience','AzureADMyOrg','--query','appId','-o','tsv')
    }
    Write-Ok "App (client) ID: $appId"

    # Add required Graph application permissions.
    Write-Info 'Adding Microsoft Graph application permissions...'
    foreach ($role in $GraphAppRoles) {
        $roleId = Resolve-AppRole -ResourceAppId $GraphAppId -RoleValue $role
        if ($roleId -and $appId) {
            Invoke-Az @('ad','app','permission','add','--id',$appId,'--api',$GraphAppId,
                '--api-permissions',"$roleId=Role",'-o','none') -AllowFail -Quiet | Out-Null
            Write-Info "  + $role"
        }
    }
    # Exchange.ManageAsApp (app-only EXO).
    $exoRoleId = Resolve-AppRole -ResourceAppId $ExoAppId -RoleValue $ExoAppRole
    if ($exoRoleId -and $appId) {
        Invoke-Az @('ad','app','permission','add','--id',$appId,'--api',$ExoAppId,
            '--api-permissions',"$exoRoleId=Role",'-o','none') -AllowFail -Quiet | Out-Null
        Write-Info "  + $ExoAppRole (Exchange)"
    }

    # Ensure a service principal exists for the app (needed for consent + roles).
    if ($appId) {
        $spExists = Get-Az @('ad','sp','show','--id',$appId,'--query','id','-o','tsv')
        if (-not $spExists -and $PSCmdlet.ShouldProcess($appId, 'Create service principal')) {
            Invoke-Az @('ad','sp','create','--id',$appId,'-o','none') -AllowFail | Out-Null
        }
    }

    # Generate the certificate INSIDE Key Vault (private key stays in KV), then
    # add only the public portion to the app registration.
    if ($appId -and $kvId) {
        Write-Info "Creating certificate '$certName' in Key Vault (private key stays in KV)..."
        $certExists = Get-Az @('keyvault','certificate','show','--vault-name',$KeyVaultName,
            '-n',$certName,'--query','id','-o','tsv')
        if (-not $certExists -and $PSCmdlet.ShouldProcess($certName, 'Create KV certificate (default policy)')) {
            $policy = Get-Az @('keyvault','certificate','get-default-policy','-o','json')
            $polFile = New-TemporaryFile
            $policy | Set-Content -Path $polFile -Encoding utf8
            Invoke-Az @('keyvault','certificate','create','--vault-name',$KeyVaultName,
                '-n',$certName,'-p',"@$polFile",'-o','none') | Out-Null
            Remove-Item $polFile -ErrorAction SilentlyContinue
        }
        # Upload the public cert to the app registration as a key credential.
        if ($PSCmdlet.ShouldProcess($appId, 'Attach public cert to app registration')) {
            $cerFile = New-TemporaryFile
            $cerPath = "$cerFile.cer"
            Invoke-Az @('keyvault','certificate','download','--vault-name',$KeyVaultName,
                '-n',$certName,'-f',$cerPath,'-e','DER','-o','none') | Out-Null
            Invoke-Az @('ad','app','credential','reset','--id',$appId,'--cert',"@$cerPath",
                '--append','-o','none') -AllowFail | Out-Null
            Remove-Item $cerFile,$cerPath -ErrorAction SilentlyContinue
            Write-Ok 'Public certificate attached to the app registration.'
        }
    }

    # Admin consent for the application permissions.
    if (-not $SkipConsent -and $appId -and $PSCmdlet.ShouldProcess($appId, 'Grant admin consent')) {
        Write-Info 'Granting admin consent (requires a privileged admin)...'
        Invoke-Az @('ad','app','permission','admin-consent','--id',$appId,'-o','none') -AllowFail | Out-Null
        Write-Ok 'Admin consent requested (verify in Entra > App registrations > API permissions).'
    }

    $summary['tenant'] = [ordered]@{
        id          = $TenantSlug
        name        = $TenantDisplayName
        tenantId    = $ctx.tenantId
        clientId    = $appId
        certSecret  = "kv:$certName"
    }
}

# ── 5. Summary ─────────────────────────────────────────────────────────
Write-Step 'Phase 0 summary — values for the RBAC store (DATA_DIR/access/rbac.json)'
$summary | ConvertTo-Json -Depth 5 | Write-Host
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Add members to the Access and Admin Entra groups.' -ForegroundColor Gray
Write-Host '  2. Verify admin consent in Entra (App registrations > API permissions).' -ForegroundColor Gray
Write-Host "  3. Exchange app-only: assign the app's service principal an Exchange RBAC" -ForegroundColor Gray
Write-Host '     role (e.g. View-Only Organization Management) in Exchange Online —' -ForegroundColor Gray
Write-Host '     this is a manual EXO step, not an az command.' -ForegroundColor Gray
Write-Host '  4. Paste the tenant/group IDs above into the v12 RBAC store when Phase 2 lands.' -ForegroundColor Gray
if ($WhatIfPreference) { Write-Host "`n(-WhatIf: nothing was changed.)" -ForegroundColor DarkYellow }
