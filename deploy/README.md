# Deploying to Azure Container Apps (ACA)

This folder contains everything needed to run M365 Admin Reports as a single
long-running **Container App** (not a Job — it's an interactive web service).

- `main.bicep` — declarative infrastructure (environment, Azure Files storage,
  the Container App with external ingress, scale-to-zero, volume mount).
- `Deploy-ToAca.ps1` — orchestration wrapper: builds/pushes the image, creates
  storage, deploys the Bicep, and wires the Entra ingress gate (Easy Auth).

> **Local-first.** Validate the container locally before deploying:
> `docker compose up --build`, open <http://localhost:3365>, connect, run a
> report. The same image runs in ACA.

## Security posture (read this first)

The tool has **no application-level authorization yet** (RBAC is v12 — see
`../RBAC-ROADMAP.md`). Without a gate, a public ACA ingress would be an
unauthenticated, tenant-admin-privileged (read-only) surface. Two things close
that gap:

1. **TLS at the edge.** ACA ingress terminates HTTPS at the platform, so
   external traffic is encrypted even though the app speaks plain HTTP inside
   the environment. `allowInsecure` is `false`.
2. **Entra Easy Auth.** Container Apps built-in authentication requires an
   Entra sign-in *before any request reaches the app*, restricted to your home
   tenant (`-HomeTenantId`). This is the gate that makes public exposure
   acceptable ahead of v12 RBAC.

`config.json` (the tenant list) is **never baked into the image**. Supply it at
runtime on the mounted Azure Files share, or leave it absent (the tenant picker
is optional).

## Authentication — two independent layers

| Layer | What it controls | Mechanism |
|-------|------------------|-----------|
| **Ingress gate** | *Who may open the tool* | Easy Auth, home tenant only |
| **Graph/Exchange connect** | *Which tenant the tool reports on* | In-app device-code sign-in |

These are deliberately separate. An AM operator authenticates at the ingress
with an `am.consulting` identity, then inside the app can run a **device-code
connect into a client tenant** (GlobalPlatform, EMVCo, …) to report against it.
Per-tenant app-only (certificate) auth is the planned robust successor — see
the open questions in `../RBAC-ROADMAP.md`.

## Scale-to-zero behavior (important)

`main.bicep` sets **minReplicas 0 / maxReplicas 1**.

- **min 0** — the app scales to zero when idle (no cost while unused); the first
  request cold-starts a fresh container.
- **max 1** — required. The authenticated Graph/Exchange session lives in a
  single in-memory `pwsh` process. A second replica would answer requests from
  its own *unauthenticated* session behind the same ingress.

**Consequence:** after a scale-to-zero (or any restart), the in-memory session
is gone, so the operator **re-runs the device-code connect** on first use.
Durable state (snapshots, audit log, console logs, CSV exports) lives on the
Azure Files volume and is **not** affected.

## Persistent storage (DATA_DIR)

All durable state is written under `DATA_DIR` (`/app/data` in the container),
backed by an Azure Files share:

```
/app/data/
  M365Snapshots/    point-in-time report copies + diff source
  M365AuditLog/     append-only JSONL audit trail
  M365Logs/         console-YYYY-MM.log (container stdout is ephemeral)
  M365Reports/      exported CSVs
```

Locally, `docker-compose.yml` mounts `./data` at the same path so behavior
matches. With `DATA_DIR` unset (a plain `node server.js` run), these dirs fall
back to the working directory exactly as before — the change is backward
compatible.

## One-shot deploy

From the repo root, with Azure CLI logged in to the right subscription:

```powershell
./deploy/Deploy-ToAca.ps1 `
  -ResourceGroup   rg-m365admin `
  -Location        eastus `
  -AcrName         amm365acr `          # 5-50 alphanumerics, globally unique
  -StorageAccountName amm365data `      # 3-24 lowercase alnum, globally unique
  -HomeTenantId    am.consulting        # tenant allowed to sign in at the gate
```

Add `-WhatIf` to print every step and `az` command without executing.

The script prints the app URL, the log-follow command for the device code, and
the re-auth reminder when it finishes.

### What the script does

1. Verifies `az` is present, logged in, and reports the subscription.
2. Creates the resource group.
3. Creates the ACR (admin enabled) and builds the image server-side with
   `az acr build` — **no local Docker required** for the cloud build.
4. Creates the storage account + Azure Files share and fetches the key.
5. Deploys `main.bicep`, capturing the ingress FQDN.
6. Registers (or reuses) the Easy Auth Entra app with the correct redirect URI,
   mints a client secret, and enables Easy Auth restricted to `-HomeTenantId`.

## After deploy

1. Open the printed `https://…azurecontainerapps.io` URL and sign in (Easy Auth).
2. In the app, **Connect** to Graph/Exchange. Watch for the device code:
   ```powershell
   az containerapp logs show -g rg-m365admin -n m365-admin-reports --follow
   ```
   Complete the device-code sign-in in your browser.
3. (Optional) Upload a real `config.json` to the Azure Files share for the
   tenant picker.

## Teardown

```powershell
az group delete --name rg-m365admin --yes --no-wait
# Also remove the Easy Auth app registration if no longer needed:
az ad app delete --id <easyauth-app-id>
```

## Prerequisites

- Azure CLI (`az`) with the `containerapp` extension (the script adds it).
- Rights to create: resource group, ACR, storage account, Container Apps
  environment + app, and **an Entra app registration** for Easy Auth.
- The provider registration `Microsoft.App` (and `Microsoft.OperationalInsights`)
  on the subscription. If a deploy fails with a `*/register/action` permission
  error, register the providers once at subscription scope, then
  `az logout` / `az login` to refresh the token cache.
