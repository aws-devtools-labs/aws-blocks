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
