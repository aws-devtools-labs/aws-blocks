export { FrameworkAdapterFn, NextjsAdapterOptions } from './adapters/index.js';
export {
	generateBuildId,
	generateBuildIdFunctionCode,
	HostingConstruct,
	HostingConstructProps,
	HostingDomainConfig,
	HostingWafConfig,
} from './constructs/hosting_construct.js';
export type { SkewProtectionConfig } from './constructs/skew_protection.js';
export { HostingError } from './hosting_error.js';
export {
	CacheConfig,
	ComputeResource,
	CustomHeader,
	DeployManifest,
	ImageConfig,
	MiddlewareConfig,
	Redirect,
	Rewrite,
	RouteBehavior,
} from './manifest/types.js';
export {
	DEFAULT_SECRET_PARAMETER_PREFIX,
	DEFAULT_SECRET_STORE,
	isSecret,
	SECRET_BRAND,
	type SecretOptions,
	type SecretStore,
	type SecretValue,
	secret,
	secretEnvVarName,
	secretFallbackEnvVarName,
	secretParameterName,
	secretStoreLocator,
} from './secret.js';
// Shared secret CLI core (set/list/remove) — consumers wrap with their own label/prefix/store.
export {
	listSecrets,
	removeSecret,
	runSecretCli,
	type SecretCliOptions,
	setSecret,
} from './secret-cli.js';
// CDK-aware resolution engine — marker → infra wiring. Used by core.Hosting,
// a standalone hosting app, and (synth helpers) pipeline.
export {
	_setSynthSecretFetcher,
	collectSynthSecretKeys,
	type DomainNameInput,
	type EnvValue,
	partitionEnvironment,
	resolveDomainNames,
	resolveSecretsAtSynth,
	type SecretFetcher,
	type SecretResolveOptions,
	wireRuntimeSecret,
} from './secret-resolve.js';
export { _resetSecretCache, _setSecretFetcher, getSecret } from './secret-runtime.js';
export { FrameworkType, HostingProps, HostingResources } from './types.js';
