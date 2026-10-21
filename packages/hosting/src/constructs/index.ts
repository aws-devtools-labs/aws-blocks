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
export {
	WEB_FUNCTION_SUPPORTED_REGIONS,
	WebFunctionConstruct,
	type WebFunctionConstructProps,
	type WebFunctionOptions,
} from './web_function_construct.js';
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
// ── Front doors ───────────────────────────────────────────────────────────────
// The free-form front-door interface: a door is `defineFrontDoor({ service,
// build(scope, input) })`. AWS Blocks calls `build` once at synth with the
// DoorInput and uses the `url` it returns as the app's address. CloudFront is
// the default door; ALB, API Gateway, S3-website (`'none'`) and the stacked
// CloudFront edge are the other built-ins, written the same way.
export {
	type ApiOrigin,
	type AssetsOrigin,
	type DoorApp,
	type DoorFeatures,
	type DoorHeaderRule,
	type DoorInput,
	type DoorOrigin,
	type DoorOrigins,
	type DoorRedirect,
	type DoorRoute,
	type DoorUpstream,
	defineFrontDoor,
	type FrontDoor,
	type FrontDoorResult,
	type ImageOrigin,
	type ServerOrigin,
	type UploadContext,
} from './front_door.js';
export type { OriginHandle } from './layer.js';
// The `frontDoor` prop: each door kind with its own typed `features` (exactly
// the settings that door implements), and the merge of the deprecated
// top-level props into them.
export {
	type AlbDoorFeatures,
	type AlbDoorOptions,
	type ApiGatewayDoorFeatures,
	type ApiGatewayDoorOptions,
	type CloudFrontDoorFeatures,
	type CloudFrontDoorOptions,
	type CustomDoorFeatures,
	type CustomDoorOptions,
	FRONT_DOOR_SETTINGS,
	type FrontDoorAlias,
	type FrontDoorAliases,
	type FrontDoorKind,
	type FrontDoorSettingName,
	type FrontDoorSettings,
	type HostingFrontDoor,
	type HostingGeoRestriction,
	type HostingLoggingConfig,
	type HostingMonitoringConfig,
	type ResolvedFrontDoor,
	resolveFrontDoorFeatures,
	type StackedDoorFeatures,
} from './front_door_options.js';
// `cf.*` — CloudFront helpers for a free-form door. They also record what they
// wired, which is what the routes/API wiring check reads.
export { cf, type CloudFrontHelpers } from './cf_helpers.js';
// The route plan the built-in doors render (service-agnostic data).
export type {
	BackendIngress,
	BackendOrigin,
	BackendPlan,
	HostingPlan,
	HeaderRule,
	Origin,
	PlanPolicies,
	RedirectRule,
	ReleasePlan,
	RouteTable,
} from '../plan/types.js';
export { buildHostingPlan, ORIGIN_IDS } from '../plan/hosting-plan.js';
export { cloudFrontDoor, type CloudFrontDoorInput, type CloudFrontDoorResult } from './cloudfront_door.js';
export {
	cloudFrontEdgeDoor,
	type CloudFrontEdgeDoorInput,
	type CloudFrontEdgeDoorResult,
} from './cloudfront_edge_door.js';
export { albDoor, type AlbDoorInput, type AlbDoorResult } from './alb_door.js';
export { AlbConstruct, type AlbConstructProps } from './alb_construct.js';
export { apiGatewayDoor, type ApiGatewayDoorInput } from './apigw_door.js';
export { ApiGatewayConstruct, type ApiGatewayConstructProps } from './apigw_construct.js';
export { s3WebsiteDoor, type S3WebsiteDoorInput } from './s3_website_door.js';
export { S3WebsiteConstruct, type S3WebsiteConstructProps } from './s3_website_construct.js';
// Security-headers ResponseHeadersPolicy factory — reused by the CloudFront edge
// of the composed CF → ALB door (parity with the default CloudFront door).
export { createSecurityHeadersPolicy, type SecurityHeadersProps } from './security_headers.js';
// ── BYO custom-front-door building blocks ─────────────────────────────────────
// So a customer-authored door composes the door's hard parts (private-asset
// access, same-origin API base, route ordering) instead of reimplementing them,
// and tests itself before an app synthesizes it.
export { assertDoorConformance, type DoorConformanceOptions } from './conformance.js';
export { buildFrontDoor, type BuildFrontDoorOptions, type FrontDoorBuild } from './custom_door.js';
export { generateAlbAssetProxyCode } from './alb_asset_proxy.js';
export { generateApiGwAssetProxyCode } from './apigw_asset_proxy.js';
// The asset proxies' options (prefix strip, SPA fallback, and the app's
// redirects, header rules and error pages — `input.app.*`), and the
// environment a proxy function needs (`ASSET_BUCKET`, `ASSET_KEY_PREFIX`).
export { type AssetProxyOptions, assetProxyEnvironment } from './asset_proxy_core.js';
// The ALB door's same-origin API forwarder (a Lambda target relaying to the
// backend, multi-value headers, the app's header rules).
export { generateAlbApiProxyCode } from './alb_api_proxy.js';
// The origin-verify header a CloudFront-only ALB requires (the stacked door's
// router); a BYO door that stacks CloudFront over its own ALB can use the same.
export { CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST, ORIGIN_VERIFY_HEADER } from './alb_construct.js';
export { backendBaseUrl } from './apigw_routes.js';
export { coalesceRoutes, routeSpecificity } from '../plan/route-table.js';
