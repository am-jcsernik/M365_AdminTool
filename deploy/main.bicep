// ═══════════════════════════════════════════════════════════════════════
//  M365 Admin Reports — Azure Container Apps infrastructure
//
//  Declares the durable infrastructure for a single long-running Container
//  App (NOT a Job — this is an interactive web service):
//    - Log Analytics workspace (required by the managed environment)
//    - Container Apps managed environment
//    - Azure Files share + environment storage link (the DATA_DIR volume)
//    - The Container App itself: external ingress, scale-to-zero, volume mount
//
//  Deliberately NOT in this template:
//    - The Entra app registration + Easy Auth (authConfig). Easy Auth needs
//      the app's ingress FQDN to register its redirect URI, which only exists
//      after the app is created. Deploy-ToAca.ps1 wires Easy Auth via
//      `az containerapp auth` in a second pass once the FQDN is known.
//    - config.json (tenant list): supplied at runtime on the DATA volume.
//
//  Scale model: minReplicas 0 (scale-to-zero) / maxReplicas 1. The single
//  cap is REQUIRED: the authenticated Graph/Exchange session lives in one
//  in-memory pwsh process, so a second replica would answer requests from an
//  unauthenticated session behind the same ingress. Scale-to-zero means the
//  operator re-runs the device-code sign-in on the first request after a
//  cold start; durable state on the Azure Files volume is unaffected.
// ═══════════════════════════════════════════════════════════════════════

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Name of the Container App.')
param containerAppName string = 'm365-admin-reports'

@description('Name of the Container Apps managed environment.')
param environmentName string = 'm365-admin-env'

@description('Name of the Log Analytics workspace backing the environment.')
param logAnalyticsName string = 'm365-admin-logs'

@description('Full container image reference, e.g. myregistry.azurecr.io/m365-admin-reports:11.12.0')
param image string

@description('ACR login server, e.g. myregistry.azurecr.io')
param acrLoginServer string

@description('ACR username (admin user or a token/service principal id).')
param acrUsername string

@description('ACR password. Passed as a secure parameter; stored as an app secret.')
@secure()
param acrPassword string

@description('Existing storage account name that holds the Azure Files share.')
param storageAccountName string

@description('Storage account key for the Azure Files mount. Secure.')
@secure()
param storageAccountKey string

@description('Azure Files share name used for DATA_DIR (durable state).')
param fileShareName string = 'm365data'

@description('CPU cores for the container (0.25-2.0).')
param cpu string = '1.0'

@description('Memory for the container (must pair with cpu; e.g. 2Gi with 1.0 CPU).')
param memory string = '2Gi'

@description('v12 RBAC: create a Key Vault (RBAC-auth mode) and grant the app identity read access. Additive — leave false for pre-v12 deploys. The Phase 0 script (Provision-RbacPhase0.ps1) is the imperative path for the already-live app.')
param deployKeyVault bool = false

@description('v12 RBAC: Key Vault name for per-tenant app-only certificates. Required when deployKeyVault is true.')
param keyVaultName string = ''

var storageLinkName = 'm365data'
var dataMountPath = '/app/data'
// Built-in role: Key Vault Secrets User (read secret contents).
var kvSecretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

// ── Log Analytics workspace ──────────────────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── Container Apps managed environment ────────────────────────────────
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ── Azure Files link (backs the DATA_DIR volume) ──────────────────────
resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: storageLinkName
  properties: {
    azureFile: {
      accountName: storageAccountName
      accountKey: storageAccountKey
      shareName: fileShareName
      accessMode: 'ReadWrite'
    }
  }
}

// ── Container App ─────────────────────────────────────────────────────
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  // v12 RBAC: system-assigned identity lets the app read per-tenant certs from
  // Key Vault at runtime (no secret on disk). Harmless when deployKeyVault=false.
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      // External ingress: ACA terminates TLS at the edge, so external
      // traffic is HTTPS even though the app speaks plain HTTP internally.
      ingress: {
        external: true
        targetPort: 3365
        transport: 'auto'
        allowInsecure: false
        traffic: [
          { latestRevision: true, weight: 100 }
        ]
      }
      secrets: [
        { name: 'acr-password', value: acrPassword }
      ]
      registries: [
        {
          server: acrLoginServer
          username: acrUsername
          passwordSecretRef: 'acr-password'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'm365-admin-reports'
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            { name: 'DOCKER_MODE', value: '1' }
            { name: 'PORT', value: '3365' }
            { name: 'DATA_DIR', value: dataMountPath }
            { name: 'NODE_ENV', value: 'production' }
            // v12 RBAC: name of the Key Vault holding per-tenant app-only certs.
            // Empty until deployKeyVault is enabled; the app reads it only then.
            { name: 'KEY_VAULT_NAME', value: keyVaultName }
          ]
          volumeMounts: [
            { volumeName: 'data', mountPath: dataMountPath }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 3365 }
              initialDelaySeconds: 15
              periodSeconds: 30
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'data'
          storageType: 'AzureFile'
          storageName: storageLinkName
        }
      ]
      // Scale-to-zero, single replica (see file header for the why).
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http-scale'
            http: { metadata: { concurrentRequests: '20' } }
          }
        ]
      }
    }
  }
  dependsOn: [
    envStorage
  ]
}

// ── v12 RBAC: Key Vault for per-tenant app-only certificates ──────────
// RBAC-authorization mode; the app's system-assigned identity is granted
// "Key Vault Secrets User" so it can read cert material at connect time.
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = if (deployKeyVault) {
  name: keyVaultName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
  }
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployKeyVault) {
  name: guid(keyVault.id, containerApp.id, 'kv-secrets-user')
  scope: keyVault
  properties: {
    roleDefinitionId: kvSecretsUserRoleId
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

@description('The public HTTPS FQDN of the deployed app.')
output appFqdn string = containerApp.properties.configuration.ingress.fqdn
@description('Convenience full URL.')
output appUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
@description('The app system-assigned identity principalId (for KV / Graph grants).')
output appPrincipalId string = containerApp.identity.principalId
@description('Key Vault URI (empty unless deployKeyVault is true).')
output keyVaultUri string = deployKeyVault ? keyVault!.properties.vaultUri : ''
