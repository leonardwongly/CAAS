targetScope = 'subscription'

@description('Safety switch. Keep false for offline validation and local planning.')
param deployResources bool = false

@description('Bootstrap keeps the Container App external ingress disabled and does not create auth configuration.')
param bootstrap bool = true

@description('Explicit post-auth gate for external ingress. Keep false until the protected smoke checks pass.')
param enableExternalIngress bool = false

@description('The single POC region.')
@allowed([
  'southeastasia'
])
param location string = 'southeastasia'

@description('Resource group name supplied by the authorized bootstrap operator.')
param resourceGroupName string

@description('Short, globally unique resource prefix.')
@minLength(3)
@maxLength(18)
param namePrefix string

@description('Repository-qualified OCI image reference without a tag or digest.')
param imageRepository string

@description('Immutable OCI digest. The offline gate requires exactly sha256: followed by 64 lowercase hexadecimal characters.')
@minLength(71)
@maxLength(71)
param imageDigest string

@description('GitHub repository in OWNER/REPOSITORY form for the protected deployment identity.')
param githubRepository string

@description('Protected GitHub environment name used by the federated credential.')
param githubEnvironment string = 'poc-deploy'

@description('Tenant ID supplied at deployment time; never commit an identifier here.')
@minLength(1)
param tenantId string

@description('Allowed single-user object ID supplied at deployment time; never commit an identifier here.')
@minLength(1)
param allowedUserObjectId string

@description('Existing single-tenant Entra application client ID created by the bootstrap authority.')
@minLength(1)
param entraClientId string

@description('The Container App hostname/audience supplied for the post-bootstrap auth configuration.')
@minLength(1)
param appAudience string

@description('Existing Key Vault secret name for the CAAS API key and its Container Apps secret alias.')
@minLength(1)
param caasApiKeySecretName string = 'caas-api-key'

@description('Existing Key Vault secret name for the Entra client secret and its Container Apps secret alias. No secret value is accepted here.')
@minLength(1)
param entraClientSecretName string = 'entra-client-secret'

@description('Two-phase bootstrap split (design section 0.5 DAG steps 3-5): keep false for the first apply so the one-time bootstrap authority creates the Container App only after the unchanged PG-03 digest has been pushed through OIDC. No placeholder image is ever used.')
param createContainerApp bool = true

@description('Email addresses notified by the budget alerts. The authorized bootstrap must supply at least one contact (email or action group); otherwise the alerts cannot deliver the USD 25 / 37.50 / 45 governance signals.')
param budgetContactEmails array = []

@description('Action group resource ID notified by the budget alerts. The authorized bootstrap must supply at least one contact (email or action group); otherwise the alerts cannot deliver the USD 25 / 37.50 / 45 governance signals.')
param budgetActionGroupId string = ''

@description('Budget period start supplied by the authorized bootstrap operator.')
param budgetStartDate string

@description('Budget period end supplied by the authorized bootstrap operator.')
param budgetEndDate string

@description('Keep the initial bootstrap app at zero replicas until the protected rollout gate is complete.')
param minReplicas int = 0

@description('The POC hard ceiling for a single serving replica.')
param maxReplicas int = 1

var commonTags = {
  workload: 'flight-route-explorer-poc'
  lifecycle: 'poc'
  owner: 'user-authorized-bootstrap'
  expiresAfterDays: '7'
  teardownTarget: '24-hours-after-demonstration'
  cloudWrites: 'disabled-by-default'
}

var registryName = '${namePrefix}acr'
var image = '${imageRepository}@${imageDigest}'

resource deploymentResourceGroup 'Microsoft.Resources/resourceGroups@2022-09-01' = if (deployResources) {
  name: resourceGroupName
  location: location
  tags: commonTags
}

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = if (deployResources) {
  name: '${namePrefix}-budget'
  properties: {
    category: 'Cost'
    amount: 50
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
      endDate: budgetEndDate
    }
    // Design section 0.5 / plan section 6.3: USD 50 governance ceiling with
    // alert thresholds at USD 25, USD 37.50, and USD 45. Azure budget
    // notification thresholds are percentages of the budget amount:
    // 50% = USD 25, 75% = USD 37.50, 90% = USD 45.
    // Alerts are delayed notifications, not billing cutoffs; expiry tags do
    // not delete resources. At least one contact must be supplied at
    // deployment time or the alerts cannot deliver.
    notifications: {
      forecasted25: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        contactEmails: budgetContactEmails
        contactRoles: []
        contactGroups: budgetActionGroupId != '' ? [budgetActionGroupId] : []
      }
      forecasted37: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 75
        contactEmails: budgetContactEmails
        contactRoles: []
        contactGroups: budgetActionGroupId != '' ? [budgetActionGroupId] : []
      }
      forecasted45: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        contactEmails: budgetContactEmails
        contactRoles: []
        contactGroups: budgetActionGroupId != '' ? [budgetActionGroupId] : []
      }
    }
  }
}

module resourceGroupResources 'resource-group.bicep' = if (deployResources) {
  name: '${namePrefix}-resource-group-resources'
  scope: resourceGroup(resourceGroupName)
  dependsOn: [
    deploymentResourceGroup
  ]
  params: {
    location: location
    namePrefix: namePrefix
    commonTags: commonTags
    image: image
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    bootstrap: bootstrap
    enableExternalIngress: enableExternalIngress
    tenantId: tenantId
    allowedUserObjectId: allowedUserObjectId
    entraClientId: entraClientId
    appAudience: appAudience
    caasApiKeySecretName: caasApiKeySecretName
    entraClientSecretName: entraClientSecretName
    githubRepository: githubRepository
    githubEnvironment: githubEnvironment
    createContainerApp: createContainerApp
  }
}

output deploymentMode string = deployResources ? 'authorized-resource-deployment' : 'offline-scaffold-only'
output bootstrapIngress string = bootstrap ? 'disabled' : 'gated-after-authentication'
output immutableImage string = image
output resourceGroup string = resourceGroupName
output registryLoginServer string = deployResources ? resourceGroupResources.outputs.registryLoginServer : '${registryName}.azurecr.io'
output containerAppResourceId string = (deployResources && createContainerApp) ? resourceGroupResources.outputs.containerAppResourceId : 'not-materialized'
