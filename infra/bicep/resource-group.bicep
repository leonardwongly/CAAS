targetScope = 'resourceGroup'

@description('The single POC region.')
param location string

@description('Resource prefix shared with the subscription-scoped entry point.')
param namePrefix string

@description('GitHub repository in OWNER/REPOSITORY form for the protected deployment identity.')
param githubRepository string

@description('Protected GitHub environment name used by the federated credential.')
param githubEnvironment string

@description('Common tags applied to every resource.')
param commonTags object

@description('Immutable repository-qualified OCI image reference.')
param image string

@description('Keep the initial bootstrap app at zero replicas until the protected rollout gate is complete.')
param minReplicas int

@description('The POC hard ceiling for a single serving replica.')
param maxReplicas int

@description('Bootstrap keeps the Container App external ingress disabled and does not create auth configuration.')
param bootstrap bool

@description('Explicit post-auth gate for external ingress. Keep false until the protected smoke checks pass.')
param enableExternalIngress bool

@description('Tenant ID supplied at deployment time; never commit an identifier here.')
param tenantId string

@description('Allowed single-user object ID supplied at deployment time; never commit an identifier here.')
param allowedUserObjectId string

@description('Existing single-tenant Entra application client ID created by the bootstrap authority.')
param entraClientId string

@description('Container Apps secret alias and existing Key Vault secret name for the CAAS API key.')
param caasApiKeySecretName string

@description('Container Apps secret alias and existing Key Vault secret name for the Entra client secret.')
param entraClientSecretName string

@description('The Container App hostname/audience supplied for the post-bootstrap auth configuration.')
param appAudience string

var registryName = '${namePrefix}acr'
var logWorkspaceName = '${namePrefix}-logs'
var runtimeIdentityName = '${namePrefix}-runtime'
var deploymentIdentityName = '${namePrefix}-deploy'
var keyVaultName = '${namePrefix}-kv'
var managedEnvironmentName = '${namePrefix}-env'
var containerAppName = '${namePrefix}-app'
var federatedCredentialName = 'github-${githubEnvironment}'

resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logWorkspaceName
  location: location
  tags: commonTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  tags: commonTags
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: runtimeIdentityName
  location: location
  tags: commonTags
}

resource deploymentIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: deploymentIdentityName
  location: location
  tags: commonTags
}

resource federatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31-preview' = {
  parent: deploymentIdentity
  name: federatedCredentialName
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:environment:${githubEnvironment}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: commonTags
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enabledForTemplateDeployment: false
    publicNetworkAccess: 'Enabled'
    softDeleteRetentionInDays: 7
    accessPolicies: []
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: managedEnvironmentName
  location: location
  tags: commonTags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logWorkspace.properties.customerId
        sharedKey: listKeys(logWorkspace.id, logWorkspace.apiVersion).primarySharedKey
      }
    }
  }
}

resource acrPullForRuntime 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, runtimeIdentity.id, 'acrpull')
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource secretsReaderForRuntime 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, runtimeIdentity.id, 'secretsuser')
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource acrPushForDeployment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, deploymentIdentity.id, 'acpush')
  properties: {
    principalId: deploymentIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
  }
}

resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: location
  tags: commonTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // Bootstrap invariant: external ingress is disabled until auth and smoke gates pass.
        external: bootstrap ? false : enableExternalIngress
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: runtimeIdentity.id
        }
      ]
      secrets: concat([
        {
          name: caasApiKeySecretName
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${caasApiKeySecretName}'
          identity: runtimeIdentity.id
        }
      ], bootstrap ? [] : [
        {
          name: entraClientSecretName
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${entraClientSecretName}'
          identity: runtimeIdentity.id
        }
      ])
    }
    template: {
      containers: [
        {
          name: 'flight-route-explorer'
          image: image
          resources: {
            cpu: 1
            memory: '2Gi'
          }
          env: [
            {
              name: 'apikey'
              secretRef: caasApiKeySecretName
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health/startup'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 20
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 18
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

resource authConfig 'Microsoft.App/containerApps/authConfigs@2023-05-01' = if (!bootstrap) {
  parent: containerApp
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: entraClientId
          clientSecretSettingName: entraClientSecretName
          openIdIssuer: 'https://login.microsoftonline.com/${tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            appAudience
          ]
          defaultAuthorizationPolicy: {
            allowedPrincipals: {
              identities: [
                allowedUserObjectId
              ]
            }
          }
        }
      }
    }
  }
}

output registryLoginServer string = registry.properties.loginServer
output containerAppResourceId string = containerApp.id
