#Requires -Version 7
<#
.SYNOPSIS
    Idempotently grant the v12 app-only service principal an Exchange Online RBAC
    role so app-only (certificate) Exchange reports work.

.DESCRIPTION
    Step 4 of the v12 operational rollout (see docs/STATE.md and PERMISSIONS.md).
    Under app-only auth the tool authenticates as a per-tenant Entra app
    registration. The Graph `Exchange.ManageAsApp` application permission alone is
    NOT sufficient for Exchange Online reports -- the app's service principal must
    also be registered INSIDE Exchange Online and assigned an EXO management role.

    This script performs the two EXO steps idempotently:

      1. Register the Entra service principal in Exchange Online
         (New-ServicePrincipal) -- skipped if it already exists.
      2. Assign it one or more read-only management ROLES (default:
         "View-Only Recipients", "View-Only Configuration", "Message Tracking")
         -- each skipped if already assigned.

    NOTE: -Role takes management ROLES, not role GROUPS. "View-Only Organization
    Management" is a role *group* and cannot be assigned to an app via
    New-ManagementRoleAssignment -- the underlying view-only management roles are
    assigned individually instead.

    It resolves the service principal's object ID automatically from the -ClientId
    via Azure CLI (`az ad sp show`) when -SpObjectId is not supplied, so you don't
    have to look it up by hand. Re-running is safe: every create is guarded by a
    prior existence check.

    IMPORTANT ID mapping (the usual failure point):
      -AppId    = the app registration's client ID.
      -ObjectId = the ENTERPRISE APP / service principal object ID
                  (Entra > Enterprise applications > Object ID), NOT the app
                  registration's object ID.

.PARAMETER ClientId
    The app registration (client) ID of the per-tenant app-only app. Defaults to
    AM's app-only client ID provisioned in Phase 0.

.PARAMETER Organization
    The Exchange Online organization to connect to (e.g. am.consulting). Required
    for app connection context and for the -Organization hint on Connect.

.PARAMETER Roles
    One or more Exchange management ROLES to assign to the app. Defaults to the
    read-only set the reports require: "View-Only Recipients",
    "View-Only Configuration", "Message Tracking". Must be management roles, not
    role groups (see the note above).

.PARAMETER SpObjectId
    The service principal (enterprise application) object ID. If omitted, the
    script resolves it from -ClientId via `az ad sp show`.

.PARAMETER DisplayName
    Friendly name for the EXO-side service principal record.

.PARAMETER SkipConnect
    Do not call Connect-ExchangeOnline -- use this if you already have an EXO
    session open in the current PowerShell process.

.EXAMPLE
    ./Grant-ExoAppOnlyRole.ps1 -Organization am.consulting -WhatIf

    Preview what would be created/assigned for AM's default app-only client.

.EXAMPLE
    ./Grant-ExoAppOnlyRole.ps1 -Organization am.consulting

    Register the SP in EXO and assign View-Only Organization Management.

.EXAMPLE
    ./Grant-ExoAppOnlyRole.ps1 -ClientId <guid> -SpObjectId <guid> `
        -Organization contoso.com -Roles "View-Only Recipients"

    Onboard a different tenant's app-only SP with an explicit object ID and a
    single, narrower role.

.NOTES
    Requires:
      - PowerShell 7+.
      - ExchangeOnlineManagement module (Install-Module ExchangeOnlineManagement).
      - An account with an Exchange admin role that can create service principals
        and management role assignments (e.g. Organization Management).
      - Azure CLI logged in (az login) IF -SpObjectId is not supplied.

    This is a manual EXO step -- it is NOT an az/Graph operation and is deliberately
    kept out of Provision-RbacPhase0.ps1, which prints it as a follow-up.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string] $ClientId = '25407385-9354-471d-8532-6ea147a00f42',

    [Parameter(Mandatory)]
    [string] $Organization,

    [string[]] $Roles = @('View-Only Recipients', 'View-Only Configuration', 'Message Tracking'),

    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string] $SpObjectId,

    [string] $DisplayName = 'M365 Admin Reports (app-only)',

    [switch] $SkipConnect
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step { param([string] $Msg) Write-Host "`n=== $Msg ===" -ForegroundColor Cyan }
function Write-Info { param([string] $Msg) Write-Host "  $Msg" -ForegroundColor Gray }
function Write-Ok   { param([string] $Msg) Write-Host "  [ok] $Msg" -ForegroundColor Green }

# ── 0. Prerequisites ──────────────────────────────────────────────────
Write-Step 'Checking prerequisites'
if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
    throw 'ExchangeOnlineManagement module not found. Install it: Install-Module ExchangeOnlineManagement -Scope CurrentUser'
}
Write-Ok 'ExchangeOnlineManagement module present.'

# ── 1. Resolve the service principal object ID (if not supplied) ───────
if (-not $SpObjectId) {
    Write-Step "Resolving service principal object ID for client $ClientId"
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw 'Azure CLI (az) not found and -SpObjectId not supplied. Install az and `az login`, or pass -SpObjectId explicitly.'
    }
    $SpObjectId = (& az ad sp show --id $ClientId --query 'id' -o tsv 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($SpObjectId)) {
        throw "Could not resolve the service principal for client $ClientId via az. Confirm the enterprise app exists in this tenant, or pass -SpObjectId explicitly."
    }
    Write-Ok "Resolved SP object ID: $SpObjectId"
} else {
    Write-Info "Using supplied SP object ID: $SpObjectId"
}

# ── 2. Connect to Exchange Online ─────────────────────────────────────
if (-not $SkipConnect) {
    Write-Step "Connecting to Exchange Online ($Organization)"
    if ($PSCmdlet.ShouldProcess($Organization, 'Connect-ExchangeOnline')) {
        try {
            Import-Module ExchangeOnlineManagement -ErrorAction Stop
            Connect-ExchangeOnline -Organization $Organization -ShowBanner:$false -ErrorAction Stop
            Write-Ok 'Connected to Exchange Online.'
        } catch {
            throw "Failed to connect to Exchange Online: $($_.Exception.Message)"
        }
    }
} else {
    Write-Info 'Skipping Connect-ExchangeOnline (-SkipConnect); assuming an existing session.'
}

# ── 3. Register the Entra SP inside Exchange Online (idempotent) ───────
Write-Step "Ensuring Exchange service principal for app $ClientId"
$existingSp = $null
try {
    $existingSp = Get-ServicePrincipal -Identity $ClientId -ErrorAction Stop
} catch {
    # Get-ServicePrincipal throws when the SP does not exist yet; treat as "absent".
    $existingSp = $null
}

if ($existingSp) {
    # Note: reference AppId/DisplayName only — the object shape varies by module
    # version and Set-StrictMode throws on a missing property (e.g. ServiceId).
    Write-Ok "Exchange service principal already registered (AppId $($existingSp.AppId))."
} else {
    if ($PSCmdlet.ShouldProcess($ClientId, "New-ServicePrincipal ($DisplayName)")) {
        try {
            New-ServicePrincipal -AppId $ClientId -ObjectId $SpObjectId -DisplayName $DisplayName -ErrorAction Stop | Out-Null
            Write-Ok 'Registered the service principal in Exchange Online.'
        } catch {
            throw "New-ServicePrincipal failed: $($_.Exception.Message)"
        }
    }
}

# ── 4. Assign the management role(s) (idempotent, per role) ───────────
foreach ($role in $Roles) {
    Write-Step "Ensuring management role assignment '$role'"

    # Guard: -Role must be a management ROLE, not a role GROUP. Fail early with a
    # clear message rather than the opaque "management role can't be found".
    $roleObj = $null
    try { $roleObj = Get-ManagementRole -Identity $role -ErrorAction Stop } catch { $roleObj = $null }
    if (-not $roleObj) {
        throw "Management role '$role' was not found. Confirm it is a management ROLE (not a role GROUP such as 'View-Only Organization Management'). List candidates with: Get-ManagementRole | Where-Object Name -like 'View-Only*'."
    }

    # Match on both role and assignee so we don't create a duplicate assignment.
    $existingAssignment = $null
    try {
        $existingAssignment = Get-ManagementRoleAssignment -RoleAssignee $ClientId -ErrorAction Stop |
            Where-Object { $_.Role -eq $role }
    } catch {
        $existingAssignment = $null
    }

    if ($existingAssignment) {
        Write-Ok "Role '$role' is already assigned to the app service principal."
    } else {
        if ($PSCmdlet.ShouldProcess($ClientId, "New-ManagementRoleAssignment -Role '$role'")) {
            try {
                New-ManagementRoleAssignment -App $ClientId -Role $role -ErrorAction Stop | Out-Null
                Write-Ok "Assigned '$role' to the app service principal."
            } catch {
                throw "New-ManagementRoleAssignment failed for '$role': $($_.Exception.Message)"
            }
        }
    }
}

# ── 5. Verify ──────────────────────────────────────────────────────────
Write-Step 'Verification'
if (-not $WhatIfPreference) {
    try {
        $sp = Get-ServicePrincipal -Identity $ClientId -ErrorAction Stop
        Write-Info "EXO service principal : $($sp.DisplayName)  (AppId $($sp.AppId))"
    } catch {
        Write-Warning "Could not read back the service principal: $($_.Exception.Message)"
    }
    try {
        $asn = Get-ManagementRoleAssignment -RoleAssignee $ClientId -ErrorAction Stop
        foreach ($a in @($asn)) { Write-Info "Role assignment       : $($a.Role) -> $($a.RoleAssigneeName)" }
    } catch {
        Write-Warning "Could not read back role assignments: $($_.Exception.Message)"
    }
    Write-Host ''
    Write-Host 'Next: connect the AM tenant in the app and run one Exchange report' -ForegroundColor Cyan
    Write-Host '      (e.g. Shared Mailboxes) to confirm app-only EXO works end-to-end.' -ForegroundColor Gray
} else {
    Write-Host "`n(-WhatIf: nothing was changed.)" -ForegroundColor DarkYellow
}
