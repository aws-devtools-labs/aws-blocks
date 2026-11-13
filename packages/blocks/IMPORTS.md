# What to import from where

<!-- Generated from the built packages by `npm run update:imports`; do not edit. -->

Every app-facing entry of `@aws-blocks/blocks`, where it runs, and every name it exports. A **value** can be imported normally; a **type** only with `import type` (or `import { type … }`).

The rule that matters most: **code that runs under the `browser` condition imports no values from the root `@aws-blocks/blocks`**. That covers browser bundles and the templates' e2e tests (`npm run test:e2e` runs `tsx -C browser`). The root is the backend entry and the only one with a `browser` condition, under which it resolves to an empty module; every subpath resolves to the same file everywhere. Such code imports from `/client`, `/ui` and `/theme`, the e2e tests also from `/utils`, and a block's error constants come from that block's own package (`KVStoreErrors` from `@aws-blocks/bb-kv-store`; see [Root values in browser code](#root-values-in-browser-code)). The typed client of your own API is `import { api } from 'aws-blocks'` (your backend module), not an `@aws-blocks/blocks` entry.

| Entry | Runs in | For |
|---|---|---|
| `@aws-blocks/blocks` | Backend (`aws-blocks/`): local dev, Lambda, CDK synth. | Every Building Block and the core backend API. It is the only entry with a `browser` condition: there (browser bundles, and the templates’ `npm run test:e2e`, which runs `tsx -C browser`) it resolves to an empty module, so no values, though `import type` still works. Under `--conditions=cdk` it resolves to the `/cdk` build. |
| `@aws-blocks/blocks/client` | Browser, Node, and the `tsx -C browser` e2e tests. | Core’s browser-safe values: errors and their matchers, and the API client runtime the generated `aws-blocks` client uses. |
| `@aws-blocks/blocks/ui` | Browser (returns DOM nodes). | The auth UI components and the auth state store. |
| `@aws-blocks/blocks/theme` | Browser. | The stylesheet the UI components use. |
| `@aws-blocks/blocks/server` | Server-side rendering (Node). | Forwarding the browser’s cookies to API calls made during SSR. |
| `@aws-blocks/blocks/utils` | Node tests and scripts, including the templates’ `tsx -C browser` e2e tests (no `browser` condition, so it resolves the same everywhere). | Test helpers: a cookie jar for `fetch`, per-user test clients, local auth codes, TOTP codes. |
| `@aws-blocks/blocks/cdk` | CDK synth (`cdk-blocks deploy` / `sandbox`), in your app’s CDK entry file `aws-blocks/index.cdk.ts`. | The synth-time build: what the generated `aws-blocks/index.cdk.ts` imports (`BlocksStack`, `BlocksPresets`, `Hosting`, `HostingPresets`), plus every block’s CDK construct. |
| `@aws-blocks/blocks/lambda-handler` | The deployed Lambda. | `createLambdaHandler`, which the generated `aws-blocks/index.handler.ts` imports. |
| `@aws-blocks/blocks/scripts` | Node: the `cdk-blocks` CLI, and your CDK entry file. | CLI plumbing (dev server, deploy, sandbox). The generated `aws-blocks/index.cdk.ts` imports `getStackName` from it, and the amplify template’s `aws-blocks/scripts/generate-client.ts` imports `generateClientCode`. |

## Root values in browser code

Code run under the `browser` condition can’t import values from the root. These root values have a browser export: in a browser-safe entry of `@aws-blocks/blocks`, or in the browser build of the package that defines them, which carries its error constants and pure helpers (the Building Block classes there are stubs, so they are not listed). Those packages are dependencies of `@aws-blocks/blocks`; to import one directly, add it to your app’s `dependencies`. An error can also be matched by its name string, with nothing extra installed: `isBlocksError(e, 'ConditionalCheckFailedException')` from `@aws-blocks/blocks/client`.

| Name | In browser code, import from |
|---|---|
| `AgentErrors` | `@aws-blocks/bb-agent` |
| `ApiError` | `@aws-blocks/blocks/client` |
| `AppSettingErrors` | `@aws-blocks/bb-app-setting` |
| `AsyncJobErrors` | `@aws-blocks/bb-async-job` |
| `AuthErrors` | `@aws-blocks/bb-auth` |
| `BedrockModels` | `@aws-blocks/bb-agent` |
| `blocksError` | `@aws-blocks/blocks/client` |
| `brandBlocksError` | `@aws-blocks/blocks/client` |
| `CronJobErrors` | `@aws-blocks/bb-cron-job` |
| `customOauth2` | `@aws-blocks/bb-auth` |
| `DashboardErrors` | `@aws-blocks/bb-dashboard` |
| `DatabaseErrors` | `@aws-blocks/bb-data` |
| `DEFAULT_API_ERROR_NAME` | `@aws-blocks/blocks/client` |
| `DistributedDatabaseErrors` | `@aws-blocks/bb-distributed-data` |
| `DistributedTableErrors` | `@aws-blocks/bb-distributed-table` |
| `EmailErrors` | `@aws-blocks/bb-email-client` |
| `FileBucketErrors` | `@aws-blocks/bb-file-bucket` |
| `fromExisting` | `@aws-blocks/bb-data` |
| `github` | `@aws-blocks/bb-auth` |
| `hasAuthError` | `@aws-blocks/blocks/client` |
| `isAuthError` | `@aws-blocks/bb-auth` |
| `isBlocksError` | `@aws-blocks/blocks/client` |
| `isWireSafeError` | `@aws-blocks/blocks/client` |
| `KnowledgeBaseErrors` | `@aws-blocks/bb-knowledge-base` |
| `KVStoreErrors` | `@aws-blocks/bb-kv-store` |
| `LoggingErrors` | `@aws-blocks/bb-logger` |
| `MetricsErrors` | `@aws-blocks/bb-metrics` |
| `OllamaModels` | `@aws-blocks/bb-agent` |
| `relayOrigin` | `@aws-blocks/bb-auth` |
| `Scope` | `@aws-blocks/blocks/client` |
| `SecretErrors` | `@aws-blocks/bb-secret` |
| `stubIdp` | `@aws-blocks/bb-auth` |

The other root values (the Building Block classes, CDK and server helpers) have no browser export; browser code uses `import type` for their types.

## `@aws-blocks/blocks`

Backend (`aws-blocks/`): local dev, Lambda, CDK synth.

**Values (92):** `_resetConfigCache`, `_resetContainerPollers`, `_resetSdkRegistry`, `Agent`, `AgentErrors`, `ApiError`, `ApiNamespace`, `AppSetting`, `AppSettingErrors`, `AsyncJob`, `AsyncJobErrors`, `Auth`, `AuthErrors`, `BedrockModels`, `BLOCKS_AUTH_PREFIX`, `BLOCKS_RPC_PREFIX`, `blocksError`, `brandBlocksError`, `buildingBlockParent`, `clearRouteRegistry`, `Compute`, `computeScopeFullId`, `config`, `CronJob`, `CronJobErrors`, `customOauth2`, `Dashboard`, `DashboardErrors`, `Database`, `DatabaseErrors`, `DEFAULT_API_ERROR_NAME`, `dispatchJobToWorker`, `DistributedDatabase`, `DistributedDatabaseErrors`, `DistributedTable`, `DistributedTableErrors`, `EmailClient`, `EmailErrors`, `FileBucket`, `FileBucketErrors`, `fromExisting`, `getAllSdkIdentifiers`, `getCachedConfigValue`, `getConfig`, `getConfigSync`, `getContainerComputeId`, `getDeploymentType`, `getRegisteredRoutes`, `getSdkIdentifiers`, `github`, `hasAuthError`, `installClientUserAgent`, `isAuthError`, `isBlocksError`, `isConfig`, `isContainerRuntime`, `isJobWorker`, `isManagedValue`, `isSecret`, `isWireSafeError`, `KnowledgeBase`, `KnowledgeBaseErrors`, `KVStore`, `KVStoreErrors`, `LAMBDA_MAX_TIMEOUT_SECONDS`, `loadConfigToProcessEnv`, `lockRouteRegistry`, `Logger`, `LoggingErrors`, `matchRoute`, `Metrics`, `MetricsErrors`, `OllamaModels`, `preloadConfig`, `RawRoute`, `RawRouteErrors`, `Realtime`, `registerContainerPoller`, `registerRoute`, `registerSdkIdentifiers`, `relayOrigin`, `resolvePerInstanceConcurrency`, `runContainer`, `runJobWorker`, `Scope`, `secret`, `Secret`, `SecretErrors`, `sql`, `stubIdp`, `Tracer`, `unlockRouteRegistry`

**Types (286):** `AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`, `AdminDisabledOnBuiltin`, `AdminGetterOf`, `AdminGrants`, `AdminOff`, `AdminOffOnBuiltin`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `AgentConfig`, `AgentResult`, `AgentStreamChunk`, `AgentTool`, `AmazonProvider`, `AnnotationValue`, `AnySignInNextStep`, `ApiHandler`, `ApiMethods`, `ApiNamespaceOptions`, `AppleCredentials`, `AppleProvider`, `AppSettingOptions`, `AppSettingRef`, `AsyncJobBaseOptions`, `AsyncJobContext`, `AsyncJobOptions`, `AsyncJobState`, `AsyncJobStatus`, `AsyncJobTransition`, `AttrOf`, `AuthAction`, `AuthActionInput`, `AuthActionInputOf`, `AuthBase`, `AuthClient`, `AuthClientEnvironment`, `AuthClientOptions`, `AuthCommonOptions`, `AuthenticatedUser`, `AuthErrorName`, `AuthField`, `AuthFlowOf`, `AuthMockOptions`, `AuthOptions`, `AuthSession`, `AuthShape`, `AuthState`, `AuthStateApiOf`, `AuthStateUser`, `AuthStore`, `AuthUser`, `AuthUserOf`, `BatchSubmitResult`, `BearerAuthOptions`, `BlocksAuth`, `BlocksContext`, `BrowserAuthSession`, `BrowserUser`, `BuildingBlockMeta`, `BuiltinAuthMockOptions`, `BuiltinAuthOptions`, `BuiltinProvider`, `BuiltinUserOptions`, `ChildLogger`, `ChunkingConfig`, `ChunkingStrategy`, `CodeDeliveryDetails`, `CodeDeliveryFn`, `CodeDeliveryPurpose`, `CognitoAuthMockOptions`, `CognitoAuthOptions`, `CognitoOidcProvider`, `CognitoProvider`, `CompletePasskeyRegistrationResult`, `ComputeOptions`, `ComputeProps`, `ComputeType`, `ConditionalDeleteOptions`, `ConditionalWriteOptions`, `ConfigValue`, `ConfirmSignInChallengeOf`, `ConfirmSignInInputOf`, `ConfirmSignInOptions`, `ConfirmSignUpResult`, `ContainerComputeOptions`, `ContainerPollerHandle`, `ContainerPollerStarter`, `ContainerScaling`, `ContainerSize`, `CorsRule`, `CronJobEvent`, `CronJobOptions`, `CustomAttrNames`, `CustomOauth2Options`, `DashboardOptions`, `DatabaseOptions`, `DefaultToolContext`, `DeploymentType`, `DeviceRecord`, `DirectOidcProvider`, `DisconnectReason`, `DistributedDatabaseOptions`, `DistributedTableOptions`, `DTDeleteOptions`, `DTExternalKmsKeyRef`, `DTGetOptions`, `DTPutOptions`, `DTQueryOptions`, `DTScanOptions`, `EmailMessage`, `EmailOptions`, `EmailPasswordEnabled`, `EmailPasswordOptions`, `EmailSenderOptions`, `EmitOptions`, `ERROR_EMAIL_is_not_in_mfa_types`, `ERROR_federateVia_replaced_by_store`, `ERROR_needs_store_cognito`, `ERROR_replaced_by_providers`, `ERROR_SMS_is_not_in_mfa_types`, `ERROR_TOTP_is_not_in_mfa_types`, `ExternalDatabaseRef`, `ExternalKmsKeyRef`, `ExternalMetricsRef`, `ExternalTableRef`, `ExternalUserPoolRef`, `FacebookProvider`, `FBExternalBucketRef`, `FBExternalKmsKeyRef`, `FBPutOptions`, `FBScanOptions`, `FederatedActionNameOf`, `FederatedIdentity`, `FederationGate`, `FileBucketOptions`, `FileContent`, `FileInfo`, `GetAuthSessionOptions`, `GetChannelOptions`, `GetUrlOptions`, `GitHubOptions`, `GoogleProvider`, `GroupAdmin`, `GroupOf`, `HasFederatedProvider`, `HostedUiOptions`, `HttpMethod`, `JobDispatchResult`, `JobWorkerReply`, `JobWorkerRequest`, `JWT`, `KnowledgeBaseAgentTool`, `KnowledgeBaseAgentToolOptions`, `KnowledgeBaseAgentToolResult`, `KnowledgeBaseOptions`, `KVPutOptions`, `KVStoreOptions`, `LifecycleAdmin`, `LifecycleRule`, `LogEntry`, `LoggingOptions`, `LogLevel`, `ManagedValue`, `MappedClaims`, `MetadataFilter`, `MetricConfig`, `MetricDatum`, `MetricResolution`, `MetricsBBRef`, `MetricsEmitter`, `MetricsOptions`, `MetricsSource`, `MetricUnit`, `MfaEnabled`, `MfaFactor`, `MfaGate`, `MfaMode`, `MfaModeEnabled`, `MfaModeOf`, `MfaModeOfOption`, `MfaOptions`, `MfaPreference`, `MfaPreferenceInput`, `MfaSetting`, `MfaStepNameOf`, `MfaTypeOf`, `ModelConfig`, `NoSharedMethodNames`, `OAuth2Provider`, `OAuthCredentials`, `ObjectLockOptions`, `OidcProviderBase`, `OnStubAuthorize`, `PasskeyDescription`, `PasskeyGate`, `PasskeyOptions`, `PasskeysEnabled`, `PasskeysOptionOf`, `PasswordGate`, `PasswordPolicy`, `PreferredChallenge`, `ProfileAttributeMapping`, `ProtectedApi`, `ProtectHandlers`, `ProtectOptions`, `ProviderCommon`, `ProviderIdOf`, `ProviderSecretRef`, `PutUrlOptions`, `RawRouteOptions`, `ReadAttrOf`, `ReadValidationMode`, `RealtimeChannel`, `RealtimeSubscription`, `RedirectOptions`, `RegisteredRoute`, `RelayOrigin`, `RequireAuthOptions`, `ResetPasswordResult`, `RetrieveOptions`, `RetrieveResult`, `RunContainerOptions`, `SamlProvider`, `ScalingSignal`, `ScopeOptions`, `ScopeParent`, `SecretOptions`, `SecretReadOptions`, `SecretRef`, `SecretValue`, `SecretVersion`, `SecretVersionInfo`, `Segment`, `SendBatchResult`, `SendResult`, `ServerlessComputeOptions`, `SessionOptions`, `SetPasswordOptions`, `SignInNextStep`, `SignInOptions`, `SignInRedirectResult`, `SignInResult`, `SignInStepNameOf`, `SignInUrlOptions`, `SignInWithRedirectInput`, `SignOutOptions`, `SignOutResult`, `SignUpOptions`, `SignUpResult`, `SocialProvider`, `SocialProviderId`, `SourceConfig`, `SqlQuery`, `StandardUserAttributeKey`, `StartPasskeyRegistrationResult`, `StreamOptions`, `StubAuthorizeRequest`, `StubIdpOptions`, `StubIdpSettings`, `StubProvider`, `StubUser`, `SubmitOptions`, `SubscribeOptions`, `TableKey`, `TableKeyConfig`, `TokenUsage`, `ToolCallRecord`, `ToolDefinition`, `ToolFactory`, `ToolHandlerArgs`, `ToolsConfig`, `TotpEnabled`, `TracerOptions`, `Transaction`, `TransactionOptions`, `UpdateAttributeOutcome`, `UserAttribute`, `UserCandidate`, `UserPoolOptions`, `ValueKind`, `WaitUntilCompleteOptions`, `WaitUntilSyncedOptions`

## `@aws-blocks/blocks/client`

Browser, Node, and the `tsx -C browser` e2e tests.

**Values (10):** `ApiError`, `ApiNamespaceClient`, `blocksError`, `brandBlocksError`, `DEFAULT_API_ERROR_NAME`, `hasAuthError`, `isBlocksError`, `isWireSafeError`, `registerMiddleware`, `Scope`

**Types (6):** `ApiHandler`, `ApiNamespaceClientOptions`, `BlocksContext`, `BlocksMiddleware`, `BlocksRequest`, `ScopeOptions`

## `@aws-blocks/blocks/ui`

Browser (returns DOM nodes).

**Values (15):** `AccountMenuBar`, `AuthenticatedContent`, `Authenticator`, `authOverrides`, `broadcastAuthChange`, `createAuthClient`, `getAuthStateSnapshot`, `injectTheme`, `MfaSettings`, `onAuthChange`, `StatusMessage`, `submitAuthAction`, `subscribeAuthState`, `THEME_CSS`, `THEME_STYLE_ID`

**Types (26):** `AuthActionFields`, `AuthActionInput`, `AuthActionName`, `AuthActionOverride`, `AuthActionPayloadMap`, `AuthClient`, `AuthClientEnvironment`, `AuthClientOptions`, `AuthenticatorOptions`, `AuthFederatedActionName`, `AuthFieldOverride`, `AuthMfaSetting`, `AuthNextStepName`, `AuthStateApi`, `AuthTypedActionOverride`, `AuthTypedAuthenticatorOptions`, `AuthUserOf`, `BrowserAuthSession`, `BrowserUser`, `MfaSettingsOptions`, `SignInRedirectResult`, `SignInWithRedirectInput`, `SignOutResult`, `StatusKind`, `StatusMessageHandle`, `StatusMessageOptions`

## `@aws-blocks/blocks/theme`

Browser.

**Values (3):** `injectTheme`, `THEME_CSS`, `THEME_STYLE_ID`

**Types (0):** —

## `@aws-blocks/blocks/server`

Server-side rendering (Node).

**Values (3):** `clearCookieProviders`, `registerCookieProvider`, `withAuth`

**Types (1):** `CookieProvider`

## `@aws-blocks/blocks/utils`

Node tests and scripts, including the templates’ `tsx -C browser` e2e tests (no `browser` condition, so it resolves the same everywhere).

**Values (5):** `createTestClient`, `getLastAuthCode`, `installCookieJar`, `isServerRunning`, `totpCodeFor`

**Types (1):** `GetLastAuthCodeOptions`

## `@aws-blocks/blocks/cdk`

CDK synth (`cdk-blocks deploy` / `sandbox`), in your app’s CDK entry file `aws-blocks/index.cdk.ts`.

**Values (129):** `__PIPELINE_STAGE_SCOPE__`, `_resetConfigCache`, `_resetContainerPollers`, `_resetSdkRegistry`, `Agent`, `AgentErrors`, `ApiError`, `ApiNamespace`, `AppSetting`, `AppSettingErrors`, `AsyncJob`, `AsyncJobErrors`, `Auth`, `AuthErrors`, `BedrockModels`, `BLOCKS_AUTH_PREFIX`, `BLOCKS_CONFIG_PARAMETER_PREFIX`, `BLOCKS_RPC_PREFIX`, `BLOCKS_SECRET_PARAMETER_PREFIX`, `BlocksBackend`, `blocksConfigParameterName`, `blocksError`, `blocksNodejsBundling`, `BlocksPresets`, `blocksSecretParameterName`, `BlocksStack`, `brandBlocksError`, `buildingBlockParent`, `BuildingBlockScope`, `clearRouteRegistry`, `Compute`, `computeScopeFullId`, `config`, `CronJob`, `CronJobErrors`, `customOauth2`, `Dashboard`, `DashboardErrors`, `Database`, `DatabaseErrors`, `DEFAULT_API_ERROR_NAME`, `DEFAULT_CONFIG_PARAMETER_PREFIX`, `DEFAULT_NODE_RUNTIME`, `DEFAULT_SECRET_PARAMETER_PREFIX`, `DeployStage`, `dispatchJobToWorker`, `DistributedDatabase`, `DistributedDatabaseErrors`, `DistributedTable`, `DistributedTableErrors`, `EmailClient`, `EmailErrors`, `ensureApiGatewayAccount`, `EventSourceMapping`, `FileBucket`, `FileBucketErrors`, `finalizeConfigRegistry`, `finalizeDashboards`, `finalizeTracing`, `fromExisting`, `getAllSdkIdentifiers`, `getBlocksRoot`, `getBlocksRootId`, `getCachedConfigValue`, `getConfig`, `getConfigDeployment`, `getConfigLocation`, `getConfigSync`, `getContainerComputeId`, `getDeploymentType`, `getOrCreateOnRoot`, `getRegisteredConfigValue`, `getRegisteredRoutes`, `getSdkIdentifiers`, `getSharedGatewayUrl`, `getVpcContext`, `github`, `hasAuthError`, `Hosting`, `HostingPresets`, `installClientUserAgent`, `isAuthError`, `isBlocksError`, `isConfig`, `isContainerRuntime`, `isJobWorker`, `isManagedValue`, `isSandboxContext`, `isSecret`, `isWireSafeError`, `KnowledgeBase`, `KnowledgeBaseErrors`, `KVStore`, `KVStoreErrors`, `LAMBDA_MAX_TIMEOUT_SECONDS`, `loadConfigToProcessEnv`, `lockRouteRegistry`, `Logger`, `LoggingErrors`, `matchRoute`, `Metrics`, `MetricsErrors`, `OllamaModels`, `Pipeline`, `preloadConfig`, `RawRoute`, `RawRouteErrors`, `Realtime`, `registerConfig`, `registerContainerPoller`, `registerDashboardFinalizer`, `registerRoute`, `registerSdkIdentifiers`, `registerTracer`, `relayOrigin`, `resolvePerInstanceConcurrency`, `runContainer`, `runJobWorker`, `SandboxDisableDeletionProtection`, `Scope`, `secret`, `Secret`, `SecretErrors`, `SHARED_HANDLER_TIMEOUT_SECONDS`, `sql`, `stubIdp`, `synthGuard`, `Tracer`, `unlockRouteRegistry`

**Types (314):** `AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`, `AdminDisabledOnBuiltin`, `AdminGetterOf`, `AdminGrants`, `AdminOff`, `AdminOffOnBuiltin`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `AgentConfig`, `AgentResult`, `AgentStreamChunk`, `AgentTool`, `AmazonProvider`, `AnnotationValue`, `AnySignInNextStep`, `ApiHandler`, `ApiMethods`, `ApiNamespaceConstructor`, `ApiNamespaceOptions`, `ApiWafOptions`, `AppleCredentials`, `AppleProvider`, `AppSettingOptions`, `AppSettingRef`, `AsyncAPI`, `AsyncJobBaseOptions`, `AsyncJobContext`, `AsyncJobOptions`, `AsyncJobState`, `AsyncJobStatus`, `AsyncJobTransition`, `AttrOf`, `AuthAction`, `AuthActionInput`, `AuthActionInputOf`, `AuthBase`, `AuthClient`, `AuthClientEnvironment`, `AuthClientOptions`, `AuthCommonOptions`, `AuthenticatedUser`, `AuthErrorName`, `AuthField`, `AuthFlowOf`, `AuthMockOptions`, `AuthOptions`, `AuthSession`, `AuthShape`, `AuthState`, `AuthStateApiOf`, `AuthStateUser`, `AuthStore`, `AuthUser`, `AuthUserOf`, `BatchSubmitResult`, `BearerAuthOptions`, `BlocksAuth`, `BlocksBackendProps`, `BlocksContext`, `BlocksDefaults`, `BlocksSecretsStore`, `BlocksStackApi`, `BlocksStackProps`, `BlocksThrottling`, `BlocksVpcOptions`, `BranchConfig`, `BrowserAuthSession`, `BrowserUser`, `BuildingBlockMeta`, `BuiltinAuthMockOptions`, `BuiltinAuthOptions`, `BuiltinProvider`, `BuiltinUserOptions`, `ChildLogger`, `ChunkingConfig`, `ChunkingStrategy`, `CloudFrontOverRouterFrontDoor`, `CodeDeliveryDetails`, `CodeDeliveryFn`, `CodeDeliveryPurpose`, `CognitoAuthMockOptions`, `CognitoAuthOptions`, `CognitoOidcProvider`, `CognitoProvider`, `CompletePasskeyRegistrationResult`, `ComputeConfig`, `ComputeOptions`, `ComputeProps`, `ComputeType`, `ConditionalDeleteOptions`, `ConditionalWriteOptions`, `ConfigValue`, `ConfirmSignInChallengeOf`, `ConfirmSignInInputOf`, `ConfirmSignInOptions`, `ConfirmSignUpResult`, `ContainerComputeOptions`, `ContainerPollerHandle`, `ContainerPollerStarter`, `ContainerScaling`, `ContainerSize`, `CoreBlocksBackendProps`, `CoreBlocksStackProps`, `CorsRule`, `CronJobEvent`, `CronJobOptions`, `CustomAttrNames`, `CustomOauth2Options`, `DashboardOptions`, `DatabaseOptions`, `DefaultToolContext`, `DeploymentType`, `DeployStageProps`, `DeviceRecord`, `DirectOidcProvider`, `DisconnectReason`, `DistributedDatabaseOptions`, `DistributedTableOptions`, `DTDeleteOptions`, `DTExternalKmsKeyRef`, `DTGetOptions`, `DTPutOptions`, `DTQueryOptions`, `DTScanOptions`, `EmailMessage`, `EmailOptions`, `EmailPasswordEnabled`, `EmailPasswordOptions`, `EmailSenderOptions`, `EmitOptions`, `ERROR_EMAIL_is_not_in_mfa_types`, `ERROR_federateVia_replaced_by_store`, `ERROR_needs_store_cognito`, `ERROR_replaced_by_providers`, `ERROR_SMS_is_not_in_mfa_types`, `ERROR_TOTP_is_not_in_mfa_types`, `ExternalDatabaseRef`, `ExternalKmsKeyRef`, `ExternalMetricsRef`, `ExternalTableRef`, `ExternalUserPoolRef`, `FacebookProvider`, `FBExternalBucketRef`, `FBExternalKmsKeyRef`, `FBPutOptions`, `FBScanOptions`, `FederatedActionNameOf`, `FederatedIdentity`, `FederationGate`, `FileBucketOptions`, `FileContent`, `FileInfo`, `FrameworkType`, `GetAuthSessionOptions`, `GetChannelOptions`, `GetUrlOptions`, `GitHubOptions`, `GoogleProvider`, `GroupAdmin`, `GroupOf`, `HasFederatedProvider`, `HostedUiOptions`, `HostingDomainConfig`, `HostingPreset`, `HostingProps`, `HostingWafConfig`, `HttpMethod`, `JobDispatchResult`, `JobWorkerReply`, `JobWorkerRequest`, `JWT`, `KnowledgeBaseAgentTool`, `KnowledgeBaseAgentToolOptions`, `KnowledgeBaseAgentToolResult`, `KnowledgeBaseOptions`, `KVPutOptions`, `KVStoreOptions`, `LifecycleAdmin`, `LifecycleRule`, `LogEntry`, `LoggingOptions`, `LogLevel`, `ManagedValue`, `MappedClaims`, `MetadataFilter`, `MetricConfig`, `MetricDatum`, `MetricResolution`, `MetricsBBRef`, `MetricsEmitter`, `MetricsOptions`, `MetricsSource`, `MetricUnit`, `MfaEnabled`, `MfaFactor`, `MfaGate`, `MfaMode`, `MfaModeEnabled`, `MfaModeOf`, `MfaModeOfOption`, `MfaOptions`, `MfaPreference`, `MfaPreferenceInput`, `MfaSetting`, `MfaStepNameOf`, `MfaTypeOf`, `ModelConfig`, `NoSharedMethodNames`, `OAuth2Provider`, `OAuthCredentials`, `ObjectLockOptions`, `OidcProviderBase`, `OnStubAuthorize`, `PasskeyDescription`, `PasskeyGate`, `PasskeyOptions`, `PasskeysEnabled`, `PasskeysOptionOf`, `PasswordGate`, `PasswordPolicy`, `PipelineProps`, `PipelineSourceConfig`, `PipelineStageConfig`, `PipelineSynthConfig`, `PreferredChallenge`, `ProfileAttributeMapping`, `ProtectedApi`, `ProtectHandlers`, `ProtectOptions`, `ProviderCommon`, `ProviderIdOf`, `ProviderSecretRef`, `PutUrlOptions`, `RawRouteOptions`, `ReadAttrOf`, `ReadValidationMode`, `RealtimeChannel`, `RealtimeSubscription`, `RedirectOptions`, `RegisteredRoute`, `RelayOrigin`, `RequireAuthOptions`, `ResetPasswordResult`, `RetrieveOptions`, `RetrieveResult`, `RunContainerOptions`, `SamlProvider`, `ScalingSignal`, `ScopeOptions`, `ScopeParent`, `SecretOptions`, `SecretReadOptions`, `SecretRef`, `SecretValue`, `SecretVersion`, `SecretVersionInfo`, `Segment`, `SendBatchResult`, `SendResult`, `ServerlessComputeOptions`, `SessionOptions`, `SetPasswordOptions`, `SignInNextStep`, `SignInOptions`, `SignInRedirectResult`, `SignInResult`, `SignInStepNameOf`, `SignInUrlOptions`, `SignInWithRedirectInput`, `SignOutOptions`, `SignOutResult`, `SignUpOptions`, `SignUpResult`, `SocialProvider`, `SocialProviderId`, `SourceConfig`, `SqlQuery`, `StandardUserAttributeKey`, `StartPasskeyRegistrationResult`, `StreamOptions`, `StubAuthorizeRequest`, `StubIdpOptions`, `StubIdpSettings`, `StubProvider`, `StubUser`, `SubmitOptions`, `SubnetRole`, `SubscribeOptions`, `TableKey`, `TableKeyConfig`, `TokenUsage`, `ToolCallRecord`, `ToolDefinition`, `ToolFactory`, `ToolHandlerArgs`, `ToolsConfig`, `TotpEnabled`, `TracerOptions`, `Transaction`, `TransactionOptions`, `UpdateAttributeOutcome`, `UserAttribute`, `UserCandidate`, `UserPoolOptions`, `ValueKind`, `VpcContext`, `VpcRequirements`, `WaitUntilCompleteOptions`, `WaitUntilSyncedOptions`

## `@aws-blocks/blocks/lambda-handler`

The deployed Lambda.

**Values (13):** `_resetCorsPatterns`, `buildEventUrl`, `classifyEvent`, `computeHttpDeadlineMs`, `createLambdaHandler`, `EventSourceMapping`, `isApiGatewayHttpEvent`, `isLoopbackForwardedHost`, `parseCorsPatterns`, `requestBaseUrl`, `requestClientUserAgent`, `requestCookies`, `TransientConfigError`

**Types (2):** `EventClass`, `LambdaContext`

## `@aws-blocks/blocks/scripts`

Node: the `cdk-blocks` CLI, and your CDK entry file.

**Values (60):** `appendDeployHistoryRecord`, `BACKEND_OUTPUT_KEY`, `buildAndSendEvent`, `buildDashboardUrl`, `classifyError`, `createDeployRecorder`, `dashboard`, `DEFAULT_DASHBOARD_PORT`, `deploy`, `DEPLOY_HISTORY_FILE`, `deployedStackExists`, `describeDeploymentCredentials`, `destroy`, `destroySandbox`, `ensureSecrets`, `findFreePort`, `generateClientCode`, `generateSpec`, `getGitSha`, `getSandboxId`, `getStackId`, `getStackName`, `isBlocksProject`, `isPortFree`, `listConfig`, `listSecrets`, `loadEnvFile`, `loadProductionEnv`, `log`, `NativeCatalogError`, `NoFreePortError`, `openConsole`, `OUTPUTS_DIR`, `OUTPUTS_FILE`, `outputsFileIn`, `parseDashboardArgs`, `PREVIEW_MODE_CONTEXT`, `PROJECT_MARKER`, `readAwsIdentity`, `readNativeDeclarations`, `removeConfig`, `removeSecret`, `resolveDeploymentTarget`, `resolveProject`, `runConfigCli`, `runSecretCli`, `runStopCli`, `runTypegenCli`, `setConfig`, `setSecret`, `startDevServer`, `startSandbox`, `stopDevServer`, `stopMessage`, `summarizeError`, `telemetry`, `trackCommand`, `validateSpec`, `writeClientCode`, `writeSpec`

**Types (30):** `AwsIdentity`, `BuildAndSendEventOptions`, `CommandName`, `CommandState`, `ConsoleOptions`, `DashboardArgs`, `DashboardCommand`, `DashboardOptions`, `DeployedStack`, `DeployedStackOptions`, `DeployHistoryRecord`, `DeploymentCredentials`, `DeploymentTarget`, `DeployOptions`, `DeployRecorder`, `DestroyOptions`, `DevServerOptions`, `NativeDeclarationInput`, `NativeDeclarationSource`, `OutputsStage`, `PortScanOptions`, `ProjectResolution`, `ReadAwsIdentityOptions`, `ResolvedProject`, `ResolveProjectOptions`, `SandboxOptions`, `SpecGenerationOptions`, `SpecValidationError`, `StopResult`, `TelemetryOptions`

## Not for app code

| Entry | What it is |
|---|---|
| `@aws-blocks/blocks/vendorize` | the `cdk-blocks vendorize` implementation |
| `@aws-blocks/blocks/docs/*` | these docs |
