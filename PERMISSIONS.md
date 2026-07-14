# Permissions Matrix — M365 Admin Reports

Every report is read-only. The Graph connection requests these delegated
scopes (see `server.js`, `/api/connect/graph`):

    User.Read.All, Group.Read.All, Directory.Read.All, Organization.Read.All,
    AuditLog.Read.All, Reports.Read.All, Policy.Read.All,
    RoleManagement.Read.Directory, Sites.Read.All, IdentityRiskyUser.Read.All

Exchange reports use the ExchangeOnlineManagement module and require an
Exchange admin role (View-Only Organization Management is sufficient) via the
separate **Connect Exchange** button.

Notes on delegated scopes:
- Requesting a scope is not the same as being granted it. Some scopes
  (notably `Reports.Read.All`, and in some tenants `Sites.Read.All` and
  `AuditLog.Read.All`) require **admin consent** before they appear in the
  token. If a report fails, run it once — the v11 error envelope will show
  the actual Graph error — and compare against this table.
- After granting consent, **Disconnect and reconnect** so a fresh token is
  issued. Cached tokens do not gain new scopes.
- A **Global Reader** role covers everything the Graph reports need.

| Report | Graph scope(s) / requirement | Admin consent typically needed |
|---|---|---|
| **Users** | | |
| All Users, User Details, Disabled, Guests, Recently Created, Unlicensed | User.Read.All | No |
| Stale Users (SignInActivity) | User.Read.All + AuditLog.Read.All | Often |
| Admin Role Assignments | RoleManagement.Read.Directory, Directory.Read.All | Sometimes |
| Groups for a User | User.Read.All, Group.Read.All | No |
| **Groups** | | |
| All / Security / DLs / M365 / Dynamic / Empty | Group.Read.All | No |
| Group Members / Owners | Group.Read.All (member details: User.Read.All) | No |
| **Licenses** | | |
| License Summary, Service Plans | Organization.Read.All | No |
| Licenses for a User | User.Read.All (or Directory.Read.All) | No |
| **Exchange / Mailbox** | Exchange Online connection + admin role | n/a (RBAC role) |
| Shared Mailboxes, Forwarding, Inbox Rules, All Forwarding Rules, Mailbox Permissions, Mailbox Sizes | View-Only Organization Management or higher | — |
| Mailbox Report (User) | View-Only Recipients or higher | — |
| Distribution List Members | View-Only Recipients or higher | — |
| Message Trace | Exchange role incl. **Message Tracking** (e.g. Organization Management / Compliance Management) | — |
| **SharePoint / OneDrive** | | |
| All SharePoint Sites, Site Search | Sites.Read.All | Sometimes |
| OneDrive Usage, SharePoint Site Usage | Reports.Read.All | **Yes** |
| OneDrive Report (User) | Reports.Read.All | **Yes** |
| **Security** | | |
| CA Policies | Policy.Read.All | Yes |
| Sign-In Logs, Failed Sign-Ins | AuditLog.Read.All (requires AAD P1+) | Yes |
| Sign-In Logs (User, 7d) | AuditLog.Read.All (requires AAD P1+) | Yes |
| Risky Users | IdentityRiskyUser.Read.All (requested as of v11.5.1; requires AAD P2 for data) | Yes |
| CA Policies Targeting a User | Policy.Read.All + Directory.Read.All | Yes (for CA policies) |
| **Intune / Devices** | | |
| Managed Devices, Non-Compliant, Managed Devices (User) | DeviceManagementManagedDevices.Read.All | **Yes (new in v11.8.0)** |
| Compliance Policies, Configuration Profiles | DeviceManagementConfiguration.Read.All | **Yes (new in v11.8.0)** |
| **Tenant** | | |
| Tenant Info, Verified Domains | Organization.Read.All | No |
| Registered Devices | Directory.Read.All | No |

Delegated-permission quirks worth knowing:
- `GET /sites/getAllSites` works only with **application** permissions; with
  delegated auth the tool uses `GET /sites?search=%20` (URL-encoded space),
  which returns the sites the signed-in account can access — not necessarily
  every site in the tenant.
- Usage reports (`Get-MgReport*`) return CSV, not JSON, and always need
  `Reports.Read.All` with admin consent.
- Risky Users returns an error without an Azure AD Premium P2 license — that
  is a licensing condition, not a bug.
