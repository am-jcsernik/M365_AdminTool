#Requires -Version 7
<#
.SYNOPSIS
    Build and deploy M365 Admin Reports to Azure Container Apps (ACA).

.DESCRIPTION
    End-to-end, idempotent-where-possible deployment wrapper around the
    Azure CLI and deploy/main.bicep. It:

      1. Verifies prerequisites (az CLI, logged-in context, subscription).
      2. Creates the resource group.
      3. Creates (or reuses) an Azure Container Registry and builds/pushes the
         image in the cloud with `az acr build` (no local docker push needed).
      4. Creates (or reuses) a storage account + Azure Files share for the
         DATA_DIR volume (snapshots, audit log, console logs, CSV exports).
      5. Deploys the infrastructure via Bicep and captures the app FQDN.
      6. Registers an Entra application for the ingress gate and enables
         Container Apps built-in authentication (Easy Auth), restricting
         sign-in to the specified home tenant.

    As of v12, Easy Auth is the OUTER ingress gate and in-app RBAC enforces
    authorization inside it (which tenants/reports each caller may use). Pass
    -AdminGroupId (and optionally -AccessGroupId / -KeyVaultName -DeployKeyVault)
    so the store seeds correctly; otherwise enforcement locks everyone out. See
    deploy/README.md, PERMISSIONS.md, and docs/ARCHITECTURE.md.

    Scale model is min 0 / max 1 (set in main.bicep). Because the authenticated
    Graph/Exchange session is held in a single in-memory pwsh process, the
    operator re-runs the in-app device-code sign-in on the first request after
    a cold start. Durable state on the Azure Files volume is unaffected.

.PARAMETER ResourceGroup
    Target resource group name (created if absent).

.PARAMETER Location
    Azure region (e.g. eastus).

.PARAMETER AcrName
    Azure Container Registry name (5-50 alphanumerics, globally unique).

.PARAMETER StorageAccountName
    Storage account for the Azure Files share (3-24 lowercase alphanumerics,
    globally unique).

.PARAMETER HomeTenantId
    Entra tenant (GUID or verified domain) allowed to sign in at the ingress.
    This gates WHO may use the tool; it is independent of which tenant the
    operator later connects Graph/Exchange to inside the app.

.PARAMETER Tag
    Image tag. Defaults to the version in package.json.

.PARAMETER KeyVaultName
    v12 RBAC: Key Vault holding per-tenant app-only certificates. Setting this
    (or -DeployKeyVault) enables app-only certificate connect.

.PARAMETER DeployKeyVault
    v12 RBAC: create the Key Vault (RBAC-auth) and grant the app identity read.
    Requires -KeyVaultName. Omit to reuse a vault provisioned out-of-band
    (e.g. by Provision-RbacPhase0.ps1).

.PARAMETER AccessGroupId
    v12 RBAC: Entra access-group object id (overall-access gate), seeded on first run.

.PARAMETER AdminGroupId
    v12 RBAC: Entra admin-group object id; members get the in-tool admin role.
    Strongly recommended — without it (and without a pre-seeded admin) v12
    enforcement 403s every operator.

.PARAMETER WhatIf
    Print the planned steps and az commands without executing them.

.EXAMPLE
    ./Deploy-ToAca.ps1 -ResourceGroup rg-m365admin -Location eastus `
        -AcrName amm365acr -StorageAccountName amm365data `
        -HomeTenantId am.consulting

.NOTES
    Requires: Azure CLI (az) logged in with rights to create the resource
    group, ACR, storage, Container Apps, and an Entra app registration.
    Run from the repo root or the deploy/ folder.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory)][string] $ResourceGroup,
    [Parameter(Mandatory)][string] $Location,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9]{5,50}$')][string] $AcrName,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]{3,24}$')][string] $StorageAccountName,
    [Parameter(Mandatory)][string] $HomeTenantId,
    [string] $ContainerAppName = 'm365-admin-reports',
    [string] $EnvironmentName  = 'm365-admin-env',
    [string] $FileShareName    = 'm365data',
    [string] $Tag,
    [string] $AppRegName       = 'M365 Admin Reports (Easy Auth)',
    [switch] $SkipBuild,

    # ── v12 RBAC ──────────────────────────────────────────────────────
    # Provide a Key Vault name to enable app-only certificate connect (the
    # vault is created + the app identity granted read when -DeployKeyVault).
    [string] $KeyVaultName,
    [switch] $DeployKeyVault,
    # Bootstrap group ids seed the store's access/admin gates on first run.
    # WARNING: with enforcement live, an EMPTY AdminGroupId AND no pre-seeded
    # admin/assignment 403s every operator. Pass at least AdminGroupId (whose
    # members you have already added) so you retain access after deploy.
    [string] $AccessGroupId,
    [string] $AdminGroupId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# `az acr build` streams the remote build log to the local console. On a Windows
# cp1252 console, a non-ASCII char in that log (e.g. U+2192 "→" from npm/build
# output) crashes the CLI with `UnicodeEncodeError: 'charmap' codec can't encode`
# and aborts the deploy — even though the server-side build is fine. Force UTF-8
# I/O for the child az/Python process so log streaming can encode any character.
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8       = '1'

# Resolve repo root (this script lives in deploy/).
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$BicepPath  = Join-Path $PSScriptRoot 'main.bicep'
$ImageName  = 'm365-admin-reports'

# ── Helpers ───────────────────────────────────────────────────────────
function Invoke-Az {
    <#.SYNOPSIS Run an az command, honoring -WhatIf, and fail loudly.#>
    param([Parameter(Mandatory)][string[]] $Args, [switch] $Quiet)
    $display = 'az ' + ($Args -join ' ')
    if ($WhatIfPreference) { Write-Host "  WHATIF> $display" -ForegroundColor DarkYellow; return $null }
    if (-not $Quiet) { Write-Host "  > $display" -ForegroundColor DarkGray }
    $result = & az @Args
    if ($LASTEXITCODE -ne 0) { throw "az command failed (exit $LASTEXITCODE): $display" }
    return $result
}

function Write-Step { param([string] $Msg) Write-Host "`n=== $Msg ===" -ForegroundColor Cyan }

# ── 0. Prerequisites ──────────────────────────────────────────────────
Write-Step 'Checking prerequisites'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI (az) not found on PATH. Install it and run `az login` first.'
}
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) { throw 'Not logged in. Run `az login` (and `az account set --subscription <id>`) first.' }
Write-Host "  Subscription: $($account.name) ($($account.id))"
Write-Host "  Signed in as: $($account.user.name)"

if (-not $Tag) {
    $pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
    $Tag = $pkg.version
    Write-Host "  Image tag (from package.json): $Tag"
}

# Ensure the containerapp CLI extension is present (auth subcommands need it).
Invoke-Az @('extension','add','--name','containerapp','--upgrade','--only-show-errors') -Quiet

# ── 1. Resource group ─────────────────────────────────────────────────
Write-Step "Resource group: $ResourceGroup"
Invoke-Az @('group','create','--name',$ResourceGroup,'--location',$Location,'--only-show-errors') | Out-Null

# ── 2. Container registry + image build ───────────────────────────────
Write-Step "Container registry: $AcrName"
Invoke-Az @('acr','create','--resource-group',$ResourceGroup,'--name',$AcrName,
    '--sku','Basic','--admin-enabled','true','--location',$Location,'--only-show-errors') | Out-Null

$AcrLoginServer = "$AcrName.azurecr.io"
$FullImage      = "$AcrLoginServer/${ImageName}:$Tag"

if ($SkipBuild) {
    Write-Step "Skipping image build (-SkipBuild): expecting $FullImage to exist"
    if (-not $WhatIfPreference) {
        # `show-tags` is a DATA-PLANE call (registry endpoint + AAD token challenge)
        # and can fail on its own (CONNECTIVITY_CHALLENGE_ERROR, stale token cache
        # after registry churn) even when the image is present. That read is NOT on
        # the deploy's critical path: ACA pulls via the ACR admin user/password
        # (basic auth) from Azure's own network. So treat a read *failure* as
        # inconclusive (warn + continue; the container pull is the real gate) and
        # only hard-fail when the read succeeds and the tag is genuinely absent.
        $tags = az acr repository show-tags --name $AcrName --repository $ImageName -o tsv 2>$null
        $tagsExit = $LASTEXITCODE
        if ($tagsExit -ne 0) {
            Write-Host "  WARN: could not read tags from the $AcrName data plane (exit $tagsExit); cannot confirm '$Tag' from here. Continuing -- ACA's image pull is the real check." -ForegroundColor Yellow
        } elseif ($tags -notcontains $Tag) {
            throw "-SkipBuild was set but image tag '$Tag' is not present in $AcrName. Build it first (drop -SkipBuild)."
        } else {
            Write-Host "  Found existing image: $FullImage" -ForegroundColor Green
        }
    }
} else {
    Write-Step "Building image in ACR: $FullImage"
    # `az acr build` uploads the build context and builds server-side, so a local
    # Docker daemon is not required. Context is the repo root (respects .dockerignore).
    #
    # IMPORTANT (Windows): az's build-LOG STREAMER crashes with a
    # `UnicodeEncodeError` when a non-ASCII char (e.g. U+2192 "→" from npm/apt
    # output) is written to a cp1252 console. It can die mid-build or after the
    # server-side build has already succeeded; `PYTHONUTF8`/`PYTHONIOENCODING`
    # don't help because the shipped az is a frozen build. Fix: `--no-logs`
    # suppresses that client stream entirely — az still WAITS for the server-side
    # build and returns a correct exit code, there's just nothing to crash on.
    # The tag-existence check below is a belt-and-suspenders backstop.
    if ($WhatIfPreference) {
        Write-Host "  WHATIF> az acr build --no-logs --registry $AcrName --image ${ImageName}:$Tag $RepoRoot" -ForegroundColor DarkYellow
    } else {
        Write-Host "  > az acr build --no-logs --registry $AcrName --image ${ImageName}:$Tag $RepoRoot" -ForegroundColor DarkGray
        & az acr build --no-logs --registry $AcrName --image "${ImageName}:$Tag" $RepoRoot 2>&1 | ForEach-Object { Write-Host "    $_" }
        $buildExit = $LASTEXITCODE
        if ($buildExit -eq 0) {
            # Clean success: with --no-logs, az waited for the server-side build
            # and returned 0. Do NOT gate on a follow-up show-tags read here --
            # the freshly pushed tag can lag the registry's tag listing briefly.
            Write-Host "  Image built and pushed: $FullImage" -ForegroundColor Green
        } else {
            # Non-zero exit: az may have crashed on the log stream (Windows Unicode
            # bug) *after* the server-side build already succeeded. Verify by tag.
            $tags = az acr repository show-tags --name $AcrName --repository $ImageName -o tsv 2>$null
            if ($tags -contains $Tag) {
                Write-Host "  az acr build exited $buildExit (likely the Windows log-stream Unicode bug), but image '$Tag' IS present in ACR -- continuing." -ForegroundColor Yellow
            } else {
                throw "az acr build failed (exit $buildExit) and image tag '$Tag' is not in $AcrName. See build output above."
            }
        }
    }
}

Write-Host '  Retrieving ACR admin credentials...'
if (-not $WhatIfPreference) {
    $acrCreds = az acr credential show --name $AcrName | ConvertFrom-Json
    $AcrUsername = $acrCreds.username
    $AcrPassword = $acrCreds.passwords[0].value
} else { $AcrUsername = '<acr-user>'; $AcrPassword = '<acr-pass>' }

# ── 3. Storage account + file share (DATA_DIR volume) ─────────────────
Write-Step "Storage account: $StorageAccountName (share: $FileShareName)"
Invoke-Az @('storage','account','create','--resource-group',$ResourceGroup,'--name',$StorageAccountName,
    '--location',$Location,'--sku','Standard_LRS','--kind','StorageV2','--only-show-errors') | Out-Null

if (-not $WhatIfPreference) {
    $StorageKey = (az storage account keys list --resource-group $ResourceGroup --account-name $StorageAccountName | ConvertFrom-Json)[0].value
} else { $StorageKey = '<storage-key>' }

Invoke-Az @('storage','share','create','--name',$FileShareName,'--account-name',$StorageAccountName,
    '--account-key',$StorageKey,'--quota','5','--only-show-errors') | Out-Null
Write-Host '  NOTE: upload your real config.json (tenant list) to this share if you use the tenant picker.'

# ── 4. Deploy infrastructure (Bicep) ──────────────────────────────────
Write-Step 'Deploying infrastructure via Bicep'
$deployArgs = @(
    'deployment','group','create',
    '--resource-group',$ResourceGroup,
    '--template-file',$BicepPath,
    '--parameters',
        "containerAppName=$ContainerAppName",
        "environmentName=$EnvironmentName",
        "image=$FullImage",
        "acrLoginServer=$AcrLoginServer",
        "acrUsername=$AcrUsername",
        "acrPassword=$AcrPassword",
        "storageAccountName=$StorageAccountName",
        "storageAccountKey=$StorageKey",
        "fileShareName=$FileShareName"
)
# ── v12 RBAC parameters (additive; safe defaults keep pre-v12 behavior) ──
$deployKv = [bool]($DeployKeyVault -or $KeyVaultName)
$deployArgs += @(
    "deployKeyVault=$($deployKv.ToString().ToLower())",
    "keyVaultName=$KeyVaultName",
    "accessGroupId=$AccessGroupId",
    "adminGroupId=$AdminGroupId"
)
if ($deployKv -and -not $KeyVaultName) { throw 'Provide -KeyVaultName when -DeployKeyVault is set.' }
if (-not $AdminGroupId) {
    Write-Warning 'No -AdminGroupId supplied. With v12 enforcement live, the seeded store will have no admin gate; unless the store already contains an admin/assignment, every operator will be 403''d. Continue only if you know the store is pre-seeded.'
}
$deployArgs += @('--query','properties.outputs.appFqdn.value','-o','tsv')
$Fqdn = Invoke-Az $deployArgs
if ($WhatIfPreference) { $Fqdn = '<app>.<region>.azurecontainerapps.io' }
Write-Host "  App FQDN: $Fqdn" -ForegroundColor Green

# ── 5. Entra app registration + Easy Auth (ingress gate) ──────────────
Write-Step 'Configuring Easy Auth (Entra ingress gate)'
$RedirectUri = "https://$Fqdn/.auth/login/aad/callback"

if (-not $WhatIfPreference) {
    $existing = az ad app list --display-name $AppRegName --query '[0]' | ConvertFrom-Json
    if ($existing) {
        $AppId = $existing.appId
        Write-Host "  Reusing app registration: $AppId"
        Invoke-Az @('ad','app','update','--id',$AppId,'--web-redirect-uris',$RedirectUri) | Out-Null
    } else {
        $created = az ad app create --display-name $AppRegName --web-redirect-uris $RedirectUri `
            --enable-id-token-issuance true | ConvertFrom-Json
        $AppId = $created.appId
        Write-Host "  Created app registration: $AppId"
    }
    # Client secret for the confidential-client Easy Auth flow.
    $secret = az ad app credential reset --id $AppId --append --display-name 'easyauth' --query password -o tsv
} else { $AppId = '<easyauth-app-id>'; $secret = '<secret>' }

$Issuer = "https://login.microsoftonline.com/$HomeTenantId/v2.0"

# Register the provider, restrict token issuer/audience to the home tenant,
# and require authentication for every request (redirect to login).
Invoke-Az @('containerapp','auth','microsoft','update',
    '--resource-group',$ResourceGroup,'--name',$ContainerAppName,
    '--client-id',$AppId,'--client-secret',$secret,
    '--issuer',$Issuer,'--allowed-audiences',"api://$AppId",
    '--yes') | Out-Null

Invoke-Az @('containerapp','auth','update',
    '--resource-group',$ResourceGroup,'--name',$ContainerAppName,
    '--unauthenticated-client-action','RedirectToLoginPage',
    '--redirect-provider','azureactivedirectory') | Out-Null

# ── Done ──────────────────────────────────────────────────────────────
Write-Step 'Deployment complete'
Write-Host "  URL:            https://$Fqdn" -ForegroundColor Green
Write-Host '  Ingress gate:   Entra Easy Auth (home tenant only)'
Write-Host '  Graph/EXO auth: device code — open the URL, sign in, then Connect;'
Write-Host '                  watch container logs for the device code:'
Write-Host "                  az containerapp logs show -g $ResourceGroup -n $ContainerAppName --follow"
Write-Host '  Scale:          min 0 / max 1 — re-connect after a cold start.'
Write-Host '  Reminder:       Easy Auth gates WHO uses the tool; inside the app you'
Write-Host '                  can still device-code connect into a client tenant.'
