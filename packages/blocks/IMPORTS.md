# What to import from where

<!-- Generated from the built packages by `npm run update:imports`; do not edit. -->

Every app-facing entry of `aws-cdk-blocks`, where it runs, and every name it exports. A **value** can be imported normally; a **type** only with `import type` (or `import { type … }`).

The rule that matters most: **code that runs under the `browser` condition gets only the client-safe values from the root `aws-cdk-blocks`**. That covers browser bundles and the templates' e2e tests (`npm run test:e2e` runs `tsx -C browser`). The root is the backend entry and the only one with a `browser` condition, under which it resolves to its browser build: every block's error constants, the error class and matchers, and the blocks' pure helpers, so `import { isBlocksError, KVStoreErrors } from 'aws-cdk-blocks'` is the same line in backend and browser code (see [Root values in browser code](#root-values-in-browser-code)). The Building Block classes and the server and CDK helpers are not in that build; browser code uses `import type` for their types. Every subpath resolves to the same file everywhere: browser code imports the API client runtime from `/client`, the UI from `/ui` and `/theme`, and the e2e tests also from `/utils`. The typed client of your own API is `import { api } from 'cdk-blocks'` (your backend module), not an `aws-cdk-blocks` entry.

| Entry | Runs in | For |
|---|---|---|
| `aws-cdk-blocks` | Backend (`cdk-blocks/`): local dev, Lambda, CDK synth. | Every Building Block and the core backend API. It is the only entry with a `browser` condition: there (browser bundles, and the templates’ `npm run test:e2e`, which runs `tsx -C browser`) it resolves to its browser build, which has only the values listed under [Root values in browser code](#root-values-in-browser-code), though `import type` of every type still works. Under `--conditions=cdk` it resolves to the `/cdk` build. |
| `aws-cdk-blocks/client` | Browser, Node, and the `tsx -C browser` e2e tests. | Core’s browser-safe values: errors and their matchers, and the API client runtime the generated `cdk-blocks` client uses. |
| `aws-cdk-blocks/ui` | Browser (returns DOM nodes). | The auth UI components and the auth state store. |
| `aws-cdk-blocks/theme` | Browser. | The stylesheet the UI components use. |
| `aws-cdk-blocks/server` | Server-side rendering (Node). | Forwarding the browser’s cookies to API calls made during SSR. |
| `aws-cdk-blocks/utils` | Node tests and scripts, including the templates’ `tsx -C browser` e2e tests (no `browser` condition, so it resolves the same everywhere). | Test helpers: a cookie jar for `fetch`, per-user test clients, local auth codes, TOTP codes. |
| `aws-cdk-blocks/cdk` | CDK synth (`npm run deploy` / `npm run sandbox`), in your app’s CDK entry file `cdk-blocks/index.cdk.ts`. | The synth-time build: what the generated `cdk-blocks/index.cdk.ts` imports (`BlocksStack`, `BlocksPresets`, `Hosting`, `HostingPresets`), plus every block’s CDK construct. |
| `aws-cdk-blocks/lambda-handler` | The deployed Lambda. | `createLambdaHandler`, which the generated `cdk-blocks/index.handler.ts` imports. |
| `aws-cdk-blocks/scripts` | Node: the package task runner, and your CDK entry file. | Task plumbing (dev server, deploy, sandbox). The generated `cdk-blocks/index.cdk.ts` imports `getStackName` from it, and the amplify template’s `cdk-blocks/scripts/generate-client.ts` imports `generateClientCode`. |

## Root values in browser code

Code run under the `browser` condition can import these root values, from the entry in the second column. An error can also be matched by its name string: `isBlocksError(e, 'ConditionalCheckFailedException')`.

| Name | In browser code, import from |
|---|---|
| `AgentErrors` | `aws-cdk-blocks` |
| `ApiError` | `aws-cdk-blocks`, `aws-cdk-blocks/client` |
| `AppSettingErrors` | `aws-cdk-blocks` |
| `AsyncJobErrors` | `aws-cdk-blocks` |
| `AuthErrors` | `aws-cdk-blocks` |
| `BedrockModels` | `aws-cdk-blocks` |
| `blocksError` | `aws-cdk-blocks`, `aws-cdk-blocks/client` |
| `brandBlocksError` | `aws-cdk-blocks`, `aws-cdk-blocks/client` |
| `CronJobErrors` | `aws-cdk-blocks` |
| `customOauth2` | `aws-cdk-blocks` |
| `DashboardErrors` | `aws-cdk-blocks` |
| `DatabaseErrors` | `aws-cdk-blocks` |
| `DEFAULT_API_ERROR_NAME` | `aws-cdk-blocks`, `aws-cdk-blocks/client` |
| `EmailErrors` | `aws-cdk-blocks` |
| `FileBucketErrors` | `aws-cdk-blocks` |
| `github` | `aws-cdk-blocks` |
| `hasAuthError` | `aws-cdk-blocks`, `aws-cdk-blocks/client` |
| `isAuthError` | `aws-cdk-blocks` |
| `isBlocksError` | `aws-cdk-blocks`, `aws-cdk-blocks/client` |
| `isWireSafeError` | `aws-cdk-blocks`, `aws-cdk-blocks/client` |
| `KnowledgeBaseErrors` | `aws-cdk-blocks` |
| `KVStoreErrors` | `aws-cdk-blocks` |
| `LoggingErrors` | `aws-cdk-blocks` |
| `MetricsErrors` | `aws-cdk-blocks` |
| `OllamaModels` | `aws-cdk-blocks` |
| `RealtimeErrors` | `aws-cdk-blocks` |
| `relayOrigin` | `aws-cdk-blocks` |
| `Scope` | `aws-cdk-blocks`, `aws-cdk-blocks/client` |
| `SecretErrors` | `aws-cdk-blocks` |
| `stubIdp` | `aws-cdk-blocks` |

The other root values (the Building Block classes, `sql`, `RawRouteErrors`, CDK and server helpers) have no browser export; browser code uses `import type` for their types.

## `aws-cdk-blocks`

Backend (`cdk-blocks/`): local dev, Lambda, CDK synth.

**Values (92):** `_resetConfigCache`, `_resetContainerPollers`, `_resetSdkRegistry`, `Agent`, `AgentErrors`, `ApiError`, `ApiNamespace`, `AppSetting`, `AppSettingErrors`, `AsyncJob`, `AsyncJobErrors`, `Auth`, `AuthErrors`, `BedrockModels`, `BLOCKS_AUTH_PREFIX`, `BLOCKS_RPC_PREFIX`, `blocksError`, `brandBlocksError`, `buildingBlockParent`, `canonicalBlocksPath`, `clearRouteRegistry`, `Compute`, `computeScopeFullId`, `config`, `CronJob`, `CronJobErrors`, `customOauth2`, `Dashboard`, `DashboardErrors`, `Database`, `DatabaseCluster`, `DatabaseErrors`, `DEFAULT_API_ERROR_NAME`, `dispatchJobToWorker`, `EmailClient`, `EmailErrors`, `FileBucket`, `FileBucketErrors`, `getAllSdkIdentifiers`, `getCachedConfigValue`, `getConfig`, `getConfigSync`, `getContainerComputeId`, `getDeploymentType`, `getRegisteredRoutes`, `getSdkIdentifiers`, `github`, `hasAuthError`, `installClientUserAgent`, `isAuthError`, `isBlocksError`, `isConfig`, `isContainerRuntime`, `isJobWorker`, `isManagedValue`, `isSecret`, `isWireSafeError`, `KnowledgeBase`, `KnowledgeBaseErrors`, `KVStore`, `KVStoreErrors`, `LAMBDA_MAX_TIMEOUT_SECONDS`, `LegacyDatabaseCluster`, `LegacyKVStore`, `loadConfigToProcessEnv`, `lockRouteRegistry`, `Logger`, `LoggingErrors`, `matchRoute`, `Metrics`, `MetricsErrors`, `OllamaModels`, `preloadConfig`, `RawRoute`, `RawRouteErrors`, `Realtime`, `RealtimeErrors`, `registerContainerPoller`, `registerRoute`, `registerSdkIdentifiers`, `relayOrigin`, `resolvePerInstanceConcurrency`, `runContainer`, `runJobWorker`, `Scope`, `secret`, `Secret`, `SecretErrors`, `sql`, `stubIdp`, `Tracer`, `unlockRouteRegistry`

**Types (306):** `AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`, `AdminDisabledOnBuiltin`, `AdminGetterOf`, `AdminGrants`, `AdminOff`, `AdminOffOnBuiltin`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `AgentConfig`, `AgentResult`, `AgentStreamChunk`, `AgentTool`, `AmazonProvider`, `AnnotationValue`, `AnySignInNextStep`, `ApiHandler`, `ApiMethods`, `ApiNamespaceConstructor`, `ApiNamespaceOptions`, `AppleCredentials`, `AppleProvider`, `AppSettingOptions`, `AppSettingRef`, `AsyncAPI`, `AsyncJobBaseOptions`, `AsyncJobContext`, `AsyncJobOptions`, `AsyncJobState`, `AsyncJobStatus`, `AsyncJobTransition`, `AttrOf`, `AuthAction`, `AuthActionInput`, `AuthActionInputOf`, `AuthAuditRecord`, `AuthBase`, `AuthClient`, `AuthClientEnvironment`, `AuthClientOptions`, `AuthCommonOptions`, `AuthenticatedUser`, `AuthErrorName`, `AuthField`, `AuthFlowOf`, `AuthMockOptions`, `AuthOptions`, `AuthSession`, `AuthShape`, `AuthState`, `AuthStateApiOf`, `AuthStateUser`, `AuthStore`, `AuthUser`, `AuthUserOf`, `BatchSubmitResult`, `BearerAuthOptions`, `BlocksAuth`, `BlocksContext`, `BrowserAuthSession`, `BrowserUser`, `BuildingBlockMeta`, `BuiltinAuthMockOptions`, `BuiltinAuthOptions`, `BuiltinProvider`, `BuiltinUserOptions`, `ChildLogger`, `ChunkingConfig`, `ChunkingStrategy`, `ClusterKind`, `ClusterType`, `CodeDeliveryDetails`, `CodeDeliveryFn`, `CodeDeliveryPurpose`, `CognitoAuthMockOptions`, `CognitoAuthOptions`, `CognitoOidcProvider`, `CognitoProvider`, `CompletePasskeyRegistrationResult`, `ComputeOptions`, `ComputeProps`, `ComputeType`, `ConditionalDeleteOptions`, `ConditionalWriteOptions`, `ConfigValue`, `ConfirmSignInChallengeOf`, `ConfirmSignInInputOf`, `ConfirmSignInOptions`, `ConfirmSignUpResult`, `ConnectionStringSource`, `ContainerComputeOptions`, `ContainerPollerHandle`, `ContainerPollerStarter`, `ContainerScaling`, `ContainerSize`, `CorsRule`, `CronJobEvent`, `CronJobOptions`, `CustomAttrNames`, `CustomOauth2Options`, `DashboardOptions`, `DataApiOptions`, `DatabaseClusterOptions`, `DatabaseOptions`, `DefaultToolContext`, `DeploymentType`, `DeviceRecord`, `DirectOidcProvider`, `DisconnectReason`, `EmailMessage`, `EmailOptions`, `EmailPasswordEnabled`, `EmailPasswordOptions`, `EmailSenderOptions`, `EmitOptions`, `Entry`, `ERROR_EMAIL_is_not_in_mfa_types`, `ERROR_federateVia_replaced_by_store`, `ERROR_needs_store_cognito`, `ERROR_replaced_by_providers`, `ERROR_SMS_is_not_in_mfa_types`, `ERROR_TOTP_is_not_in_mfa_types`, `ExistingClusterOptions`, `ExistingClusterRef`, `ExternalKmsKeyRef`, `ExternalMetricsRef`, `ExternalTableRef`, `ExternalUserPoolRef`, `FacebookProvider`, `FBExternalBucketRef`, `FBExternalKmsKeyRef`, `FBPutOptions`, `FBScanOptions`, `FederatedActionNameOf`, `FederatedIdentity`, `FederationGate`, `FileBucketOptions`, `FileContent`, `FileInfo`, `GetAuthSessionOptions`, `GetChannelOptions`, `GetOptions`, `GetUrlOptions`, `GitHubOptions`, `GoogleProvider`, `GroupAdmin`, `GroupOf`, `HasFederatedProvider`, `HostedUiOptions`, `HttpMethod`, `IndexConfig`, `JobDispatchResult`, `JobWorkerReply`, `JobWorkerRequest`, `JWT`, `KeyConfig`, `KeyOf`, `KnowledgeBaseAgentTool`, `KnowledgeBaseAgentToolOptions`, `KnowledgeBaseAgentToolResult`, `KnowledgeBaseOptions`, `KVPutOptions`, `KVScanOptions`, `KVStoreOptions`, `LegacyDatabaseClusterOptions`, `LegacyKVStoreDeleteOptions`, `LegacyKVStoreOptions`, `LegacyKVStorePutOptions`, `LifecycleAdmin`, `LifecycleRule`, `LogEntry`, `LoggingOptions`, `LogLevel`, `ManagedValue`, `MappedClaims`, `MetadataFilter`, `MetricConfig`, `MetricDatum`, `MetricResolution`, `MetricsBBRef`, `MetricsEmitter`, `MetricsOptions`, `MetricsSource`, `MetricUnit`, `MfaEnabled`, `MfaFactor`, `MfaGate`, `MfaMode`, `MfaModeEnabled`, `MfaModeOf`, `MfaModeOfOption`, `MfaOptions`, `MfaPreference`, `MfaPreferenceInput`, `MfaSetting`, `MfaStepNameOf`, `MfaTypeOf`, `ModelConfig`, `NoSharedMethodNames`, `OAuth2Provider`, `OAuthCredentials`, `ObjectLockOptions`, `OidcClientApiOf`, `OidcClientDescriptor`, `OidcClientHandle`, `OidcProviderBase`, `OidcProviderConfig`, `OnStubAuthorize`, `PasskeyDescription`, `PasskeyGate`, `PasskeyOptions`, `PasskeysEnabled`, `PasskeysOptionOf`, `PasswordGate`, `PasswordPolicy`, `PreferredChallenge`, `ProfileAttributeMapping`, `ProtectedApi`, `ProtectHandlers`, `ProtectOptions`, `ProviderCommon`, `ProviderIdOf`, `ProviderSecretRef`, `PutBatchEntry`, `PutUrlOptions`, `QueryOptions`, `RawRouteOptions`, `ReadAttrOf`, `ReadValidationMode`, `RealtimeChannel`, `RealtimeSubscription`, `RedirectOptions`, `RegisteredRoute`, `RelayOrigin`, `RequireAuthOptions`, `ResetPasswordResult`, `Results`, `RetrieveOptions`, `RetrieveResult`, `RunContainerOptions`, `SamlProvider`, `ScalingSignal`, `ScopedDatabase`, `ScopeOptions`, `ScopeParent`, `SecretOptions`, `SecretReadOptions`, `SecretRef`, `SecretValue`, `SecretVersion`, `SecretVersionInfo`, `Segment`, `SendBatchResult`, `SendResult`, `ServerlessComputeOptions`, `SessionOptions`, `SetPasswordOptions`, `SignInNextStep`, `SignInOptions`, `SignInRedirectResult`, `SignInResult`, `SignInStepNameOf`, `SignInUrlOptions`, `SignInWithRedirectInput`, `SignOutOptions`, `SignOutResult`, `SignUpOptions`, `SignUpResult`, `SocialProvider`, `SocialProviderId`, `SortCondition`, `SourceConfig`, `SqlQuery`, `StandardUserAttributeKey`, `StartPasskeyRegistrationResult`, `StreamOptions`, `StubAuthorizeRequest`, `StubIdpOptions`, `StubIdpSettings`, `StubProvider`, `StubUser`, `SubmitOptions`, `SubscribeOptions`, `TokenUsage`, `ToolCallRecord`, `ToolDefinition`, `ToolFactory`, `ToolHandlerArgs`, `ToolsConfig`, `TotpEnabled`, `TracerOptions`, `Transaction`, `TransactionOptions`, `UpdateAttributeOutcome`, `UserAttribute`, `UserCandidate`, `UserPoolOptions`, `ValueKind`, `ValueOf`, `WaitUntilCompleteOptions`, `WaitUntilSyncedOptions`, `Where`

## `aws-cdk-blocks/client`

Browser, Node, and the `tsx -C browser` e2e tests.

**Values (10):** `ApiError`, `ApiNamespaceClient`, `blocksError`, `brandBlocksError`, `DEFAULT_API_ERROR_NAME`, `hasAuthError`, `isBlocksError`, `isWireSafeError`, `registerMiddleware`, `Scope`

**Types (6):** `ApiHandler`, `ApiNamespaceClientOptions`, `BlocksContext`, `BlocksMiddleware`, `BlocksRequest`, `ScopeOptions`

## `aws-cdk-blocks/ui`

Browser (returns DOM nodes).

**Values (15):** `AccountMenuBar`, `AuthenticatedContent`, `Authenticator`, `authOverrides`, `broadcastAuthChange`, `createAuthClient`, `getAuthStateSnapshot`, `injectTheme`, `MfaSettings`, `onAuthChange`, `StatusMessage`, `submitAuthAction`, `subscribeAuthState`, `THEME_CSS`, `THEME_STYLE_ID`

**Types (26):** `AuthActionFields`, `AuthActionInput`, `AuthActionName`, `AuthActionOverride`, `AuthActionPayloadMap`, `AuthClient`, `AuthClientEnvironment`, `AuthClientOptions`, `AuthenticatorOptions`, `AuthFederatedActionName`, `AuthFieldOverride`, `AuthMfaSetting`, `AuthNextStepName`, `AuthStateApi`, `AuthTypedActionOverride`, `AuthTypedAuthenticatorOptions`, `AuthUserOf`, `BrowserAuthSession`, `BrowserUser`, `MfaSettingsOptions`, `SignInRedirectResult`, `SignInWithRedirectInput`, `SignOutResult`, `StatusKind`, `StatusMessageHandle`, `StatusMessageOptions`

## `aws-cdk-blocks/theme`

Browser.

**Values (3):** `injectTheme`, `THEME_CSS`, `THEME_STYLE_ID`

**Types (0):** —

## `aws-cdk-blocks/server`

Server-side rendering (Node).

**Values (3):** `clearCookieProviders`, `registerCookieProvider`, `withAuth`

**Types (2):** `CookieProvider`, `WithAuthOptions`

## `aws-cdk-blocks/utils`

Node tests and scripts, including the templates’ `tsx -C browser` e2e tests (no `browser` condition, so it resolves the same everywhere).

**Values (5):** `createTestClient`, `getLastAuthCode`, `installCookieJar`, `isServerRunning`, `totpCodeFor`

**Types (1):** `GetLastAuthCodeOptions`

## `aws-cdk-blocks/cdk`

CDK synth (`npm run deploy` / `npm run sandbox`), in your app’s CDK entry file `cdk-blocks/index.cdk.ts`.

**Values (129):** `__PIPELINE_STAGE_SCOPE__`, `_resetConfigCache`, `_resetContainerPollers`, `_resetSdkRegistry`, `Agent`, `AgentErrors`, `ApiError`, `ApiNamespace`, `AppSetting`, `AppSettingErrors`, `AsyncJob`, `AsyncJobErrors`, `Auth`, `AuthErrors`, `BedrockModels`, `BLOCKS_AUTH_PREFIX`, `BLOCKS_CONFIG_PARAMETER_PREFIX`, `BLOCKS_RPC_PREFIX`, `BLOCKS_SECRET_PARAMETER_PREFIX`, `BlocksBackend`, `blocksConfigParameterName`, `blocksError`, `blocksNodejsBundling`, `BlocksPresets`, `blocksSecretParameterName`, `BlocksStack`, `brandBlocksError`, `buildingBlockParent`, `BuildingBlockScope`, `canonicalBlocksPath`, `clearRouteRegistry`, `Compute`, `computeScopeFullId`, `config`, `CronJob`, `CronJobErrors`, `customOauth2`, `Dashboard`, `DashboardErrors`, `Database`, `DatabaseCluster`, `DatabaseErrors`, `DEFAULT_API_ERROR_NAME`, `DEFAULT_CONFIG_PARAMETER_PREFIX`, `DEFAULT_NODE_RUNTIME`, `DEFAULT_SECRET_PARAMETER_PREFIX`, `DeployStage`, `dispatchJobToWorker`, `EmailClient`, `EmailErrors`, `ensureApiGatewayAccount`, `EventSourceMapping`, `FileBucket`, `FileBucketErrors`, `finalizeConfigRegistry`, `finalizeDashboards`, `finalizeTracing`, `getAllSdkIdentifiers`, `getBlocksRoot`, `getBlocksRootId`, `getCachedConfigValue`, `getConfig`, `getConfigDeployment`, `getConfigLocation`, `getConfigSync`, `getContainerComputeId`, `getDeploymentType`, `getOrCreateOnRoot`, `getRegisteredConfigValue`, `getRegisteredRoutes`, `getSdkIdentifiers`, `getSharedGatewayUrl`, `getVpcContext`, `github`, `hasAuthError`, `Hosting`, `HostingPresets`, `installClientUserAgent`, `isAuthError`, `isBlocksError`, `isConfig`, `isContainerRuntime`, `isJobWorker`, `isManagedValue`, `isSandboxContext`, `isSecret`, `isWireSafeError`, `KnowledgeBase`, `KnowledgeBaseErrors`, `KVStore`, `KVStoreErrors`, `LAMBDA_MAX_TIMEOUT_SECONDS`, `LegacyDatabaseCluster`, `LegacyKVStore`, `loadConfigToProcessEnv`, `lockRouteRegistry`, `Logger`, `LoggingErrors`, `matchRoute`, `Metrics`, `MetricsErrors`, `OllamaModels`, `Pipeline`, `preloadConfig`, `RawRoute`, `RawRouteErrors`, `Realtime`, `RealtimeErrors`, `registerConfig`, `registerContainerPoller`, `registerDashboardFinalizer`, `registerRoute`, `registerSdkIdentifiers`, `registerTracer`, `relayOrigin`, `resolvePerInstanceConcurrency`, `runContainer`, `runJobWorker`, `SandboxDisableDeletionProtection`, `Scope`, `secret`, `Secret`, `SecretErrors`, `SHARED_HANDLER_TIMEOUT_SECONDS`, `sql`, `stubIdp`, `synthGuard`, `Tracer`, `unlockRouteRegistry`

**Types (332):** `AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`, `AdminDisabledOnBuiltin`, `AdminGetterOf`, `AdminGrants`, `AdminOff`, `AdminOffOnBuiltin`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `AgentConfig`, `AgentResult`, `AgentStreamChunk`, `AgentTool`, `AmazonProvider`, `AnnotationValue`, `AnySignInNextStep`, `ApiHandler`, `ApiMethods`, `ApiNamespaceConstructor`, `ApiNamespaceOptions`, `ApiWafOptions`, `AppleCredentials`, `AppleProvider`, `AppSettingOptions`, `AppSettingRef`, `AsyncAPI`, `AsyncJobBaseOptions`, `AsyncJobContext`, `AsyncJobOptions`, `AsyncJobState`, `AsyncJobStatus`, `AsyncJobTransition`, `AttrOf`, `AuthAction`, `AuthActionInput`, `AuthActionInputOf`, `AuthAuditRecord`, `AuthBase`, `AuthClient`, `AuthClientEnvironment`, `AuthClientOptions`, `AuthCommonOptions`, `AuthenticatedUser`, `AuthErrorName`, `AuthField`, `AuthFlowOf`, `AuthMockOptions`, `AuthOptions`, `AuthSession`, `AuthShape`, `AuthState`, `AuthStateApiOf`, `AuthStateUser`, `AuthStore`, `AuthUser`, `AuthUserOf`, `BatchSubmitResult`, `BearerAuthOptions`, `BlocksAuth`, `BlocksBackendProps`, `BlocksContext`, `BlocksDefaults`, `BlocksSecretsStore`, `BlocksStackApi`, `BlocksStackProps`, `BlocksThrottling`, `BlocksVpcOptions`, `BranchConfig`, `BrowserAuthSession`, `BrowserUser`, `BuildingBlockMeta`, `BuiltinAuthMockOptions`, `BuiltinAuthOptions`, `BuiltinProvider`, `BuiltinUserOptions`, `ChildLogger`, `ChunkingConfig`, `ChunkingStrategy`, `CloudFrontOverRouterFrontDoor`, `ClusterKind`, `ClusterType`, `CodeDeliveryDetails`, `CodeDeliveryFn`, `CodeDeliveryPurpose`, `CognitoAuthMockOptions`, `CognitoAuthOptions`, `CognitoOidcProvider`, `CognitoProvider`, `CompletePasskeyRegistrationResult`, `ComputeConfig`, `ComputeOptions`, `ComputeProps`, `ComputeType`, `ConditionalDeleteOptions`, `ConditionalWriteOptions`, `ConfigValue`, `ConfirmSignInChallengeOf`, `ConfirmSignInInputOf`, `ConfirmSignInOptions`, `ConfirmSignUpResult`, `ConnectionStringSource`, `ContainerComputeOptions`, `ContainerPollerHandle`, `ContainerPollerStarter`, `ContainerScaling`, `ContainerSize`, `CoreBlocksBackendProps`, `CoreBlocksStackProps`, `CorsRule`, `CronJobEvent`, `CronJobOptions`, `CustomAttrNames`, `CustomOauth2Options`, `DashboardOptions`, `DataApiOptions`, `DatabaseClusterOptions`, `DatabaseOptions`, `DefaultToolContext`, `DeploymentType`, `DeployStageProps`, `DeviceRecord`, `DirectOidcProvider`, `DisconnectReason`, `EmailMessage`, `EmailOptions`, `EmailPasswordEnabled`, `EmailPasswordOptions`, `EmailSenderOptions`, `EmitOptions`, `Entry`, `ERROR_EMAIL_is_not_in_mfa_types`, `ERROR_federateVia_replaced_by_store`, `ERROR_needs_store_cognito`, `ERROR_replaced_by_providers`, `ERROR_SMS_is_not_in_mfa_types`, `ERROR_TOTP_is_not_in_mfa_types`, `ExistingClusterOptions`, `ExistingClusterRef`, `ExternalKmsKeyRef`, `ExternalMetricsRef`, `ExternalTableRef`, `ExternalUserPoolRef`, `FacebookProvider`, `FBExternalBucketRef`, `FBExternalKmsKeyRef`, `FBPutOptions`, `FBScanOptions`, `FederatedActionNameOf`, `FederatedIdentity`, `FederationGate`, `FileBucketOptions`, `FileContent`, `FileInfo`, `FrameworkType`, `GetAuthSessionOptions`, `GetChannelOptions`, `GetOptions`, `GetUrlOptions`, `GitHubOptions`, `GoogleProvider`, `GroupAdmin`, `GroupOf`, `HasFederatedProvider`, `HostedUiOptions`, `HostingDomainConfig`, `HostingPreset`, `HostingProps`, `HostingWafConfig`, `HttpMethod`, `IndexConfig`, `JobDispatchResult`, `JobWorkerReply`, `JobWorkerRequest`, `JWT`, `KeyConfig`, `KeyOf`, `KnowledgeBaseAgentTool`, `KnowledgeBaseAgentToolOptions`, `KnowledgeBaseAgentToolResult`, `KnowledgeBaseOptions`, `KVPutOptions`, `KVScanOptions`, `KVStoreOptions`, `LegacyDatabaseClusterOptions`, `LegacyKVStoreDeleteOptions`, `LegacyKVStoreOptions`, `LegacyKVStorePutOptions`, `LifecycleAdmin`, `LifecycleRule`, `LogEntry`, `LoggingOptions`, `LogLevel`, `ManagedValue`, `MappedClaims`, `MetadataFilter`, `MetricConfig`, `MetricDatum`, `MetricResolution`, `MetricsBBRef`, `MetricsEmitter`, `MetricsOptions`, `MetricsSource`, `MetricUnit`, `MfaEnabled`, `MfaFactor`, `MfaGate`, `MfaMode`, `MfaModeEnabled`, `MfaModeOf`, `MfaModeOfOption`, `MfaOptions`, `MfaPreference`, `MfaPreferenceInput`, `MfaSetting`, `MfaStepNameOf`, `MfaTypeOf`, `ModelConfig`, `NoSharedMethodNames`, `OAuth2Provider`, `OAuthCredentials`, `ObjectLockOptions`, `OidcClientApiOf`, `OidcClientDescriptor`, `OidcClientHandle`, `OidcProviderBase`, `OidcProviderConfig`, `OnStubAuthorize`, `PasskeyDescription`, `PasskeyGate`, `PasskeyOptions`, `PasskeysEnabled`, `PasskeysOptionOf`, `PasswordGate`, `PasswordPolicy`, `PipelineProps`, `PipelineSourceConfig`, `PipelineStageConfig`, `PipelineSynthConfig`, `PreferredChallenge`, `ProfileAttributeMapping`, `ProtectedApi`, `ProtectHandlers`, `ProtectOptions`, `ProviderCommon`, `ProviderIdOf`, `ProviderSecretRef`, `PutBatchEntry`, `PutUrlOptions`, `QueryOptions`, `RawRouteOptions`, `ReadAttrOf`, `ReadValidationMode`, `RealtimeChannel`, `RealtimeSubscription`, `RedirectOptions`, `RegisteredRoute`, `RelayOrigin`, `RequireAuthOptions`, `ResetPasswordResult`, `Results`, `RetrieveOptions`, `RetrieveResult`, `RunContainerOptions`, `SamlProvider`, `ScalingSignal`, `ScopedDatabase`, `ScopeOptions`, `ScopeParent`, `SecretOptions`, `SecretReadOptions`, `SecretRef`, `SecretValue`, `SecretVersion`, `SecretVersionInfo`, `Segment`, `SendBatchResult`, `SendResult`, `ServerlessComputeOptions`, `SessionOptions`, `SetPasswordOptions`, `SignInNextStep`, `SignInOptions`, `SignInRedirectResult`, `SignInResult`, `SignInStepNameOf`, `SignInUrlOptions`, `SignInWithRedirectInput`, `SignOutOptions`, `SignOutResult`, `SignUpOptions`, `SignUpResult`, `SocialProvider`, `SocialProviderId`, `SortCondition`, `SourceConfig`, `SqlQuery`, `StandardUserAttributeKey`, `StartPasskeyRegistrationResult`, `StreamOptions`, `StubAuthorizeRequest`, `StubIdpOptions`, `StubIdpSettings`, `StubProvider`, `StubUser`, `SubmitOptions`, `SubnetRole`, `SubscribeOptions`, `TokenUsage`, `ToolCallRecord`, `ToolDefinition`, `ToolFactory`, `ToolHandlerArgs`, `ToolsConfig`, `TotpEnabled`, `TracerOptions`, `Transaction`, `TransactionOptions`, `UpdateAttributeOutcome`, `UserAttribute`, `UserCandidate`, `UserPoolOptions`, `ValueKind`, `ValueOf`, `VpcContext`, `VpcRequirements`, `WaitUntilCompleteOptions`, `WaitUntilSyncedOptions`, `Where`

## `aws-cdk-blocks/lambda-handler`

The deployed Lambda.

**Values (13):** `_resetCorsPatterns`, `buildEventUrl`, `classifyEvent`, `computeHttpDeadlineMs`, `createLambdaHandler`, `EventSourceMapping`, `isApiGatewayHttpEvent`, `isLoopbackForwardedHost`, `parseCorsPatterns`, `requestBaseUrl`, `requestClientUserAgent`, `requestCookies`, `TransientConfigError`

**Types (2):** `EventClass`, `LambdaContext`

## `aws-cdk-blocks/scripts`

Node: the package task runner, and your CDK entry file.

**Values (61):** `appendDeployHistoryRecord`, `BACKEND_OUTPUT_KEY`, `buildAndSendEvent`, `buildDashboardUrl`, `classifyError`, `CLOSED_OUTPUT_CODES`, `createDeployRecorder`, `dashboard`, `DEFAULT_DASHBOARD_PORT`, `deploy`, `DEPLOY_HISTORY_FILE`, `deployedStackExists`, `describeDeploymentCredentials`, `destroy`, `destroySandbox`, `findFreePort`, `generateClientCode`, `generateSpec`, `getGitSha`, `getSandboxId`, `getStackId`, `getStackName`, `ignoreClosedOutput`, `isBlocksProject`, `isPortFree`, `isStopWarning`, `listConfig`, `listSecrets`, `loadEnvFile`, `loadProductionEnv`, `log`, `NativeCatalogError`, `NoFreePortError`, `openConsole`, `OUTPUTS_DIR`, `OUTPUTS_FILE`, `outputsFileIn`, `parseDashboardArgs`, `PREVIEW_MODE_CONTEXT`, `PROJECT_MARKER`, `readAwsIdentity`, `readNativeDeclarations`, `removeConfig`, `removeSecret`, `resolveDeploymentTarget`, `resolveProject`, `runConfigCli`, `runSecretCli`, `runStopCli`, `runTypegenCli`, `setConfig`, `setSecret`, `startDevServer`, `startSandbox`, `stopDevServer`, `stopMessage`, `summarizeError`, `trackCommand`, `validateSpec`, `writeClientCode`, `writeSpec`

**Types (29):** `AwsIdentity`, `BuildAndSendEventOptions`, `CommandName`, `CommandState`, `ConsoleOptions`, `DashboardArgs`, `DashboardCommand`, `DashboardOptions`, `DeployedStack`, `DeployedStackOptions`, `DeployHistoryRecord`, `DeploymentCredentials`, `DeploymentTarget`, `DeployOptions`, `DeployRecorder`, `DestroyOptions`, `DevServerOptions`, `NativeDeclarationInput`, `NativeDeclarationSource`, `OutputsStage`, `PortScanOptions`, `ProjectResolution`, `ReadAwsIdentityOptions`, `ResolvedProject`, `ResolveProjectOptions`, `SandboxOptions`, `SpecGenerationOptions`, `SpecValidationError`, `StopResult`

## Not for app code

| Entry | What it is |
|---|---|
| `aws-cdk-blocks/run` | the side-effect entry point invoked by app package scripts |
| `aws-cdk-blocks/vendorize` | the `npm run vendorize` implementation |
| `aws-cdk-blocks/docs/*` | these docs |
