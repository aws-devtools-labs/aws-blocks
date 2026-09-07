// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/hosting/constructs` — the CDK entry point: the `HostingConstruct`
 * plus the CDK-aware resolution engine (marker/BYO → infra wiring). Kept off the
 * package's `.` entry so the value API there (`secret`/`config`/`getSecret`/
 * `getConfig`) stays CDK-free and can be imported into an SSR/runtime bundle
 * without pulling in `aws-cdk-lib`.
 *
 * @module
 */

export { FrameworkAdapterFn, NextjsAdapterOptions } from '../adapters/index.js';
export {
	generateBuildId,
	generateBuildIdFunctionCode,
	HostingConstruct,
	HostingConstructProps,
	HostingDomainConfig,
	HostingWafConfig,
} from './hosting_construct.js';
export type { SkewProtectionConfig } from './skew_protection.js';
export { HostingError } from '../hosting_error.js';
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
} from '../manifest/types.js';
// CDK-aware resolution engine — marker/BYO → infra wiring. Used by core.Hosting,
// a standalone hosting app, and (synth helpers) pipeline.
export {
	_setSynthExistsChecker,
	_setSynthSecretFetcher,
	assertMarkersExistAtSynth,
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
	type SynthExistsChecker,
	wireByo,
	wireManagedValue,
} from '../secret-resolve.js';
export { FrameworkType, HostingProps, HostingResources } from '../types.js';
// Front-door adapters (the swappable-door seam). CloudFront is the default door;
// ALB is the first non-CloudFront door.
export type {
	AdapterContext,
	CapabilityId,
	CapabilityPlan,
	FrontDoorAdapter,
	FrontDoorResult,
	Origin,
	RouteTable,
	SupportTier,
} from '../plan/types.js';
export { buildCapabilityPlan, ORIGIN_IDS } from '../plan/capability-plan.js';
export { negotiate, requiredCapabilities } from '../plan/negotiate.js';
export { CloudFrontAdapter } from './cloudfront_adapter.js';
export { AlbAdapter, type AlbRenderContext } from './alb_adapter.js';
export { AlbConstruct, type AlbConstructProps } from './alb_construct.js';
export { ApiGatewayAdapter, type ApiGatewayRenderContext } from './apigw_adapter.js';
export { ApiGatewayConstruct, type ApiGatewayConstructProps } from './apigw_construct.js';
export { FunctionUrlAdapter, type FunctionUrlRenderContext } from './function_url_adapter.js';
export { FunctionUrlConstruct, type FunctionUrlConstructProps } from './function_url_construct.js';
