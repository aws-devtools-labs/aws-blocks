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
// Two intent functions (I1, Approach B): secret() → Secrets Manager, config() → SSM.
export {
	type ConfigValue,
	cacheTtlEnvVarName,
	config,
	DEFAULT_CONFIG_PARAMETER_PREFIX,
	DEFAULT_SECRET_PARAMETER_PREFIX,
	defaultPrefixForKind,
	envVarNameForKind,
	fallbackEnvVarName,
	isConfig,
	isManagedValue,
	isSecret,
	MANAGED_BRAND,
	type ManagedValue,
	type SecretStore,
	type SecretValue,
	secret,
	secretStoreLocator,
	type ValueKind,
} from './secret.js';
// Shared CLI core (secret/config × set/list/remove) — consumers wrap with a fixed kind + label/prefix.
export {
	listValues,
	removeValue,
	runValueCli,
	setValue,
	type ValueCliOptions,
} from './secret-cli.js';
// CDK-aware resolution engine — marker/BYO → infra wiring. Used by core.Hosting,
// a standalone hosting app, and (synth helpers) pipeline.
export {
	_setSynthSecretFetcher,
	type ByoBinding,
	collectSynthMarkers,
	type DomainNameInput,
	type EnvValue,
	isCdkParameter,
	isCdkSecret,
	type KindStoreOptions,
	partitionEnvironment,
	resolveDomainNames,
	resolveSecretsAtSynth,
	type SecretFetcher,
	type StoreConfig,
	wireByo,
	wireManagedValue,
} from './secret-resolve.js';
export {
	type ConfigKey,
	getConfig,
	getSecret,
	type HostingConfigRegistry,
	type HostingSecretRegistry,
	type SecretKey,
} from './secret-runtime.js';
export {
	DEFAULT_TYPEGEN_INCLUDE,
	DEFAULT_TYPEGEN_MODULE,
	DEFAULT_TYPEGEN_MODULES,
	DEFAULT_TYPEGEN_OUT,
	type DynamicCallSite,
	type GenerateOptions,
	generateHostingValuesDts,
	renderHostingValuesDts,
	runTypegenCli,
	type ScanResult,
	scanValueKeys,
	type TypegenCliDeps,
	type TypegenOptions,
	type TypegenResult,
	type WatchOptions,
	watchHostingValues,
} from './secret-typegen.js';
export { FrameworkType, HostingProps, HostingResources } from './types.js';
