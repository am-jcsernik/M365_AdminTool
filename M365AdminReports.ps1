<#
.SYNOPSIS
    M365 Admin Read-Only Reports Utility
.DESCRIPTION
    A menu-driven PowerShell utility that connects to Microsoft 365 / Office 365
    via Microsoft Graph PowerShell SDK and runs read-only canned reports.
    NO write operations are performed — this is strictly a reporting tool.
.REQUIREMENTS
    - PowerShell 7+ (recommended) or Windows PowerShell 5.1
    - Microsoft.Graph PowerShell SDK:
        Install-Module Microsoft.Graph -Scope CurrentUser
    - Exchange Online Management Module (for mailbox reports):
        Install-Module ExchangeOnlineManagement -Scope CurrentUser
    - Appropriate read permissions in your M365 tenant
.NOTES
    Author : M365 Admin Toolkit
    Version: 1.0.0
    License: MIT
#>

#Requires -Version 5.1

# ── CONFIGURATION ────────────────────────────────────────────────────────────
$Script:ExportPath = Join-Path $PSScriptRoot "M365Reports"
$Script:ConnectedGraph = $false
$Script:ConnectedExchange = $false
$Script:Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

# ── COLORS & FORMATTING ─────────────────────────────────────────────────────
function Write-Banner {
    $banner = @"

    ╔══════════════════════════════════════════════════════════════╗
    ║           M365 ADMIN READ-ONLY REPORTS UTILITY              ║
    ║                    v1.0.0                                    ║
    ╠══════════════════════════════════════════════════════════════╣
    ║  All operations are READ-ONLY. No changes will be made.     ║
    ╚══════════════════════════════════════════════════════════════╝

"@
    Write-Host $banner -ForegroundColor Cyan
}

function Write-Section ([string]$Title) {
    Write-Host ""
    Write-Host "  ── $Title ──" -ForegroundColor Yellow
    Write-Host ""
}

function Write-Status ([string]$Message, [string]$Type = "Info") {
    switch ($Type) {
        "Success" { Write-Host "  [✓] $Message" -ForegroundColor Green }
        "Error"   { Write-Host "  [✗] $Message" -ForegroundColor Red }
        "Warning" { Write-Host "  [!] $Message" -ForegroundColor DarkYellow }
        "Info"    { Write-Host "  [i] $Message" -ForegroundColor Cyan }
    }
}

function Confirm-Export {
    param([object]$Data, [string]$ReportName)

    if (-not $Data -or ($Data | Measure-Object).Count -eq 0) {
        Write-Status "No data returned for this report." "Warning"
        return
    }

    $count = ($Data | Measure-Object).Count
    Write-Status "Found $count record(s)." "Success"

    # Display in console (truncated for readability)
    $Data | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

    $export = Read-Host "  Export to CSV? (Y/N)"
    if ($export -eq 'Y' -or $export -eq 'y') {
        if (-not (Test-Path $Script:ExportPath)) {
            New-Item -ItemType Directory -Path $Script:ExportPath -Force | Out-Null
        }
        $file = Join-Path $Script:ExportPath "${ReportName}_${Script:Timestamp}.csv"
        $Data | Export-Csv -Path $file -NoTypeInformation -Encoding UTF8
        Write-Status "Exported to: $file" "Success"
    }
}

# ── MODULE CHECKS & CONNECTION ───────────────────────────────────────────────
function Test-Prerequisites {
    Write-Section "Checking Prerequisites"

    # Check Microsoft.Graph
    $graphModule = Get-Module -ListAvailable -Name "Microsoft.Graph.Users" -ErrorAction SilentlyContinue
    if ($graphModule) {
        Write-Status "Microsoft.Graph SDK found (v$($graphModule.Version))" "Success"
    } else {
        Write-Status "Microsoft.Graph SDK not found." "Error"
        Write-Host "    Install with: Install-Module Microsoft.Graph -Scope CurrentUser" -ForegroundColor Gray
        return $false
    }

    # Check ExchangeOnlineManagement (optional)
    $exoModule = Get-Module -ListAvailable -Name "ExchangeOnlineManagement" -ErrorAction SilentlyContinue
    if ($exoModule) {
        Write-Status "ExchangeOnlineManagement found (v$($exoModule.Version))" "Success"
    } else {
        Write-Status "ExchangeOnlineManagement not found (mailbox reports unavailable)." "Warning"
        Write-Host "    Install with: Install-Module ExchangeOnlineManagement -Scope CurrentUser" -ForegroundColor Gray
    }

    return $true
}

function Connect-M365Graph {
    Write-Section "Connecting to Microsoft Graph"

    if ($Script:ConnectedGraph) {
        Write-Status "Already connected to Microsoft Graph." "Info"
        return $true
    }

    try {
        # Request read-only scopes
        $scopes = @(
            "User.Read.All",
            "Group.Read.All",
            "Directory.Read.All",
            "Organization.Read.All",
            "AuditLog.Read.All",
            "Reports.Read.All",
            "Policy.Read.All",
            "RoleManagement.Read.Directory",
            "DeviceManagementManagedDevices.Read.All"
        )

        Write-Status "Launching interactive sign-in..." "Info"
        Connect-MgGraph -Scopes $scopes -ErrorAction Stop
        $Script:ConnectedGraph = $true

        $ctx = Get-MgContext
        Write-Status "Connected as: $($ctx.Account)" "Success"
        Write-Status "Tenant ID   : $($ctx.TenantId)" "Success"
        return $true
    }
    catch {
        Write-Status "Failed to connect: $($_.Exception.Message)" "Error"
        return $false
    }
}

function Connect-M365Exchange {
    if ($Script:ConnectedExchange) {
        Write-Status "Already connected to Exchange Online." "Info"
        return $true
    }

    $exoModule = Get-Module -ListAvailable -Name "ExchangeOnlineManagement" -ErrorAction SilentlyContinue
    if (-not $exoModule) {
        Write-Status "ExchangeOnlineManagement module not installed." "Error"
        return $false
    }

    try {
        Write-Status "Connecting to Exchange Online..." "Info"
        Connect-ExchangeOnline -ShowBanner:$false -ErrorAction Stop
        $Script:ConnectedExchange = $true
        Write-Status "Connected to Exchange Online." "Success"
        return $true
    }
    catch {
        Write-Status "Failed to connect to Exchange Online: $($_.Exception.Message)" "Error"
        return $false
    }
}

# ══════════════════════════════════════════════════════════════════════════════
#  REPORT FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════

# ── USER REPORTS ─────────────────────────────────────────────────────────────

function Report-AllUsers {
    Write-Section "All Users"
    $users = Get-MgUser -All -Property "DisplayName,UserPrincipalName,Mail,AccountEnabled,UserType,CreatedDateTime,LastPasswordChangeDateTime,Department,JobTitle,City,Country" |
        Select-Object DisplayName, UserPrincipalName, Mail, AccountEnabled, UserType, Department, JobTitle, City, Country, CreatedDateTime
    Confirm-Export -Data $users -ReportName "AllUsers"
}

function Report-UserDetails {
    Write-Section "User Details"
    $upn = Read-Host "  Enter User Principal Name (UPN) or display name to search"

    # Try direct lookup first, then search
    try {
        $user = Get-MgUser -UserId $upn -Property "DisplayName,UserPrincipalName,Mail,AccountEnabled,UserType,CreatedDateTime,LastPasswordChangeDateTime,Department,JobTitle,CompanyName,City,State,Country,MobilePhone,BusinessPhones,OfficeLocation,EmployeeId,EmployeeType,OnPremisesSyncEnabled,ProxyAddresses,AssignedLicenses,AssignedPlans" -ErrorAction Stop
    }
    catch {
        $results = Get-MgUser -Filter "startswith(displayName,'$upn')" -Property "DisplayName,UserPrincipalName" -Top 10
        if (-not $results) {
            $results = Get-MgUser -Search "displayName:$upn" -ConsistencyLevel eventual -Property "DisplayName,UserPrincipalName" -Top 10
        }
        if ($results -and ($results | Measure-Object).Count -gt 0) {
            Write-Host ""
            $results | ForEach-Object { $i = 0 } { $i++; Write-Host "    $i. $($_.DisplayName) ($($_.UserPrincipalName))" }
            $pick = Read-Host "  Select a user (number)"
            $selected = $results[([int]$pick - 1)]
            $user = Get-MgUser -UserId $selected.Id -Property "DisplayName,UserPrincipalName,Mail,AccountEnabled,UserType,CreatedDateTime,LastPasswordChangeDateTime,Department,JobTitle,CompanyName,City,State,Country,MobilePhone,BusinessPhones,OfficeLocation,EmployeeId,EmployeeType,OnPremisesSyncEnabled,ProxyAddresses,AssignedLicenses,AssignedPlans" -ErrorAction Stop
        }
        else {
            Write-Status "User not found." "Error"
            return
        }
    }

    if ($user) {
        Write-Host ""
        Write-Host "  ┌─────────────────────────────────────────────────" -ForegroundColor DarkGray
        Write-Host "  │ Display Name      : $($user.DisplayName)" -ForegroundColor White
        Write-Host "  │ UPN               : $($user.UserPrincipalName)" -ForegroundColor White
        Write-Host "  │ Email             : $($user.Mail)" -ForegroundColor White
        Write-Host "  │ Account Enabled   : $($user.AccountEnabled)" -ForegroundColor White
        Write-Host "  │ User Type         : $($user.UserType)" -ForegroundColor White
        Write-Host "  │ Department        : $($user.Department)" -ForegroundColor White
        Write-Host "  │ Job Title         : $($user.JobTitle)" -ForegroundColor White
        Write-Host "  │ Company           : $($user.CompanyName)" -ForegroundColor White
        Write-Host "  │ Office            : $($user.OfficeLocation)" -ForegroundColor White
        Write-Host "  │ City              : $($user.City)" -ForegroundColor White
        Write-Host "  │ State             : $($user.State)" -ForegroundColor White
        Write-Host "  │ Country           : $($user.Country)" -ForegroundColor White
        Write-Host "  │ Mobile Phone      : $($user.MobilePhone)" -ForegroundColor White
        Write-Host "  │ Business Phones   : $($user.BusinessPhones -join ', ')" -ForegroundColor White
        Write-Host "  │ Employee ID       : $($user.EmployeeId)" -ForegroundColor White
        Write-Host "  │ Employee Type     : $($user.EmployeeType)" -ForegroundColor White
        Write-Host "  │ On-Prem Sync      : $($user.OnPremisesSyncEnabled)" -ForegroundColor White
        Write-Host "  │ Created           : $($user.CreatedDateTime)" -ForegroundColor White
        Write-Host "  │ Password Changed  : $($user.LastPasswordChangeDateTime)" -ForegroundColor White
        Write-Host "  │ Licenses (#)      : $(($user.AssignedLicenses | Measure-Object).Count)" -ForegroundColor White
        Write-Host "  │ Proxy Addresses   : $(($user.ProxyAddresses | Measure-Object).Count) address(es)" -ForegroundColor White
        Write-Host "  └─────────────────────────────────────────────────" -ForegroundColor DarkGray
    }
}

function Report-DisabledUsers {
    Write-Section "Disabled (Blocked) Users"
    $users = Get-MgUser -All -Filter "accountEnabled eq false" -Property "DisplayName,UserPrincipalName,Mail,UserType,CreatedDateTime" |
        Select-Object DisplayName, UserPrincipalName, Mail, UserType, CreatedDateTime
    Confirm-Export -Data $users -ReportName "DisabledUsers"
}

function Report-GuestUsers {
    Write-Section "Guest / External Users"
    $users = Get-MgUser -All -Filter "userType eq 'Guest'" -Property "DisplayName,UserPrincipalName,Mail,CreatedDateTime,ExternalUserState" |
        Select-Object DisplayName, UserPrincipalName, Mail, CreatedDateTime, ExternalUserState
    Confirm-Export -Data $users -ReportName "GuestUsers"
}

function Report-UsersWithoutMFA {
    Write-Section "Users Authentication Methods (MFA Check)"
    Write-Status "Gathering users and their registered auth methods..." "Info"

    $allUsers = Get-MgUser -All -Filter "accountEnabled eq true and userType eq 'Member'" -Property "Id,DisplayName,UserPrincipalName" |
        Select-Object Id, DisplayName, UserPrincipalName

    $results = @()
    $total = ($allUsers | Measure-Object).Count
    $i = 0

    foreach ($u in $allUsers) {
        $i++
        Write-Progress -Activity "Checking auth methods" -Status "$i of $total - $($u.DisplayName)" -PercentComplete (($i / $total) * 100)

        try {
            $methods = Get-MgUserAuthenticationMethod -UserId $u.Id -ErrorAction SilentlyContinue
            $methodTypes = $methods | ForEach-Object { $_.AdditionalProperties.'@odata.type' }

            $hasStrongMFA = $methodTypes | Where-Object {
                $_ -match "microsoftAuthenticator|fido2|phoneAuthentication|softwareOath|windowsHelloForBusiness"
            }

            $results += [PSCustomObject]@{
                DisplayName       = $u.DisplayName
                UserPrincipalName = $u.UserPrincipalName
                MethodCount       = ($methods | Measure-Object).Count
                HasStrongMFA      = [bool]$hasStrongMFA
                Methods           = ($methodTypes -replace '#microsoft.graph.', '' -join ', ')
            }
        }
        catch {
            $results += [PSCustomObject]@{
                DisplayName       = $u.DisplayName
                UserPrincipalName = $u.UserPrincipalName
                MethodCount       = "Error"
                HasStrongMFA      = "Error"
                Methods           = $_.Exception.Message
            }
        }
    }
    Write-Progress -Activity "Checking auth methods" -Completed

    Write-Status "Users WITHOUT strong MFA:" "Warning"
    $noMFA = $results | Where-Object { $_.HasStrongMFA -eq $false }
    Confirm-Export -Data $noMFA -ReportName "UsersWithoutMFA"

    $exportAll = Read-Host "  Also export ALL users with auth method details? (Y/N)"
    if ($exportAll -eq 'Y' -or $exportAll -eq 'y') {
        Confirm-Export -Data $results -ReportName "AllUsersAuthMethods"
    }
}

function Report-RecentlyCreatedUsers {
    Write-Section "Recently Created Users (Last 30 Days)"
    $cutoff = (Get-Date).AddDays(-30).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $users = Get-MgUser -All -Filter "createdDateTime ge $cutoff" -Property "DisplayName,UserPrincipalName,AccountEnabled,UserType,CreatedDateTime" |
        Select-Object DisplayName, UserPrincipalName, AccountEnabled, UserType, CreatedDateTime |
        Sort-Object CreatedDateTime -Descending
    Confirm-Export -Data $users -ReportName "RecentUsers"
}

function Report-AdminRoleAssignments {
    Write-Section "Admin Role Assignments"
    Write-Status "Gathering directory role assignments..." "Info"

    $roles = Get-MgDirectoryRole -All
    $results = @()

    foreach ($role in $roles) {
        $members = Get-MgDirectoryRoleMember -DirectoryRoleId $role.Id -All
        foreach ($member in $members) {
            $results += [PSCustomObject]@{
                RoleName          = $role.DisplayName
                RoleDescription   = $role.Description
                MemberName        = $member.AdditionalProperties.displayName
                MemberUPN         = $member.AdditionalProperties.userPrincipalName
                MemberType        = $member.AdditionalProperties.'@odata.type' -replace '#microsoft.graph.', ''
            }
        }
    }

    $results = $results | Sort-Object RoleName, MemberName
    Confirm-Export -Data $results -ReportName "AdminRoleAssignments"
}

function Report-StaleUsers {
    Write-Section "Stale Users (No Sign-in > 90 Days)"
    Write-Status "Checking sign-in activity (requires AuditLog.Read.All)..." "Info"

    try {
        $cutoff = (Get-Date).AddDays(-90).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $users = Get-MgUser -All -Property "DisplayName,UserPrincipalName,AccountEnabled,SignInActivity" -Filter "accountEnabled eq true" |
            Where-Object {
                $_.SignInActivity.LastSignInDateTime -and
                $_.SignInActivity.LastSignInDateTime -lt (Get-Date).AddDays(-90)
            } |
            Select-Object DisplayName, UserPrincipalName, AccountEnabled,
                @{N='LastSignIn'; E={$_.SignInActivity.LastSignInDateTime}},
                @{N='LastNonInteractiveSignIn'; E={$_.SignInActivity.LastNonInteractiveSignInDateTime}} |
            Sort-Object LastSignIn

        Confirm-Export -Data $users -ReportName "StaleUsers"
    }
    catch {
        Write-Status "Failed — may require Azure AD Premium license for sign-in data: $($_.Exception.Message)" "Error"
    }
}

# ── GROUP REPORTS ────────────────────────────────────────────────────────────

function Report-AllGroups {
    Write-Section "All Groups (Summary)"
    $groups = Get-MgGroup -All -Property "DisplayName,Mail,GroupTypes,SecurityEnabled,MailEnabled,MembershipRule,Description,CreatedDateTime" |
        Select-Object DisplayName, Mail,
            @{N='Type'; E={
                if ($_.GroupTypes -contains "Unified") { "Microsoft 365" }
                elseif ($_.SecurityEnabled -and $_.MailEnabled) { "Mail-Enabled Security" }
                elseif ($_.SecurityEnabled) { "Security" }
                elseif ($_.MailEnabled) { "Distribution" }
                else { "Other" }
            }},
            @{N='Dynamic'; E={ if ($_.GroupTypes -contains "DynamicMembership") { "Yes" } else { "No" } }},
            SecurityEnabled, MailEnabled, Description, CreatedDateTime

    Confirm-Export -Data $groups -ReportName "AllGroups"
}

function Report-SecurityGroups {
    Write-Section "Security Groups"
    $groups = Get-MgGroup -All -Filter "securityEnabled eq true and NOT groupTypes/any(g:g eq 'Unified')" -Property "DisplayName,Mail,Description,CreatedDateTime,MembershipRule" |
        Where-Object { -not $_.MailEnabled } |
        Select-Object DisplayName, Mail, Description, CreatedDateTime,
            @{N='Dynamic'; E={ if ($_.MembershipRule) { "Yes" } else { "No" } }}
    Confirm-Export -Data $groups -ReportName "SecurityGroups"
}

function Report-DistributionLists {
    Write-Section "Distribution Lists"
    $groups = Get-MgGroup -All -Filter "mailEnabled eq true and NOT securityEnabled" -Property "DisplayName,Mail,Description,CreatedDateTime" |
        Where-Object { $_.GroupTypes -notcontains "Unified" } |
        Select-Object DisplayName, Mail, Description, CreatedDateTime
    Confirm-Export -Data $groups -ReportName "DistributionLists"
}

function Report-M365Groups {
    Write-Section "Microsoft 365 Groups"
    $groups = Get-MgGroup -All -Filter "groupTypes/any(g:g eq 'Unified')" -Property "DisplayName,Mail,Visibility,Description,CreatedDateTime,ResourceProvisioningOptions" |
        Select-Object DisplayName, Mail, Visibility, Description, CreatedDateTime,
            @{N='HasTeam'; E={ if ($_.ResourceProvisioningOptions -contains "Team") { "Yes" } else { "No" } }}
    Confirm-Export -Data $groups -ReportName "M365Groups"
}

function Report-GroupMembers {
    Write-Section "Group Members"
    $search = Read-Host "  Enter group name (or partial name) to search"

    $groups = Get-MgGroup -Filter "startswith(displayName,'$search')" -Property "Id,DisplayName,Mail" -Top 20
    if (-not $groups) {
        $groups = Get-MgGroup -Search "displayName:$search" -ConsistencyLevel eventual -Property "Id,DisplayName,Mail" -Top 20
    }

    if (-not $groups -or ($groups | Measure-Object).Count -eq 0) {
        Write-Status "No groups found matching '$search'." "Error"
        return
    }

    Write-Host ""
    $groups | ForEach-Object { $i = 0 } { $i++; Write-Host "    $i. $($_.DisplayName) ($($_.Mail))" }
    $pick = Read-Host "  Select a group (number)"
    $selectedGroup = $groups[([int]$pick - 1)]

    Write-Status "Getting members of '$($selectedGroup.DisplayName)'..." "Info"
    $members = Get-MgGroupMember -GroupId $selectedGroup.Id -All |
        Select-Object @{N='DisplayName'; E={$_.AdditionalProperties.displayName}},
                       @{N='UPN'; E={$_.AdditionalProperties.userPrincipalName}},
                       @{N='Mail'; E={$_.AdditionalProperties.mail}},
                       @{N='Type'; E={$_.AdditionalProperties.'@odata.type' -replace '#microsoft.graph.', ''}}

    Confirm-Export -Data $members -ReportName "GroupMembers_$($selectedGroup.DisplayName -replace '\s','_')"
}

function Report-GroupOwners {
    Write-Section "Group Owners"
    $search = Read-Host "  Enter group name (or partial name) to search"

    $groups = Get-MgGroup -Filter "startswith(displayName,'$search')" -Property "Id,DisplayName,Mail" -Top 20
    if (-not $groups) {
        $groups = Get-MgGroup -Search "displayName:$search" -ConsistencyLevel eventual -Property "Id,DisplayName,Mail" -Top 20
    }

    if (-not $groups -or ($groups | Measure-Object).Count -eq 0) {
        Write-Status "No groups found matching '$search'." "Error"
        return
    }

    Write-Host ""
    $groups | ForEach-Object { $i = 0 } { $i++; Write-Host "    $i. $($_.DisplayName) ($($_.Mail))" }
    $pick = Read-Host "  Select a group (number)"
    $selectedGroup = $groups[([int]$pick - 1)]

    $owners = Get-MgGroupOwner -GroupId $selectedGroup.Id -All |
        Select-Object @{N='DisplayName'; E={$_.AdditionalProperties.displayName}},
                       @{N='UPN'; E={$_.AdditionalProperties.userPrincipalName}},
                       @{N='Mail'; E={$_.AdditionalProperties.mail}}

    Confirm-Export -Data $owners -ReportName "GroupOwners_$($selectedGroup.DisplayName -replace '\s','_')"
}

function Report-UserGroupMemberships {
    Write-Section "All Groups for a User"
    $upn = Read-Host "  Enter User Principal Name (UPN)"

    try {
        $user = Get-MgUser -UserId $upn -ErrorAction Stop
    }
    catch {
        Write-Status "User '$upn' not found." "Error"
        return
    }

    Write-Status "Getting group memberships for $($user.DisplayName)..." "Info"
    $groups = Get-MgUserMemberOf -UserId $user.Id -All |
        Where-Object { $_.AdditionalProperties.'@odata.type' -eq '#microsoft.graph.group' } |
        Select-Object @{N='GroupName'; E={$_.AdditionalProperties.displayName}},
                       @{N='Mail'; E={$_.AdditionalProperties.mail}},
                       @{N='SecurityEnabled'; E={$_.AdditionalProperties.securityEnabled}},
                       @{N='MailEnabled'; E={$_.AdditionalProperties.mailEnabled}},
                       @{N='GroupTypes'; E={($_.AdditionalProperties.groupTypes -join ', ')}}

    Confirm-Export -Data $groups -ReportName "UserGroups_$($upn -replace '@','_at_')"
}

function Report-EmptyGroups {
    Write-Section "Empty Groups (Zero Members)"
    Write-Status "Scanning all groups for membership count — this may take a while..." "Info"

    $allGroups = Get-MgGroup -All -Property "Id,DisplayName,Mail,GroupTypes,SecurityEnabled,MailEnabled"
    $emptyGroups = @()
    $total = ($allGroups | Measure-Object).Count
    $i = 0

    foreach ($grp in $allGroups) {
        $i++
        Write-Progress -Activity "Checking groups" -Status "$i of $total" -PercentComplete (($i / $total) * 100)
        $memberCount = (Get-MgGroupMember -GroupId $grp.Id -Top 1 | Measure-Object).Count
        if ($memberCount -eq 0) {
            $emptyGroups += [PSCustomObject]@{
                DisplayName = $grp.DisplayName
                Mail        = $grp.Mail
                Type        = if ($grp.GroupTypes -contains "Unified") { "M365" }
                              elseif ($grp.SecurityEnabled) { "Security" }
                              elseif ($grp.MailEnabled) { "Distribution" }
                              else { "Other" }
            }
        }
    }
    Write-Progress -Activity "Checking groups" -Completed
    Confirm-Export -Data $emptyGroups -ReportName "EmptyGroups"
}

function Report-DynamicGroups {
    Write-Section "Dynamic Membership Groups"
    $groups = Get-MgGroup -All -Filter "groupTypes/any(g:g eq 'DynamicMembership')" -Property "DisplayName,Mail,MembershipRule,MembershipRuleProcessingState,GroupTypes,SecurityEnabled" |
        Select-Object DisplayName, Mail, MembershipRule, MembershipRuleProcessingState,
            @{N='Type'; E={
                if ($_.GroupTypes -contains "Unified") { "M365 Dynamic" }
                elseif ($_.SecurityEnabled) { "Security Dynamic" }
                else { "Other Dynamic" }
            }}
    Confirm-Export -Data $groups -ReportName "DynamicGroups"
}

# ── LICENSE REPORTS ──────────────────────────────────────────────────────────

function Report-LicenseSummary {
    Write-Section "License Summary (SKU Usage)"
    $skus = Get-MgSubscribedSku -All |
        Select-Object @{N='License'; E={$_.SkuPartNumber}},
                       @{N='Total'; E={$_.PrepaidUnits.Enabled}},
                       @{N='Assigned'; E={$_.ConsumedUnits}},
                       @{N='Available'; E={$_.PrepaidUnits.Enabled - $_.ConsumedUnits}},
                       @{N='Suspended'; E={$_.PrepaidUnits.Suspended}},
                       @{N='Warning'; E={$_.PrepaidUnits.Warning}},
                       SkuId

    Confirm-Export -Data $skus -ReportName "LicenseSummary"
}

function Report-UsersByLicense {
    Write-Section "Users by License SKU"

    $skus = Get-MgSubscribedSku -All | Select-Object SkuPartNumber, SkuId
    Write-Host ""
    $skus | ForEach-Object { $i = 0 } { $i++; Write-Host "    $i. $($_.SkuPartNumber)" }
    $pick = Read-Host "  Select a license (number)"
    $selectedSku = $skus[([int]$pick - 1)]

    Write-Status "Finding users with license: $($selectedSku.SkuPartNumber)..." "Info"
    $users = Get-MgUser -All -Property "DisplayName,UserPrincipalName,AccountEnabled,AssignedLicenses" |
        Where-Object { $_.AssignedLicenses.SkuId -contains $selectedSku.SkuId } |
        Select-Object DisplayName, UserPrincipalName, AccountEnabled

    Confirm-Export -Data $users -ReportName "UsersWithLicense_$($selectedSku.SkuPartNumber)"
}

function Report-UnlicensedUsers {
    Write-Section "Unlicensed Users (Members Only)"
    $users = Get-MgUser -All -Filter "userType eq 'Member' and accountEnabled eq true" -Property "DisplayName,UserPrincipalName,AccountEnabled,AssignedLicenses" |
        Where-Object { ($_.AssignedLicenses | Measure-Object).Count -eq 0 } |
        Select-Object DisplayName, UserPrincipalName, AccountEnabled
    Confirm-Export -Data $users -ReportName "UnlicensedUsers"
}

# ── EXCHANGE / MAILBOX REPORTS ───────────────────────────────────────────────

function Report-SharedMailboxes {
    Write-Section "Shared Mailboxes"
    if (-not (Connect-M365Exchange)) { return }

    $mailboxes = Get-EXOMailbox -RecipientTypeDetails SharedMailbox -ResultSize Unlimited |
        Select-Object DisplayName, PrimarySmtpAddress, Alias, WhenCreated,
            @{N='IsMailboxEnabled'; E={$_.IsMailboxEnabled}}

    Confirm-Export -Data $mailboxes -ReportName "SharedMailboxes"
}

function Report-MailboxSizes {
    Write-Section "Mailbox Sizes (Top 50 by Size)"
    if (-not (Connect-M365Exchange)) { return }

    Write-Status "Gathering mailbox statistics — this may take a moment..." "Info"
    $stats = Get-EXOMailbox -ResultSize Unlimited | Get-EXOMailboxStatistics |
        Select-Object DisplayName,
            @{N='TotalItemSize'; E={$_.TotalItemSize.ToString()}},
            ItemCount,
            @{N='SizeBytes'; E={
                if ($_.TotalItemSize.Value) { $_.TotalItemSize.Value.ToBytes() } else { 0 }
            }} |
        Sort-Object SizeBytes -Descending |
        Select-Object -First 50 DisplayName, TotalItemSize, ItemCount

    Confirm-Export -Data $stats -ReportName "MailboxSizes"
}

function Report-MailForwardingRules {
    Write-Section "Mailbox Forwarding Rules"
    if (-not (Connect-M365Exchange)) { return }

    Write-Status "Scanning mailboxes for forwarding configurations..." "Info"
    $mailboxes = Get-EXOMailbox -ResultSize Unlimited -Property DisplayName, PrimarySmtpAddress, ForwardingAddress, ForwardingSmtpAddress, DeliverToMailboxAndForward

    $forwarding = $mailboxes | Where-Object { $_.ForwardingAddress -or $_.ForwardingSmtpAddress } |
        Select-Object DisplayName, PrimarySmtpAddress, ForwardingAddress, ForwardingSmtpAddress, DeliverToMailboxAndForward

    Confirm-Export -Data $forwarding -ReportName "MailForwarding"
}

function Report-InboxRulesAllUsers {
    Write-Section "Inbox Rules (Forwarding/Redirect) — Security Audit"
    if (-not (Connect-M365Exchange)) { return }

    Write-Status "Scanning inbox rules across all mailboxes for forwarding/redirecting..." "Warning"
    Write-Status "This can take a LONG time in large tenants." "Warning"

    $mailboxes = Get-EXOMailbox -ResultSize Unlimited -Property PrimarySmtpAddress
    $suspiciousRules = @()
    $total = ($mailboxes | Measure-Object).Count
    $i = 0

    foreach ($mbx in $mailboxes) {
        $i++
        Write-Progress -Activity "Scanning inbox rules" -Status "$i of $total - $($mbx.PrimarySmtpAddress)" -PercentComplete (($i / $total) * 100)

        try {
            $rules = Get-InboxRule -Mailbox $mbx.PrimarySmtpAddress -ErrorAction SilentlyContinue |
                Where-Object { $_.ForwardTo -or $_.ForwardAsAttachmentTo -or $_.RedirectTo }

            foreach ($rule in $rules) {
                $suspiciousRules += [PSCustomObject]@{
                    Mailbox                = $mbx.PrimarySmtpAddress
                    RuleName               = $rule.Name
                    Enabled                = $rule.Enabled
                    ForwardTo              = ($rule.ForwardTo -join '; ')
                    ForwardAsAttachment    = ($rule.ForwardAsAttachmentTo -join '; ')
                    RedirectTo             = ($rule.RedirectTo -join '; ')
                }
            }
        }
        catch { }
    }
    Write-Progress -Activity "Scanning inbox rules" -Completed
    Confirm-Export -Data $suspiciousRules -ReportName "SuspiciousInboxRules"
}

# ── SECURITY & COMPLIANCE REPORTS ────────────────────────────────────────────

function Report-ConditionalAccessPolicies {
    Write-Section "Conditional Access Policies"
    try {
        $policies = Get-MgIdentityConditionalAccessPolicy -All |
            Select-Object DisplayName, State, CreatedDateTime, ModifiedDateTime,
                @{N='IncludeUsers'; E={$_.Conditions.Users.IncludeUsers -join ', '}},
                @{N='IncludeGroups'; E={$_.Conditions.Users.IncludeGroups -join ', '}},
                @{N='IncludeApps'; E={$_.Conditions.Applications.IncludeApplications -join ', '}},
                @{N='GrantControls'; E={$_.GrantControls.BuiltInControls -join ', '}}

        Confirm-Export -Data $policies -ReportName "ConditionalAccessPolicies"
    }
    catch {
        Write-Status "Failed — requires Policy.Read.All permission or Azure AD Premium: $($_.Exception.Message)" "Error"
    }
}

function Report-SignInLogs {
    Write-Section "Recent Sign-In Activity (Last 7 Days)"
    try {
        $cutoff = (Get-Date).AddDays(-7).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $logs = Get-MgAuditLogSignIn -Filter "createdDateTime ge $cutoff" -Top 200 -Sort "createdDateTime desc" |
            Select-Object UserDisplayName, UserPrincipalName, AppDisplayName, IpAddress,
                @{N='Location'; E={"$($_.Location.City), $($_.Location.State), $($_.Location.CountryOrRegion)"}},
                @{N='Status'; E={if ($_.Status.ErrorCode -eq 0) { "Success" } else { "Failed ($($_.Status.ErrorCode))" }}},
                CreatedDateTime,
                @{N='ConditionalAccess'; E={$_.ConditionalAccessStatus}},
                @{N='MFARequired'; E={$_.MfaDetail.AuthMethod}}

        Confirm-Export -Data $logs -ReportName "SignInLogs"
    }
    catch {
        Write-Status "Failed — requires AuditLog.Read.All and Azure AD Premium: $($_.Exception.Message)" "Error"
    }
}

function Report-FailedSignIns {
    Write-Section "Failed Sign-Ins (Last 7 Days)"
    try {
        $cutoff = (Get-Date).AddDays(-7).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $logs = Get-MgAuditLogSignIn -Filter "createdDateTime ge $cutoff and status/errorCode ne 0" -Top 500 -Sort "createdDateTime desc" |
            Select-Object UserDisplayName, UserPrincipalName, AppDisplayName, IpAddress,
                @{N='Location'; E={"$($_.Location.City), $($_.Location.CountryOrRegion)"}},
                @{N='ErrorCode'; E={$_.Status.ErrorCode}},
                @{N='FailureReason'; E={$_.Status.FailureReason}},
                CreatedDateTime

        Confirm-Export -Data $logs -ReportName "FailedSignIns"
    }
    catch {
        Write-Status "Failed — requires AuditLog.Read.All and Azure AD Premium: $($_.Exception.Message)" "Error"
    }
}

# ── DOMAIN & ORG REPORTS ─────────────────────────────────────────────────────

function Report-TenantInfo {
    Write-Section "Tenant / Organization Information"
    $org = Get-MgOrganization
    $org | ForEach-Object {
        Write-Host ""
        Write-Host "  ┌─────────────────────────────────────────────────" -ForegroundColor DarkGray
        Write-Host "  │ Tenant Name       : $($_.DisplayName)" -ForegroundColor White
        Write-Host "  │ Tenant ID         : $($_.Id)" -ForegroundColor White
        Write-Host "  │ Verified Domains  : $(($_.VerifiedDomains | ForEach-Object { $_.Name }) -join ', ')" -ForegroundColor White
        Write-Host "  │ Default Domain    : $(($_.VerifiedDomains | Where-Object { $_.IsDefault } | Select-Object -ExpandProperty Name))" -ForegroundColor White
        Write-Host "  │ Country           : $($_.CountryLetterCode)" -ForegroundColor White
        Write-Host "  │ Tech Contact      : $(($_.TechnicalNotificationMails -join ', '))" -ForegroundColor White
        Write-Host "  │ Dir Sync Enabled  : $($_.OnPremisesSyncEnabled)" -ForegroundColor White
        Write-Host "  │ Created           : $($_.CreatedDateTime)" -ForegroundColor White
        Write-Host "  └─────────────────────────────────────────────────" -ForegroundColor DarkGray
    }
}

function Report-Domains {
    Write-Section "Verified Domains"
    $org = Get-MgOrganization
    $domains = $org.VerifiedDomains | Select-Object Name, Type, IsDefault, IsInitial
    Confirm-Export -Data $domains -ReportName "Domains"
}

function Report-ServicePlans {
    Write-Section "All Available Service Plans"
    $plans = Get-MgSubscribedSku -All | ForEach-Object {
        $skuName = $_.SkuPartNumber
        $_.ServicePlans | Select-Object @{N='License'; E={$skuName}}, ServicePlanName, ProvisioningStatus, AppliesTo
    }
    Confirm-Export -Data $plans -ReportName "ServicePlans"
}

# ── DEVICE REPORTS ───────────────────────────────────────────────────────────

function Report-RegisteredDevices {
    Write-Section "Azure AD Registered Devices"
    try {
        $devices = Get-MgDevice -All -Property "DisplayName,DeviceId,OperatingSystem,OperatingSystemVersion,TrustType,AccountEnabled,ApproximateLastSignInDateTime,RegisteredOwners" |
            Select-Object DisplayName, OperatingSystem, OperatingSystemVersion, TrustType, AccountEnabled, ApproximateLastSignInDateTime
        Confirm-Export -Data $devices -ReportName "RegisteredDevices"
    }
    catch {
        Write-Status "Failed: $($_.Exception.Message)" "Error"
    }
}

# ══════════════════════════════════════════════════════════════════════════════
#  MAIN MENU
# ══════════════════════════════════════════════════════════════════════════════

function Show-MainMenu {
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║                     MAIN MENU                               ║" -ForegroundColor Cyan
    Write-Host "  ╠══════════════════════════════════════════════════════════════╣" -ForegroundColor Cyan
    Write-Host "  ║                                                             ║" -ForegroundColor Cyan
    Write-Host "  ║  USER REPORTS                                               ║" -ForegroundColor Cyan
    Write-Host "  ║   1.  All Users                                             ║" -ForegroundColor White
    Write-Host "  ║   2.  User Details / All Settings                           ║" -ForegroundColor White
    Write-Host "  ║   3.  Disabled (Blocked) Users                              ║" -ForegroundColor White
    Write-Host "  ║   4.  Guest / External Users                                ║" -ForegroundColor White
    Write-Host "  ║   5.  Users Without Strong MFA                              ║" -ForegroundColor White
    Write-Host "  ║   6.  Recently Created Users (30 days)                      ║" -ForegroundColor White
    Write-Host "  ║   7.  Admin Role Assignments                                ║" -ForegroundColor White
    Write-Host "  ║   8.  Stale Users (No sign-in > 90 days)                    ║" -ForegroundColor White
    Write-Host "  ║                                                             ║" -ForegroundColor Cyan
    Write-Host "  ║  GROUP REPORTS                                              ║" -ForegroundColor Cyan
    Write-Host "  ║  10.  All Groups Summary                                    ║" -ForegroundColor White
    Write-Host "  ║  11.  Security Groups                                       ║" -ForegroundColor White
    Write-Host "  ║  12.  Distribution Lists                                    ║" -ForegroundColor White
    Write-Host "  ║  13.  Microsoft 365 Groups (+ Teams)                        ║" -ForegroundColor White
    Write-Host "  ║  14.  Group Members (search)                                ║" -ForegroundColor White
    Write-Host "  ║  15.  Group Owners (search)                                 ║" -ForegroundColor White
    Write-Host "  ║  16.  All Groups for a User                                 ║" -ForegroundColor White
    Write-Host "  ║  17.  Empty Groups (zero members)                           ║" -ForegroundColor White
    Write-Host "  ║  18.  Dynamic Membership Groups                             ║" -ForegroundColor White
    Write-Host "  ║                                                             ║" -ForegroundColor Cyan
    Write-Host "  ║  LICENSE REPORTS                                            ║" -ForegroundColor Cyan
    Write-Host "  ║  20.  License Summary (SKU Usage)                           ║" -ForegroundColor White
    Write-Host "  ║  21.  Users by License SKU                                  ║" -ForegroundColor White
    Write-Host "  ║  22.  Unlicensed Users                                      ║" -ForegroundColor White
    Write-Host "  ║  23.  All Service Plans                                     ║" -ForegroundColor White
    Write-Host "  ║                                                             ║" -ForegroundColor Cyan
    Write-Host "  ║  EXCHANGE / MAILBOX REPORTS                                 ║" -ForegroundColor Cyan
    Write-Host "  ║  30.  Shared Mailboxes                                      ║" -ForegroundColor White
    Write-Host "  ║  31.  Mailbox Sizes (Top 50)                                ║" -ForegroundColor White
    Write-Host "  ║  32.  Mail Forwarding Rules                                 ║" -ForegroundColor White
    Write-Host "  ║  33.  Inbox Rules Audit (Forward/Redirect)                  ║" -ForegroundColor White
    Write-Host "  ║                                                             ║" -ForegroundColor Cyan
    Write-Host "  ║  SECURITY & COMPLIANCE                                      ║" -ForegroundColor Cyan
    Write-Host "  ║  40.  Conditional Access Policies                           ║" -ForegroundColor White
    Write-Host "  ║  41.  Recent Sign-In Logs (7 days)                          ║" -ForegroundColor White
    Write-Host "  ║  42.  Failed Sign-Ins (7 days)                              ║" -ForegroundColor White
    Write-Host "  ║                                                             ║" -ForegroundColor Cyan
    Write-Host "  ║  TENANT & ORGANIZATION                                      ║" -ForegroundColor Cyan
    Write-Host "  ║  50.  Tenant Information                                    ║" -ForegroundColor White
    Write-Host "  ║  51.  Verified Domains                                      ║" -ForegroundColor White
    Write-Host "  ║  52.  Registered Devices                                    ║" -ForegroundColor White
    Write-Host "  ║                                                             ║" -ForegroundColor Cyan
    Write-Host "  ║   0.  EXIT                                                  ║" -ForegroundColor DarkGray
    Write-Host "  ║                                                             ║" -ForegroundColor Cyan
    Write-Host "  ╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Invoke-Report ([int]$Choice) {
    switch ($Choice) {
        1  { Report-AllUsers }
        2  { Report-UserDetails }
        3  { Report-DisabledUsers }
        4  { Report-GuestUsers }
        5  { Report-UsersWithoutMFA }
        6  { Report-RecentlyCreatedUsers }
        7  { Report-AdminRoleAssignments }
        8  { Report-StaleUsers }
        10 { Report-AllGroups }
        11 { Report-SecurityGroups }
        12 { Report-DistributionLists }
        13 { Report-M365Groups }
        14 { Report-GroupMembers }
        15 { Report-GroupOwners }
        16 { Report-UserGroupMemberships }
        17 { Report-EmptyGroups }
        18 { Report-DynamicGroups }
        20 { Report-LicenseSummary }
        21 { Report-UsersByLicense }
        22 { Report-UnlicensedUsers }
        23 { Report-ServicePlans }
        30 { Report-SharedMailboxes }
        31 { Report-MailboxSizes }
        32 { Report-MailForwardingRules }
        33 { Report-InboxRulesAllUsers }
        40 { Report-ConditionalAccessPolicies }
        41 { Report-SignInLogs }
        42 { Report-FailedSignIns }
        50 { Report-TenantInfo }
        51 { Report-Domains }
        52 { Report-RegisteredDevices }
        default { Write-Status "Invalid selection." "Warning" }
    }
}

# ── ENTRY POINT ──────────────────────────────────────────────────────────────
function Start-M365Reports {
    Clear-Host
    Write-Banner

    if (-not (Test-Prerequisites)) {
        Write-Host ""
        Write-Status "Please install required modules and try again." "Error"
        return
    }

    if (-not (Connect-M365Graph)) {
        Write-Host ""
        Write-Status "Cannot proceed without Microsoft Graph connection." "Error"
        return
    }

    while ($true) {
        Show-MainMenu
        $choice = Read-Host "  Enter report number"

        if ($choice -eq '0' -or $choice -eq 'q' -or $choice -eq 'exit') {
            Write-Host ""
            Write-Status "Disconnecting..." "Info"
            try { Disconnect-MgGraph -ErrorAction SilentlyContinue } catch { }
            try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue } catch { }
            Write-Status "Goodbye!" "Success"
            Write-Host ""
            break
        }

        try {
            Invoke-Report -Choice ([int]$choice)
        }
        catch {
            Write-Status "Error running report: $($_.Exception.Message)" "Error"
        }

        Write-Host ""
        Read-Host "  Press Enter to return to menu"
    }
}

# Auto-run when script is executed directly
Start-M365Reports
