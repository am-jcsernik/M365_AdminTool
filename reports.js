/*
 * reports.js — Server-owned report catalog
 *
 * The single source of truth for every report the tool can run.
 * The frontend fetches this via GET /api/reports for display, but command
 * construction and execution happen ONLY here on the server. The client
 * sends { reportId, params, fields } — never raw PowerShell.
 *
 * Report entry shape:
 *   id       unique report id (client references this)
 *   name     display name
 *   desc     short description
 *   ex       true if the report requires an Exchange Online connection
 *   command  static PowerShell command (mutually exclusive with baseCmd)
 *   baseCmd  command template with __FIELDS__ placeholder
 *   fields   selectable fields (whitelist for baseCmd substitution)
 *   params   user parameters, substituted into <Key> placeholders
 *   tags     search keywords
 *
 * SECURITY: fields are validated against the whitelist; params are
 * stripped of PowerShell metacharacters. See buildCommand() below.
 */

const REPORTS=[
{category:"User Reports",icon:"\u{1F464}",color:"#3b82f6",items:[
  {id:"all-users",name:"All Users",desc:"Every user with key properties",ex:false,fields:["DisplayName","UserPrincipalName","Mail","AccountEnabled","UserType","Department","JobTitle","City","Country","CreatedDateTime"],baseCmd:`Get-MgUser -All -Property "__FIELDS__"|Select-Object __FIELDS__`,tags:["users"]},
  {id:"user-details",name:"User Details",desc:"Full property dump for one user",ex:false,fields:["DisplayName","UserPrincipalName","Mail","AccountEnabled","UserType","CreatedDateTime","LastPasswordChangeDateTime","Department","JobTitle","CompanyName","City","State","Country","MobilePhone","BusinessPhones","OfficeLocation","EmployeeId","EmployeeType","OnPremisesSyncEnabled","ProxyAddresses","AssignedLicenses"],baseCmd:`Get-MgUser -UserId "<UPN>" -Property "__FIELDS__"|Select-Object __FIELDS__`,tags:["details"],params:[{key:"UPN",label:"User",picker:"users"}]},
  {id:"disabled-users",name:"Disabled Users",desc:"Accounts with sign-in blocked",ex:false,fields:["DisplayName","UserPrincipalName","Mail","UserType","CreatedDateTime"],baseCmd:`Get-MgUser -All -Filter "accountEnabled eq false" -Property "__FIELDS__"|Select-Object __FIELDS__`,tags:["disabled"]},
  {id:"guest-users",name:"Guest / External",desc:"B2B guest accounts",ex:false,fields:["DisplayName","UserPrincipalName","Mail","CreatedDateTime","ExternalUserState"],baseCmd:`Get-MgUser -All -Filter "userType eq 'Guest'" -Property "__FIELDS__"|Select-Object __FIELDS__`,tags:["guest"]},
  {id:"recent-users",name:"Recently Created (30d)",desc:"New accounts last month",ex:false,fields:["DisplayName","UserPrincipalName","AccountEnabled","UserType","CreatedDateTime"],baseCmd:`$cutoff=(Get-Date).AddDays(-30).ToString("yyyy-MM-ddTHH:mm:ssZ")\nGet-MgUser -All -Filter "createdDateTime ge $cutoff" -Property "__FIELDS__"|Sort-Object CreatedDateTime -Descending|Select-Object __FIELDS__`,tags:["new"]},
  {id:"admin-roles",name:"Admin Role Assignments",desc:"Who holds which admin roles",ex:false,command:`$roles=Get-MgDirectoryRole -All\n$(foreach($role in $roles){Get-MgDirectoryRoleMember -DirectoryRoleId $role.Id -All|ForEach-Object{[PSCustomObject]@{Role=$role.DisplayName;Member=$_.AdditionalProperties.displayName;UPN=$_.AdditionalProperties.userPrincipalName;Type=($_.AdditionalProperties.'@odata.type' -replace '#microsoft.graph.','')}}})|Sort-Object Role,Member`,tags:["admin"]},
  {id:"stale-users",name:"Stale Users (90+ Days)",desc:"No sign-in 90+ days",ex:false,command:`Get-MgUser -All -Property "DisplayName,UserPrincipalName,AccountEnabled,SignInActivity" -Filter "accountEnabled eq true"|Where-Object{$_.SignInActivity.LastSignInDateTime -and $_.SignInActivity.LastSignInDateTime -lt (Get-Date).AddDays(-90)}|Select-Object DisplayName,UserPrincipalName,@{N='LastSignIn';E={$_.SignInActivity.LastSignInDateTime}}|Sort-Object LastSignIn`,tags:["stale"]},
  {id:"unlicensed-users",name:"Unlicensed Users",desc:"Enabled members with zero licenses",ex:false,command:`Get-MgUser -All -Filter "userType eq 'Member' and accountEnabled eq true" -Property "DisplayName,UserPrincipalName,AssignedLicenses"|Where-Object{($_.AssignedLicenses|Measure-Object).Count -eq 0}|Select-Object DisplayName,UserPrincipalName`,tags:["unlicensed"]},
  {id:"user-groups",name:"Groups for a User",desc:"Every group a user belongs to",ex:false,command:`$user=Get-MgUser -UserId "<UPN>"\nGet-MgUserMemberOf -UserId $user.Id -All|Where-Object{$_.AdditionalProperties.'@odata.type' -eq '#microsoft.graph.group'}|Select-Object @{N='Group';E={$_.AdditionalProperties.displayName}},@{N='Mail';E={$_.AdditionalProperties.mail}},@{N='Security';E={$_.AdditionalProperties.securityEnabled}},@{N='Types';E={$_.AdditionalProperties.groupTypes -join ', '}}`,tags:["membership"],params:[{key:"UPN",label:"User",picker:"users"}]},
]},
{category:"Group Reports",icon:"\u{1F465}",color:"#8b5cf6",items:[
  {id:"all-groups",name:"All Groups Summary",desc:"Every group with type",ex:false,command:`Get-MgGroup -All -Property "DisplayName,Mail,GroupTypes,SecurityEnabled,MailEnabled,Description,CreatedDateTime"|Select-Object DisplayName,Mail,@{N='Type';E={if($_.GroupTypes -contains 'Unified'){'Microsoft 365'}elseif($_.SecurityEnabled -and $_.MailEnabled){'Mail-Enabled Security'}elseif($_.SecurityEnabled){'Security'}elseif($_.MailEnabled){'Distribution'}else{'Other'}}},@{N='Dynamic';E={if($_.GroupTypes -contains 'DynamicMembership'){'Yes'}else{'No'}}},Description,CreatedDateTime`,tags:["groups"]},
  {id:"security-groups",name:"Security Groups",desc:"Pure security groups",ex:false,command:`Get-MgGroup -All -Filter "securityEnabled eq true" -Property "DisplayName,Mail,MailEnabled,GroupTypes,Description,CreatedDateTime,MembershipRule"|Where-Object{-not $_.MailEnabled -and $_.GroupTypes -notcontains 'Unified'}|Select-Object DisplayName,Description,CreatedDateTime,@{N='Dynamic';E={if($_.MembershipRule){'Yes'}else{'No'}}}`,tags:["security"]},
  {id:"distribution-lists",name:"Distribution Lists",desc:"Mail-enabled distribution groups",ex:false,command:`Get-MgGroup -All -Filter "mailEnabled eq true" -Property "DisplayName,Mail,SecurityEnabled,GroupTypes,Description,CreatedDateTime"|Where-Object{-not $_.SecurityEnabled -and $_.GroupTypes -notcontains 'Unified'}|Select-Object DisplayName,Mail,Description,CreatedDateTime`,tags:["DL"]},
  {id:"dl-members",name:"Distribution List Members",desc:"All members of a distribution list, expanded via Exchange (handles classic DLs, nested groups, and mail contacts). Resolves the list by SMTP/alias/name and falls back to display name, so lists whose display name differs from their Exchange name still work.",ex:true,command:`$id='<DL>'
$grp=$null
try{$grp=Get-DistributionGroup -Identity $id -ErrorAction Stop}catch{}
if(-not $grp){try{$grp=@(Get-DistributionGroup -Filter "DisplayName -eq '$id'" -ErrorAction Stop)|Select-Object -First 1}catch{}}
if(-not $grp){[PSCustomObject]@{Result='ERROR';Error="Distribution list '$id' could not be resolved.";Hint='Not found by SMTP/alias/name or display name. Dynamic distribution groups and mail-enabled security groups are not classic DLs and cannot be expanded here.'};return}
try{$members=@(Get-DistributionGroupMember -Identity $grp.Guid.ToString() -ResultSize Unlimited -ErrorAction Stop)}catch{[PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='Resolved the list but could not expand its members. If this is a dynamic distribution group it needs Get-DynamicDistributionGroupMember instead.'};return}
if($members.Count -eq 0){[PSCustomObject]@{Result='No members';DL=$grp.DisplayName;PrimarySmtpAddress=$grp.PrimarySmtpAddress};return}
$members|Select-Object DisplayName,PrimarySmtpAddress,Alias,RecipientType,@{N='Details';E={$_.RecipientTypeDetails}}`,tags:["DL","members","distribution"],params:[{key:"DL",label:"Distribution list",picker:"distlists"}]},
  {id:"m365-groups",name:"Microsoft 365 Groups",desc:"Unified groups \u2014 flags Teams",ex:false,command:`Get-MgGroup -All -Filter "groupTypes/any(g:g eq 'Unified')" -Property "DisplayName,Mail,Visibility,Description,CreatedDateTime,ResourceProvisioningOptions"|Select-Object DisplayName,Mail,Visibility,Description,CreatedDateTime,@{N='HasTeam';E={if($_.ResourceProvisioningOptions -contains 'Team'){'Yes'}else{'No'}}}`,tags:["M365"]},
  {id:"group-members",name:"Group Members",desc:"All members of a group",ex:false,command:`$group=Get-MgGroup -Filter "displayName eq '<GroupName>'" -Top 1\nGet-MgGroupMember -GroupId $group.Id -All|Select-Object @{N='Name';E={$_.AdditionalProperties.displayName}},@{N='UPN';E={$_.AdditionalProperties.userPrincipalName}},@{N='Mail';E={$_.AdditionalProperties.mail}},@{N='Type';E={$_.AdditionalProperties.'@odata.type' -replace '#microsoft.graph.',''}}`,tags:["members"],params:[{key:"GroupName",label:"Group",picker:"groups"}]},
  {id:"group-owners",name:"Group Owners",desc:"Who owns a group",ex:false,command:`$group=Get-MgGroup -Filter "displayName eq '<GroupName>'" -Top 1\nGet-MgGroupOwner -GroupId $group.Id -All|Select-Object @{N='Name';E={$_.AdditionalProperties.displayName}},@{N='UPN';E={$_.AdditionalProperties.userPrincipalName}}`,tags:["owners"],params:[{key:"GroupName",label:"Group",picker:"groups"}]},
  {id:"empty-groups",name:"Empty Groups",desc:"Zero members (slow)",ex:false,command:`$allGroups=Get-MgGroup -All -Property "Id,DisplayName,Mail,GroupTypes,SecurityEnabled,MailEnabled"\nforeach($g in $allGroups){if((Get-MgGroupMember -GroupId $g.Id -Top 1|Measure-Object).Count -eq 0){[PSCustomObject]@{Name=$g.DisplayName;Mail=$g.Mail;Type=if($g.GroupTypes -contains 'Unified'){'M365'}elseif($g.SecurityEnabled){'Security'}else{'Distribution'}}}}`,tags:["empty"]},
  {id:"dynamic-groups",name:"Dynamic Groups",desc:"Dynamic membership rules",ex:false,command:`Get-MgGroup -All -Filter "groupTypes/any(g:g eq 'DynamicMembership')" -Property "DisplayName,Mail,MembershipRule,MembershipRuleProcessingState,GroupTypes,SecurityEnabled"|Select-Object DisplayName,Mail,MembershipRule,MembershipRuleProcessingState,@{N='Type';E={if($_.GroupTypes -contains 'Unified'){'M365 Dynamic'}elseif($_.SecurityEnabled){'Security Dynamic'}else{'Other'}}}`,tags:["dynamic"]},
]},
{category:"Licenses",icon:"\u{1F511}",color:"#f59e0b",items:[
  {id:"license-summary",name:"License Summary",desc:"SKU usage",ex:false,command:`Get-MgSubscribedSku -All|Select-Object @{N='License';E={$_.SkuPartNumber}},@{N='Total';E={$_.PrepaidUnits.Enabled}},@{N='Assigned';E={$_.ConsumedUnits}},@{N='Available';E={$_.PrepaidUnits.Enabled-$_.ConsumedUnits}},@{N='Suspended';E={$_.PrepaidUnits.Suspended}},SkuId`,tags:["SKU"]},
  {id:"service-plans",name:"Service Plans",desc:"Every service plan",ex:false,command:`Get-MgSubscribedSku -All|ForEach-Object{$sku=$_.SkuPartNumber;$_.ServicePlans|Select-Object @{N='License';E={$sku}},ServicePlanName,ProvisioningStatus,AppliesTo}`,tags:["plans"]},
  {id:"user-licenses",name:"Licenses for a User",desc:"Every license (SKU) assigned to one user, with the count of enabled service plans",ex:false,command:`Get-MgUserLicenseDetail -UserId "<UPN>"|Select-Object @{N='License';E={$_.SkuPartNumber}},SkuId,@{N='EnabledPlans';E={($_.ServicePlans|Where-Object{$_.ProvisioningStatus -eq 'Success'}|ForEach-Object{$_.ServicePlanName}) -join ', '}},@{N='PlanCount';E={($_.ServicePlans|Measure-Object).Count}}`,tags:["license","user","assigned"],params:[{key:"UPN",label:"User",picker:"users"}]},
]},
{category:"Exchange / Mailbox",icon:"\u{1F4E7}",color:"#ef4444",items:[
  {id:"shared-mailboxes",name:"Shared Mailboxes",desc:"All shared mailboxes",ex:true,command:`Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{RecipientTypeDetails='SharedMailbox';ResultSize='Unlimited'}|Select-Object DisplayName,PrimarySmtpAddress,Alias,WhenCreated`,tags:["shared"]},
  {id:"mail-forwarding",name:"Mailbox Forwarding",desc:"Server-side forwarding configured",ex:true,command:`Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{ResultSize='Unlimited'}|Where-Object{$_.ForwardingAddress -or $_.ForwardingSmtpAddress}|Select-Object DisplayName,PrimarySmtpAddress,ForwardingAddress,ForwardingSmtpAddress,DeliverToMailboxAndForward`,tags:["forwarding"]},
  {id:"user-inbox-rules",name:"User Inbox Rules",desc:"All inbox rules for a user (forwarding, redirect, delete)",ex:true,command:`Get-InboxRule -Mailbox "<UPN>"|Select-Object Name,Enabled,Priority,@{N='ForwardTo';E={$_.ForwardTo -join '; '}},@{N='RedirectTo';E={$_.RedirectTo -join '; '}},@{N='ForwardAsAttach';E={$_.ForwardAsAttachmentTo -join '; '}},DeleteMessage,MoveToFolder`,tags:["inbox","rules"],params:[{key:"UPN",label:"User",picker:"users"}]},
  {id:"all-forwarding-rules",name:"All Forwarding Rules (Tenant)",desc:"Scan all mailboxes for forward/redirect rules \u2014 SLOW",ex:true,command:`$mbxs=Get-EXOMailbox -ResultSize Unlimited -Property PrimarySmtpAddress\nforeach($m in $mbxs){Get-InboxRule -Mailbox $m.PrimarySmtpAddress -EA SilentlyContinue|Where-Object{$_.ForwardTo -or $_.ForwardAsAttachmentTo -or $_.RedirectTo}|ForEach-Object{[PSCustomObject]@{Mailbox=$m.PrimarySmtpAddress;Rule=$_.Name;Enabled=$_.Enabled;ForwardTo=($_.ForwardTo -join '; ');Redirect=($_.RedirectTo -join '; ')}}}`,tags:["forwarding","audit"]},
  {id:"mailbox-permissions",name:"Mailbox Permissions",desc:"Full access and send-as delegates",ex:true,command:`$mbx="<UPN>"\n$fa=Get-EXOMailboxPermission -Identity $mbx|Where-Object{$_.User -ne 'NT AUTHORITY\\SELF' -and $_.IsInherited -eq $false}|Select-Object @{N='Mailbox';E={$mbx}},User,@{N='Rights';E={$_.AccessRights -join ', '}},@{N='Type';E={'FullAccess'}}\n$sa=Get-EXORecipientPermission -Identity $mbx|Where-Object{$_.Trustee -ne 'NT AUTHORITY\\SELF'}|Select-Object @{N='Mailbox';E={$mbx}},@{N='User';E={$_.Trustee}},@{N='Rights';E={'SendAs'}},@{N='Type';E={'SendAs'}}\n@($fa)+@($sa)|Where-Object{$_}`,tags:["permissions"],params:[{key:"UPN",label:"Mailbox",picker:"users"}]},
  {id:"mailbox-sizes",name:"Mailbox Sizes (Top 50)",desc:"Largest mailboxes",ex:true,command:`$mbx=Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{ResultSize='Unlimited'}
$rows=foreach($m in $mbx){
  $st=@(Invoke-ExoRest -Cmdlet Get-MailboxStatistics -Parameters @{Identity=$m.PrimarySmtpAddress})
  if($st.Count){
    $sz=$st[0].TotalItemSize
    $bytes=0;if($sz -and ($sz -match '\\(([\\d,]+) bytes\\)')){$bytes=[int64]($Matches[1] -replace ',','')}
    [PSCustomObject]@{DisplayName=$m.DisplayName;TotalSize=$sz;ItemCount=$st[0].ItemCount;__Bytes=$bytes}
  }
}
$rows|Sort-Object __Bytes -Descending|Select-Object -First 50 DisplayName,TotalSize,ItemCount`,tags:["size"]},
  {id:"user-mailbox",name:"Mailbox Report (User)",desc:"Type, size, quotas, archive, litigation hold and forwarding for one mailbox",ex:true,command:`$u="<UPN>"
$mbx=@(Invoke-ExoRest -Cmdlet Get-Mailbox -Parameters @{Identity=$u})|Select-Object -First 1
if(-not $mbx){[PSCustomObject]@{Result='ERROR';Error="Mailbox '$u' not found."};return}
$st=@(Invoke-ExoRest -Cmdlet Get-MailboxStatistics -Parameters @{Identity=$u})|Select-Object -First 1
[PSCustomObject]@{DisplayName=$mbx.DisplayName;PrimarySmtp=$mbx.PrimarySmtpAddress;Type=$mbx.RecipientTypeDetails;TotalSize=$(if($st -and $st.TotalItemSize){$st.TotalItemSize}else{'0'});Items=$(if($st){$st.ItemCount}else{0});ArchiveStatus=$mbx.ArchiveStatus;LitigationHold=$mbx.LitigationHoldEnabled;ForwardingSmtp=$mbx.ForwardingSmtpAddress;ForwardingAddress=$mbx.ForwardingAddress;WarningQuota=$mbx.IssueWarningQuota;SendQuota=$mbx.ProhibitSendQuota;Created=$mbx.WhenCreated;LastLogon=$(if($st){$st.LastLogonTime}else{$null})}`,tags:["mailbox","user","size","quota"],params:[{key:"UPN",label:"Mailbox",picker:"users"}]},
  {id:"message-trace",name:"Message Trace",desc:"Trace mail flow over the last ~10 days. Uses Get-MessageTraceV2 when available (falls back to legacy Get-MessageTrace). Filter by sender, recipient, date window and delivery status. Live trace only \u2014 up to 5000 rows and a 10-day window per query; older data needs historical search (planned follow-up).",ex:true,command:`# Message Trace (live). Prefers Get-MessageTraceV2 (EXO module 3.7.0+); falls back to Get-MessageTrace.
# All filters optional. Window defaults to the last 48h (Microsoft's own default) and is capped at 10 days per query.
$sndr='<Sender>'
$rcpt='<Recipient>'
$startRaw='<Start>'
$endRaw='<End>'
$status='<Status>'
try{$end=if($endRaw){[datetime]$endRaw}else{Get-Date}}catch{[PSCustomObject]@{Result='ERROR';Error="Could not parse End '$endRaw' \u2014 use e.g. 2026-07-01 or 2026-07-01T14:30."};return}
try{$start=if($startRaw){[datetime]$startRaw}else{$end.AddDays(-2)}}catch{[PSCustomObject]@{Result='ERROR';Error="Could not parse Start '$startRaw' \u2014 use e.g. 2026-07-01 or 2026-07-01T14:30."};return}
if($start -gt $end){[PSCustomObject]@{Result='ERROR';Error='Start date is after End date.'};return}
if(($end-$start).TotalDays -gt 10){[PSCustomObject]@{Result='ERROR';Error='Message trace allows at most a 10-day window per query. Narrow the date range (historical search beyond 10 days is a planned follow-up).'};return}
$filters=@{StartDate=$start;EndDate=$end}
if($sndr){$filters['SenderAddress']=$sndr}
if($rcpt){$filters['RecipientAddress']=$rcpt}
if($status){$filters['Status']=$status}
$useV2=[bool](Get-Command Get-MessageTraceV2 -ErrorAction SilentlyContinue)
try{if($useV2){$rows=Get-MessageTraceV2 @filters -ResultSize 5000 -ErrorAction Stop}else{$rows=Get-MessageTrace @filters -PageSize 5000 -Page 1 -ErrorAction Stop}}catch{[PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='Message trace runs over the Exchange connection \u2014 make sure Exchange is connected. The live trace covers the last ~10 days (Get-MessageTrace) or up to 90 days in 10-day windows (Get-MessageTraceV2). Older data needs Start-HistoricalSearch (planned follow-up).'};return}
$rows=@($rows)
if($rows.Count -eq 0){[PSCustomObject]@{Result='No messages matched';Cmdlet=$(if($useV2){'Get-MessageTraceV2'}else{'Get-MessageTrace'});Window="$($start.ToString('yyyy-MM-dd HH:mm')) to $($end.ToString('yyyy-MM-dd HH:mm'))";Hint='Widen the window or relax the sender/recipient/status filters. Very recent mail can take a few minutes to appear in the trace.'};return}
$out=$rows|Select-Object @{N='Received';E={$_.Received}},@{N='Sender';E={$_.SenderAddress}},@{N='Recipient';E={$_.RecipientAddress}},@{N='Subject';E={$_.Subject}},@{N='Status';E={$_.Status}},@{N='FromIP';E={$_.FromIP}},@{N='ToIP';E={$_.ToIP}},@{N='SizeKB';E={if($_.Size){[math]::Round([long]$_.Size/1KB,1)}else{$null}}},@{N='MessageId';E={$_.MessageId}},@{N='MessageTraceId';E={$_.MessageTraceId}}
$out
if($rows.Count -ge 5000){[PSCustomObject]@{Received='';Sender='(results capped at 5000 rows)';Recipient='Narrow the date window or add a sender/recipient filter to retrieve the rest.';Subject='';Status='';FromIP='';ToIP='';SizeKB='';MessageId='';MessageTraceId=''}}`,tags:["message","trace","mailflow","email","delivery","messagetrace","messagetracev2"],params:[
    {key:"Sender",label:"Sender address (optional)",placeholder:"someone@contoso.com",optional:true},
    {key:"Recipient",label:"Recipient address (optional)",placeholder:"someone@contoso.com",optional:true},
    {key:"Start",label:"Start (optional \u2014 defaults to 48h ago)",type:"datetime",optional:true},
    {key:"End",label:"End (optional \u2014 defaults to now)",type:"datetime",optional:true},
    {key:"Status",label:"Delivery status (optional)",type:"select",optional:true,options:[{value:"",label:"Any status"},{value:"Delivered",label:"Delivered"},{value:"Failed",label:"Failed"},{value:"Pending",label:"Pending"},{value:"FilteredAsSpam",label:"Filtered as spam"},{value:"Quarantined",label:"Quarantined"},{value:"Expanded",label:"Expanded (to a DL)"},{value:"GettingStatus",label:"Getting status"}]}
  ]},
  {id:"message-trace-detail",name:"Message Trace Detail",desc:"Per-hop delivery events (RECEIVE, SEND, DELIVER, FAIL, etc.) for a single message. Click a row in Message Trace to drill in, or paste a Message-Trace-ID and recipient here directly. Uses Get-MessageTraceDetailV2 when available, else Get-MessageTraceDetail.",ex:true,command:`$mtid='<MessageTraceId>'
$rcpt='<RecipientAddress>'
if(-not $mtid){[PSCustomObject]@{Result='ERROR';Error='MessageTraceId is required (get it from a Message Trace row).'};return}
$useV2=[bool](Get-Command Get-MessageTraceDetailV2 -ErrorAction SilentlyContinue)
try{if($useV2){$rows=Get-MessageTraceDetailV2 -MessageTraceId $mtid -RecipientAddress $rcpt -ErrorAction Stop}else{$rows=Get-MessageTraceDetail -MessageTraceId $mtid -RecipientAddress $rcpt -ErrorAction Stop}}catch{[PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='Needs the Exchange connection plus a valid MessageTraceId and RecipientAddress from a Message Trace row. Detail covers the same ~10-day live window.'};return}
$rows=@($rows)
if($rows.Count -eq 0){[PSCustomObject]@{Result='No detail events';MessageTraceId=$mtid;Recipient=$rcpt;Hint='No per-hop events were returned for this message and recipient.'};return}
$rows|Select-Object @{N='Date';E={$_.Date}},@{N='Event';E={$_.Event}},@{N='Action';E={$_.Action}},@{N='Detail';E={$_.Detail}},@{N='Data';E={$_.Data}}`,tags:["message","trace","detail","hops","delivery","messagetracedetail"],params:[
    {key:"MessageTraceId",label:"Message-Trace-ID",placeholder:"paste from a Message Trace row"},
    {key:"RecipientAddress",label:"Recipient address (optional)",placeholder:"recipient@contoso.com",optional:true}
  ]},
]},
{category:"SharePoint / OneDrive",icon:"\u{1F4C1}",color:"#0ea5e9",items:[
  {id:"sp-sites",name:"All SharePoint Sites",desc:"All site collections via Microsoft Search (delegated)",ex:false,command:`$body = @{requests=@(@{entityTypes=@('site');query=@{queryString='*'};from=0;size=500})} | ConvertTo-Json -Depth 6
$spErr = $null; $resp = $null
foreach ($attempt in 1..2) {
  try { $resp = Invoke-MgGraphRequest -Method POST -Uri 'https://graph.microsoft.com/v1.0/search/query' -Body $body -ContentType 'application/json' -ErrorAction Stop; $spErr = $null; break }
  catch { $spErr = $_.Exception.Message; Start-Sleep -Milliseconds 800 }
}
if ($spErr) {
  $ctx = Get-MgContext
  [PSCustomObject]@{Result='ERROR';Account=$ctx.Account;HasSitesScope=($ctx.Scopes -contains 'Sites.Read.All');Error=$spErr;Hint='InternalServerError is usually a transient Microsoft Search API fault; retrying failed too. Persistent Forbidden means Sites.Read.All needs admin consent.'}
} else {
  $hits = @($resp.value[0].hitsContainers[0].hits)
  if (-not $hits -or $hits.Count -eq 0) {
    $ctx = Get-MgContext
    [PSCustomObject]@{Result='No sites returned';Account=$ctx.Account;HasSitesScope=($ctx.Scopes -contains 'Sites.Read.All');Hint='If HasSitesScope is False, disconnect/reconnect; if still False, Sites.Read.All needs admin consent.'}
  } else {
    $more = $resp.value[0].hitsContainers[0].moreResultsAvailable
    $rows = $hits | ForEach-Object { $r = $_.resource; [PSCustomObject]@{DisplayName=$r.displayName;WebUrl=$r.webUrl;Description=$r.description;LastModified=$r.lastModifiedDateTime} }
    if ($more) { $rows += [PSCustomObject]@{DisplayName='(more than 500 sites — results truncated)';WebUrl='';Description='';LastModified=''} }
    $rows
  }
}`,tags:["sharepoint"]},
  {id:"sp-site-search",name:"SharePoint Site Search",desc:"Search sites by keyword",ex:false,command:`Import-Module Microsoft.Graph.Sites -EA SilentlyContinue\n$spErr=$null;$resp=$null\ntry { $resp = Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/sites?search=<SiteName>' -ErrorAction Stop } catch { $spErr=$_.Exception.Message }\nif ($spErr) {\n  [PSCustomObject]@{Result='ERROR';Error=$spErr}\n} else {\n  $resp.value | ForEach-Object { [PSCustomObject]@{DisplayName=$_.displayName;WebUrl=$_.webUrl;Id=$_.id;Description=$_.description;Created=$_.createdDateTime;LastModified=$_.lastModifiedDateTime} }\n}`,tags:["sharepoint"],params:[{key:"SiteName",label:"Site name to search",placeholder:"Marketing"}]},
  {id:"od-usage",name:"OneDrive Usage",desc:"Storage per user \u2014 requires Reports.Read.All admin consent. Blank names would indicate the tenant report-privacy setting (see TROUBLESHOOTING.md)",ex:false,command:`$f = Join-Path $env:TEMP "m365rpt_od_$(Get-Date -Format yyyyMMddHHmmss).csv"\ntry { Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/reports/getOneDriveUsageAccountDetail(period='D30')" -OutputFilePath $f -ErrorAction Stop } catch { [PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='OneDrive usage report needs Reports.Read.All admin consent.'}; return }\n$data = Import-Csv $f\nRemove-Item $f -Force -EA SilentlyContinue\n$data|Select-Object @{N='User';E={$_.'Owner Display Name'}},@{N='UPN';E={$_.'Owner Principal Name'}},@{N='UsedGB';E={[math]::Round([long]$_.'Storage Used (Byte)'/1GB,2)}},@{N='AllocGB';E={[math]::Round([long]$_.'Storage Allocated (Byte)'/1GB,2)}},@{N='Files';E={$_.'File Count'}},@{N='LastActive';E={$_.'Last Activity Date'}}|Sort-Object UsedGB -Descending`,tags:["onedrive"]},
  {id:"sp-usage",name:"SharePoint Site Usage",desc:"Storage per site \u2014 requires Reports.Read.All admin consent. Site names resolved via Microsoft Search (the usage CSV's Site URL column is blank by Microsoft design)",ex:false,command:`$f = Join-Path $env:TEMP "m365rpt_sp_$(Get-Date -Format yyyyMMddHHmmss).csv"
try { Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/reports/getSharePointSiteUsageDetail(period='D30')" -OutputFilePath $f -ErrorAction Stop } catch { [PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='SharePoint usage report needs Reports.Read.All admin consent.'}; return }
$data = Import-Csv $f
Remove-Item $f -Force -EA SilentlyContinue
$map = @{}
$body = @{requests=@(@{entityTypes=@('site');query=@{queryString='*'};from=0;size=500})} | ConvertTo-Json -Depth 6
try {
  $resp = Invoke-MgGraphRequest -Method POST -Uri 'https://graph.microsoft.com/v1.0/search/query' -Body $body -ContentType 'application/json' -ErrorAction Stop
  foreach ($h in @($resp.value[0].hitsContainers[0].hits)) {
    $r = $h.resource
    $parts = "$($r.id)".Split(',')
    if ($parts.Count -ge 2) { $map[$parts[1].Trim().ToLower()] = $r }
  }
} catch { }
$unres = @($data | Where-Object { $k="$($_.'Site Id')".Trim().ToLower(); $k -and -not $map.ContainsKey($k) } | Select-Object -First 40)
foreach ($u in $unres) {
  $sid = "$($u.'Site Id')".Trim()
  try { $s2 = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/sites/$sid" -ErrorAction Stop; if ($s2 -and $s2.id) { $map[$sid.ToLower()] = $s2 } } catch { }
}
$data | ForEach-Object {
  $sid = "$($_.'Site Id')".Trim().ToLower()
  $site = $null
  if ($map.ContainsKey($sid)) { $site = $map[$sid] }
  [PSCustomObject]@{
    Site = $(if ($site) { $site.displayName } elseif ($_.'Site URL') { $_.'Site URL' } else { '(unresolved)' })
    SiteUrl = $(if ($site) { $site.webUrl } else { $_.'Site URL' })
    SiteId = $_.'Site Id'
    UsedGB = [math]::Round([long]$_.'Storage Used (Byte)'/1GB,2)
    AllocGB = [math]::Round([long]$_.'Storage Allocated (Byte)'/1GB,2)
    Files = $_.'File Count'
    ActiveFiles = $_.'Active File Count'
    LastActive = $_.'Last Activity Date'
  }
} | Sort-Object UsedGB -Descending`,tags:["sharepoint"]},
  {id:"user-onedrive",name:"OneDrive Report (User)",desc:"OneDrive storage for one user from the D30 usage report (needs Reports.Read.All). No row = no OneDrive provisioned, or names concealed by the tenant report-privacy setting.",ex:false,command:`$f = Join-Path $env:TEMP "m365rpt_od1_$(Get-Date -Format yyyyMMddHHmmss).csv"
try { Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/reports/getOneDriveUsageAccountDetail(period='D30')" -OutputFilePath $f -ErrorAction Stop } catch { [PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='OneDrive usage report needs Reports.Read.All admin consent.'}; return }
$data = Import-Csv $f
Remove-Item $f -Force -EA SilentlyContinue
$upn = "<UPN>"
$row = $data | Where-Object { $_.'Owner Principal Name' -eq $upn }
if (-not $row) { [PSCustomObject]@{Result='No OneDrive usage row';UPN=$upn;Hint='User may have no OneDrive provisioned, or names are concealed by the tenant report-privacy setting (see TROUBLESHOOTING.md).'} }
else { $row | Select-Object @{N='User';E={$_.'Owner Display Name'}},@{N='UPN';E={$_.'Owner Principal Name'}},@{N='UsedGB';E={[math]::Round([long]$_.'Storage Used (Byte)'/1GB,2)}},@{N='AllocGB';E={[math]::Round([long]$_.'Storage Allocated (Byte)'/1GB,2)}},@{N='Files';E={$_.'File Count'}},@{N='ActiveFiles';E={$_.'Active File Count'}},@{N='LastActive';E={$_.'Last Activity Date'}} }`,tags:["onedrive","user","storage"],params:[{key:"UPN",label:"User",picker:"users"}]},
]},
{category:"Security",icon:"\u{1F6E1}\uFE0F",color:"#10b981",items:[
  {id:"ca-policies",name:"CA Policies",desc:"Conditional access policies",ex:false,command:`Get-MgIdentityConditionalAccessPolicy -All|Select-Object DisplayName,State,CreatedDateTime,ModifiedDateTime,@{N='IncludeUsers';E={$_.Conditions.Users.IncludeUsers -join ', '}},@{N='IncludeApps';E={$_.Conditions.Applications.IncludeApplications -join ', '}},@{N='GrantControls';E={$_.GrantControls.BuiltInControls -join ', '}}`,tags:["CA"]},
  {id:"sign-in-logs",name:"Sign-In Logs (7d)",desc:"Recent sign-ins",ex:false,command:`$c=(Get-Date).AddDays(-7).ToString("yyyy-MM-ddTHH:mm:ssZ")\nGet-MgAuditLogSignIn -Filter "createdDateTime ge $c" -Top 200 -Sort "createdDateTime desc"|Select-Object UserDisplayName,UserPrincipalName,AppDisplayName,IpAddress,@{N='Location';E={"$($_.Location.City), $($_.Location.CountryOrRegion)"}},@{N='Status';E={if($_.Status.ErrorCode -eq 0){'Success'}else{'Failed'}}},CreatedDateTime`,tags:["audit"]},
  {id:"failed-signins",name:"Failed Sign-Ins (7d)",desc:"Failures with error codes",ex:false,command:`$c=(Get-Date).AddDays(-7).ToString("yyyy-MM-ddTHH:mm:ssZ")\nGet-MgAuditLogSignIn -Filter "createdDateTime ge $c and status/errorCode ne 0" -Top 500 -Sort "createdDateTime desc"|Select-Object UserDisplayName,UserPrincipalName,AppDisplayName,IpAddress,@{N='Location';E={"$($_.Location.City), $($_.Location.CountryOrRegion)"}},@{N='ErrorCode';E={$_.Status.ErrorCode}},@{N='Reason';E={$_.Status.FailureReason}},CreatedDateTime`,tags:["failed"]},
  {id:"risky-users",name:"Risky Users",desc:"Identity Protection flagged users (AAD P2)",ex:false,command:`Get-MgRiskyUser -All|Select-Object UserDisplayName,UserPrincipalName,RiskLevel,RiskState,RiskDetail,RiskLastUpdatedDateTime`,tags:["risk"]},
  {id:"user-signins",name:"Sign-In Logs (User, 7d)",desc:"Recent sign-ins for one user, last 7 days (needs AuditLog.Read.All; AAD P1+ for sign-in logs)",ex:false,command:`$c=(Get-Date).AddDays(-7).ToString("yyyy-MM-ddTHH:mm:ssZ")
$upn="<UPN>"
Get-MgAuditLogSignIn -Filter "userPrincipalName eq '$upn' and createdDateTime ge $c" -Top 200 -Sort "createdDateTime desc"|Select-Object UserDisplayName,UserPrincipalName,AppDisplayName,IpAddress,@{N='Location';E={"$($_.Location.City), $($_.Location.CountryOrRegion)"}},@{N='Status';E={if($_.Status.ErrorCode -eq 0){'Success'}else{'Failed'}}},@{N='ErrorCode';E={$_.Status.ErrorCode}},CreatedDateTime`,tags:["signin","audit","user"],params:[{key:"UPN",label:"User",picker:"users"}]},
  {id:"ca-for-user",name:"CA Policies Targeting a User",desc:"Which conditional access policies target one user by assignment (direct, group, role or All Users), and whether an exclusion removes them. Assignment scope only \u2014 does not evaluate app/device/location conditions like the portal What-If.",ex:false,command:`$u = Get-MgUser -UserId "<UPN>" -Property Id,DisplayName,UserType
$uid = $u.Id
$mo = Get-MgUserTransitiveMemberOf -UserId $uid -All
$grpIds = @($mo | Where-Object { $_.AdditionalProperties.'@odata.type' -eq '#microsoft.graph.group' } | ForEach-Object { $_.Id })
$roleTpl = @($mo | Where-Object { $_.AdditionalProperties.'@odata.type' -eq '#microsoft.graph.directoryRole' } | ForEach-Object { $_.AdditionalProperties.roleTemplateId })
$isGuest = ($u.UserType -eq 'Guest')
$pols = Get-MgIdentityConditionalAccessPolicy -All
$rows = foreach ($p in $pols) {
  $cu = $p.Conditions.Users
  $incU = @($cu.IncludeUsers); $excU = @($cu.ExcludeUsers)
  $incG = @($cu.IncludeGroups); $excG = @($cu.ExcludeGroups)
  $incR = @($cu.IncludeRoles); $excR = @($cu.ExcludeRoles)
  $reason = $null
  if ($incU -contains 'All') { $reason = 'All users' }
  elseif ($incU -contains $uid) { $reason = 'Direct assignment' }
  elseif ($isGuest -and ($incU -contains 'GuestsOrExternalUsers')) { $reason = 'Guest / external' }
  elseif (@($incG | Where-Object { $grpIds -contains $_ }).Count -gt 0) { $reason = 'Group membership' }
  elseif (@($incR | Where-Object { $roleTpl -contains $_ }).Count -gt 0) { $reason = 'Directory role' }
  if ($reason) {
    $exReason = $null
    if ($excU -contains $uid) { $exReason = 'Direct' }
    elseif (@($excG | Where-Object { $grpIds -contains $_ }).Count -gt 0) { $exReason = 'Group' }
    elseif (@($excR | Where-Object { $roleTpl -contains $_ }).Count -gt 0) { $exReason = 'Role' }
    [PSCustomObject]@{
      Policy = $p.DisplayName
      State = $p.State
      IncludedVia = $reason
      Excluded = $(if ($exReason) { $exReason } else { 'No' })
      Applies = $(if ($exReason) { 'No (excluded)' } elseif ($p.State -eq 'enabled') { 'Yes' } else { "Only if $($p.State)" })
      Apps = (@($p.Conditions.Applications.IncludeApplications) -join ', ')
      Controls = (@($p.GrantControls.BuiltInControls) -join ', ')
    }
  }
}
if (-not $rows) { [PSCustomObject]@{Policy='(none)';State='';IncludedVia='No CA policy targets this user by assignment';Excluded='';Applies='';Apps='';Controls=''} } else { $rows }`,tags:["conditional access","CA","user","whatif"],params:[{key:"UPN",label:"User",picker:"users"}]},
]},
{category:"Intune / Devices",icon:"\u{1F4F1}",color:"#14b8a6",items:[
  {id:"intune-devices",name:"Managed Devices",desc:"All Intune-managed devices with compliance, OS, ownership and last check-in (needs DeviceManagementManagedDevices.Read.All + Intune licensing)",ex:false,command:`$all = @(); $uri = 'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=200'
try { do { $resp = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop; $all += $resp.value; $uri = $resp.'@odata.nextLink' } while ($uri) }
catch { [PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='Intune reports need DeviceManagementManagedDevices.Read.All (disconnect/reconnect to consent) plus Intune licensing.'}; return }
$all | Select-Object @{N='Device';E={$_.deviceName}},@{N='User';E={$_.userPrincipalName}},@{N='OS';E={$_.operatingSystem}},@{N='OSVersion';E={$_.osVersion}},@{N='Compliance';E={$_.complianceState}},@{N='Ownership';E={$_.managedDeviceOwnerType}},@{N='LastSync';E={$_.lastSyncDateTime}},@{N='Model';E={$_.model}},@{N='Manufacturer';E={$_.manufacturer}},@{N='Serial';E={$_.serialNumber}} | Sort-Object User,Device`,tags:["intune","devices","mdm","compliance"]},
  {id:"intune-noncompliant",name:"Non-Compliant Devices",desc:"Intune-managed devices whose compliance state is not compliant",ex:false,command:`$all = @(); $uri = 'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=200'
try { do { $resp = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop; $all += $resp.value; $uri = $resp.'@odata.nextLink' } while ($uri) }
catch { [PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='Intune reports need DeviceManagementManagedDevices.Read.All (disconnect/reconnect to consent) plus Intune licensing.'}; return }
$all | Where-Object { $_.complianceState -ne 'compliant' } | Select-Object @{N='Device';E={$_.deviceName}},@{N='User';E={$_.userPrincipalName}},@{N='OS';E={$_.operatingSystem}},@{N='OSVersion';E={$_.osVersion}},@{N='Compliance';E={$_.complianceState}},@{N='Ownership';E={$_.managedDeviceOwnerType}},@{N='LastSync';E={$_.lastSyncDateTime}} | Sort-Object Compliance,User`,tags:["intune","noncompliant","compliance","devices"]},
  {id:"intune-user-devices",name:"Managed Devices (User)",desc:"Intune-managed devices for one user",ex:false,command:`$upn = "<UPN>"
$all = @(); $uri = 'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=200'
try { do { $resp = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop; $all += $resp.value; $uri = $resp.'@odata.nextLink' } while ($uri) }
catch { [PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='Intune reports need DeviceManagementManagedDevices.Read.All (disconnect/reconnect to consent) plus Intune licensing.'}; return }
$rows = @($all | Where-Object { $_.userPrincipalName -eq $upn })
if (-not $rows) { [PSCustomObject]@{Result='No managed devices';UPN=$upn;Hint='User has no Intune-enrolled devices, or is not licensed for Intune.'} }
else { $rows | Select-Object @{N='Device';E={$_.deviceName}},@{N='OS';E={$_.operatingSystem}},@{N='OSVersion';E={$_.osVersion}},@{N='Compliance';E={$_.complianceState}},@{N='Ownership';E={$_.managedDeviceOwnerType}},@{N='LastSync';E={$_.lastSyncDateTime}},@{N='Model';E={$_.model}},@{N='Serial';E={$_.serialNumber}},@{N='Enrolled';E={$_.enrolledDateTime}} }`,tags:["intune","devices","user"],params:[{key:"UPN",label:"User",picker:"users"}]},
  {id:"intune-compliance-policies",name:"Compliance Policies",desc:"Intune device compliance policies (needs DeviceManagementConfiguration.Read.All)",ex:false,command:`$all = @(); $uri = 'https://graph.microsoft.com/v1.0/deviceManagement/deviceCompliancePolicies?$top=100'
try { do { $resp = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop; $all += $resp.value; $uri = $resp.'@odata.nextLink' } while ($uri) }
catch { [PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='Needs DeviceManagementConfiguration.Read.All (disconnect/reconnect to consent).'}; return }
$all | Select-Object @{N='Name';E={$_.displayName}},@{N='Platform';E={($_.'@odata.type' -replace '#microsoft.graph.','') -replace 'CompliancePolicy',''}},@{N='Version';E={$_.version}},@{N='Created';E={$_.createdDateTime}},@{N='Modified';E={$_.lastModifiedDateTime}} | Sort-Object Platform,Name`,tags:["intune","compliance","policy"]},
  {id:"intune-config-profiles",name:"Configuration Profiles",desc:"Intune device configuration profiles (needs DeviceManagementConfiguration.Read.All)",ex:false,command:`$all = @(); $uri = 'https://graph.microsoft.com/v1.0/deviceManagement/deviceConfigurations?$top=100'
try { do { $resp = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop; $all += $resp.value; $uri = $resp.'@odata.nextLink' } while ($uri) }
catch { [PSCustomObject]@{Result='ERROR';Error=$_.Exception.Message;Hint='Needs DeviceManagementConfiguration.Read.All (disconnect/reconnect to consent).'}; return }
$all | Select-Object @{N='Name';E={$_.displayName}},@{N='Platform';E={($_.'@odata.type' -replace '#microsoft.graph.','') -replace 'Configuration',''}},@{N='Version';E={$_.version}},@{N='Created';E={$_.createdDateTime}},@{N='Modified';E={$_.lastModifiedDateTime}} | Sort-Object Platform,Name`,tags:["intune","configuration","profile"]},
]},
{category:"Tenant",icon:"\u{1F3E2}",color:"#6366f1",items:[
  {id:"tenant-info",name:"Tenant Info",desc:"Organization details",ex:false,command:`Get-MgOrganization|Select-Object DisplayName,Id,@{N='Domains';E={($_.VerifiedDomains|ForEach-Object{$_.Name}) -join ', '}},@{N='DefaultDomain';E={($_.VerifiedDomains|Where-Object IsDefault).Name}},CountryLetterCode,@{N='TechContact';E={$_.TechnicalNotificationMails -join ', '}},OnPremisesSyncEnabled,CreatedDateTime`,tags:["org"]},
  {id:"domains",name:"Verified Domains",desc:"All verified domains",ex:false,command:`(Get-MgOrganization).VerifiedDomains|Select-Object Name,Type,IsDefault,IsInitial`,tags:["DNS"]},
  {id:"devices",name:"Registered Devices",desc:"Azure AD devices",ex:false,fields:["DisplayName","OperatingSystem","OperatingSystemVersion","TrustType","AccountEnabled","ApproximateLastSignInDateTime"],baseCmd:`Get-MgDevice -All -Property "__FIELDS__"|Select-Object __FIELDS__`,tags:["devices"]},
]},
];

// ── Lookup ────────────────────────────────────────────────────────────
function findReport(id) {
  for (const c of REPORTS) { const r = c.items.find(i => i.id === id); if (r) return r; }
  return null;
}

// reportId -> area (category) index, for the v12 RBAC report/area allowlist.
const REPORT_AREA = Object.fromEntries(
  REPORTS.flatMap(c => c.items.map(i => [i.id, c.category]))
);
// The area (category) a report belongs to, or null if the id is unknown.
function reportArea(id) { return REPORT_AREA[id] || null; }
// All defined area names (categories).
function allAreas() { return REPORTS.map(c => c.category); }

// ── Command construction (server-side only) ──────────────────────────
// Strips PowerShell metacharacters from user-supplied parameter values.
const PARAM_STRIP = /[`$"'{}();&|<>\\]/g;

function buildCommand(report, fields, params) {
  let cmd;
  if (report.baseCmd) {
    // Whitelist: only fields declared in the catalog are accepted.
    let sel = Array.isArray(fields) && fields.length
      ? fields.filter(f => report.fields.includes(f))
      : report.fields;
    if (!sel.length) sel = report.fields;
    cmd = report.baseCmd.replace(/__FIELDS__/g, sel.join(","));
  } else {
    cmd = report.command;
  }
  if (report.params && params) {
    for (const p of report.params) {
      const v = String(params[p.key] ?? "").replace(PARAM_STRIP, "").trim();
      cmd = cmd.split("<" + p.key + ">").join(v);
    }
  }
  return cmd;
}

module.exports = { REPORTS, findReport, buildCommand, reportArea, allAreas, REPORT_AREA };
