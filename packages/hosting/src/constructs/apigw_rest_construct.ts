/**
 * API Gateway REST API front-door construct — a regional, HTTPS-by-default,
 * no-CloudFront door. The REST sibling of {@link ApiGatewayConstruct} (HTTP API
 * v2), selected by `frontDoor: { kind: 'apiGateway', api: 'rest' }`.
 *
 * Why REST (vs HTTP API v2): it invokes the SSR/image Lambdas with
 * `lambda:InvokeFunction` (no Function-URL SigV4 body-hash mismatch on
 * POST/PUT), it is the same flavor already used to front SSR behind CloudFront,
 * and it can natively `HTTP_PROXY` an external HTTPS URL for the same-origin
 * backend. All request/response bodies are treated as binary (a catch-all
 * `binaryMediaTypes`) so the base64 asset-proxy bodies decode correctly.
 *
 * Routing (most-specific-resource wins in API Gateway):
 *   - `/` + `{proxy+}`            → SSR server Lambda when present, else the
 *     asset-proxy (SPA fallback on miss) — the catch-all default.
 *   - each static route pattern   → the asset-proxy Lambda (streams from the
 *     PRIVATE S3 bucket) — the REST analogue of CloudFront's S3+OAC.
 *   - the image prefix            → the image-opt Lambda.
 *   - every API path (`/aws-blocks/*` plus the backend's raw routes, or
 *     `/aws-blocks/api/<ns>/*`) → an `HTTP_PROXY` integration straight to the
 *     backend (same-origin; no forwarder Lambda).
 *
 * SSR streams: a streaming server is integrated with
 * `ResponseTransferMode.STREAM`, exactly as the CloudFront door's SSR origin.
 *
 * Addressing: a bare `execute-api` URL carries the `/prod` stage path, which an
 * app's root-relative links miss, so `HostingConstruct` requires a custom
 * domain (its base-path mapping serves the stage at the domain root).
 *
 * The app's redirects (a resource per source → the asset proxy), per-pattern
 * response headers and error pages are applied by the asset proxy with the
 * CloudFront door's semantics; responses routed straight to the server, the
 * image function or the backend don't pass through it, which synth reports
 * (`@aws-blocks/hosting:DoorRulesNotApplied`).
 *
 * Trade-offs: no global edge cache, no per-route response headers on
 * server/API responses (synth names them), no skew protection, a ~10 MB
 * payload cap, a ~29 s integration timeout. Unsupported settings are a type
 * error in `frontDoor.features` and a synth error through the deprecated
 * top-level props.
 */
import { Annotations, CfnOutput, Duration } from 'aws-cdk-lib';
import {
	BasePathMapping,
	ConnectionType,
	DomainName,
	EndpointType,
	Integration,
	IntegrationType,
	LambdaIntegration,
	Resource,
	ResponseTransferMode,
	RestApi,
	SecurityPolicy,
} from 'aws-cdk-lib/aws-apigateway';
import { Code, Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { AaaaRecord, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayDomain } from 'aws-cdk-lib/aws-route53-targets';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { HostingPlan } from '../plan/types.js';
import { generateApiGwAssetProxyCode } from './apigw_asset_proxy.js';
import { warnRulesNotApplied } from './proxy_rules.js';
import { type ApiGwCustomDomain, resolveApiGwDomain } from './apigw_domain.js';
import {
	APIGW_DEFAULT_ROUTE_QUOTA,
	apiPathToRoutes,
	backendBaseUrl,
	DEFAULT_API_PATHS,
	globToProxyPath,
	hasInnerWildcard,
} from './apigw_routes.js';
import { warnInexpressibleRoutes } from './apigw_construct.js';
import { assetProxyEnvironment } from './asset_proxy_core.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

export type ApiGatewayRestConstructProps = {
	plan: HostingPlan;
	bucket: IBucket;
	computeFunctions?: Map<string, IFunction>;
	serverComputeName?: string;
	imageComputeName?: string;
	/** Custom domain(s) — a regional cert + DomainName + base-path mapping + Route 53 alias. */
	domain?: ApiGwCustomDomain;
	/**
	 * Every path pattern the single-compute (`'*'`) backend serves — the
	 * `DoorInput.origins.api.paths`: `/aws-blocks/*` plus the backend's raw
	 * routes. Each becomes a resource proxied to the same path on the backend.
	 * @default ['/aws-blocks/*']
	 */
	apiPaths?: readonly string[];
	/**
	 * Whether the server streams its response (`DoorInput.origins.server.streaming`).
	 * A streaming server is integrated with `ResponseTransferMode.STREAM`; a
	 * buffered one with a plain proxy integration.
	 * @default true
	 */
	serverStreaming?: boolean;
	/**
	 * The app's error pages, as object keys under the build prefix: the asset
	 * proxy serves `notFound` (404) for a missing file and `serverError` (500)
	 * when S3 fails.
	 */
	errorPages?: { notFound?: string; serverError?: string };
};

export class ApiGatewayRestConstruct extends Construct {
	readonly api: RestApi;
	readonly url: string;
	/**
	 * The static asset-proxy Lambda. Its `ASSET_KEY_PREFIX` environment names
	 * the build, so it is the door's switch to a new build (its `cutover`).
	 */
	readonly assetProxy: LambdaFunction;

	constructor(scope: Construct, id: string, props: ApiGatewayRestConstructProps) {
		super(scope, id);
		const { plan, bucket } = props;
		const buildId = plan.release.buildId;
		const compute = props.computeFunctions ?? new Map<string, IFunction>();
		const serverFn = props.serverComputeName ? compute.get(props.serverComputeName) : undefined;
		const imageFn = props.imageComputeName ? compute.get(props.imageComputeName) : undefined;

		// Asset-proxy Lambda → private S3. Payload-format-agnostic: the REST API
		// delivers a v1 event (`event.path`), which the shared generator reads.
		//
		// Why a Lambda and not a native S3 service integration? REST API *can*
		// integrate S3 directly (`arn:aws:apigateway:…:s3:path/{bucket}/{key}`),
		// which would drop this Lambda. But a raw S3 integration is only a keyed
		// GET — it can't do SPA fallback (a missing key must serve `index.html`,
		// not 403/404), directory-index resolution (`/about` → `/about/index.html`),
		// or content-type inference, all of which the asset-proxy does. So S3-direct
		// is only viable for a PURE static/SSG site (real files, real 404s), not a
		// SPA — and it's REST-only (HTTP API v2 has no S3 service integration at
		// all). We keep the asset-proxy so a single code path serves every
		// framework on both flavors; a static/SSG-only S3-direct fast path is a
		// possible future optimization, not a general win.
		const stripPrefix = plan.policies.basePath ?? plan.policies.assetPrefix ?? '';
		const spaFallback = plan.policies.spaFallback && !serverFn;
		const assetProxy = new LambdaFunction(this, 'AssetProxy', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: Code.fromInline(
				generateApiGwAssetProxyCode({
					stripPrefix,
					spaFallback,
					// The app's rules, applied as on the CloudFront door (see `asset_proxy_core.ts`).
					redirects: plan.routes.redirects,
					headers: plan.routes.headers,
					errorPages: props.errorPages,
				}),
			),
			timeout: Duration.seconds(15),
			memorySize: 256,
			environment: assetProxyEnvironment({ bucket, prefix: `builds/${buildId}` }),
		});
		bucket.grantRead(assetProxy);
		this.assetProxy = assetProxy;

		// REGIONAL: no CloudFront in front, so no edge-optimized double proxy.
		// All bodies binary so the asset-proxy's base64 output decodes and binary
		// uploads/downloads pass through untouched.
		this.api = new RestApi(this, 'RestApi', {
			restApiName: `blocks-${buildId}`.substring(0, 128),
			endpointTypes: [EndpointType.REGIONAL],
			deployOptions: { stageName: 'prod' },
			binaryMediaTypes: ['*/*'],
		});

		// One API-scoped invoke permission per function (`scopePermissionToMethod:
		// false`), not two per method: per-method permissions would grow each
		// function's resource policy toward Lambda's 20 KB limit. The trust
		// boundary is the same (this API).
		const assetIntegration = new LambdaIntegration(assetProxy, { proxy: true, scopePermissionToMethod: false });
		// A streaming server (the Lambda Web Adapter in `response_stream` mode, the
		// OpenNext streaming wrapper) needs a STREAM integration, as on the
		// CloudFront door's SSR origin; a plain invoke would return its framing.
		const serverIntegration = serverFn
			? new LambdaIntegration(serverFn, {
					proxy: true,
					scopePermissionToMethod: false,
					...(props.serverStreaming !== false ? { responseTransferMode: ResponseTransferMode.STREAM } : {}),
				})
			: undefined;
		const imageIntegration = imageFn
			? new LambdaIntegration(imageFn, { proxy: true, scopePermissionToMethod: false })
			: undefined;
		// Catch-all: SSR when present, else the asset proxy (SPA fallback on miss).
		const defaultIntegration = serverIntegration ?? assetIntegration;

		// Root default (both `/` and any unmatched deeper path via the greedy proxy).
		this.api.root.addMethod('ANY', defaultIntegration);
		this.api.root.addResource('{proxy+}').addMethod('ANY', defaultIntegration);

		const integrationForKind = (kind: 'static' | 'server' | 'image') =>
			kind === 'server'
				? defaultIntegration
				: kind === 'image'
					? (imageIntegration ?? assetIntegration)
					: assetIntegration;

		// Same-origin backend routing via native HTTP_PROXY (no forwarder Lambda).
		// A lone `'*'` origin is the single-compute case (every API path → one
		// backend); a named namespace path-routes `/aws-blocks/api/<ns>/*` to that
		// compute's ingress.
		const httpProxy = (uri: string): Integration =>
			new Integration({
				type: IntegrationType.HTTP_PROXY,
				integrationHttpMethod: 'ANY',
				uri,
				options: {
					connectionType: ConnectionType.INTERNET,
					requestParameters: { 'integration.request.path.proxy': 'method.request.path.proxy' },
				},
			});
		const addProxyRoute = (path: string, uri: string) => {
			this.api.root.resourceForPath(path).addMethod('ANY', httpProxy(uri), {
				requestParameters: { 'method.request.path.proxy': true },
			});
		};
		// An exact path carries no `{proxy}` to map.
		const addExactRoute = (path: string, uri: string) => {
			this.api.root.resourceForPath(path).addMethod(
				'ANY',
				new Integration({
					type: IntegrationType.HTTP_PROXY,
					integrationHttpMethod: 'ANY',
					uri,
					options: { connectionType: ConnectionType.INTERNET },
				}),
			);
		};
		const backendPaths = new Set<string>();
		for (const origin of plan.backend?.origins ?? []) {
			// Split the ingress URL on the `/aws-blocks/api` suffix (token-safe) to
			// get the backend base — same shape whether Lambda API Gateway, an ALB,
			// or a BYOC endpoint.
			const base = backendBaseUrl(origin.ingress.url); // https://…/prod
			if (origin.namespace === '*') {
				// Every API path: `/aws-blocks/*` (RPC, and sign-in at
				// `/aws-blocks/auth/*`) plus the backend's raw routes.
				for (const pattern of new Set(props.apiPaths ?? DEFAULT_API_PATHS)) {
					for (const route of apiPathToRoutes(pattern, 'API Gateway (REST)')) {
						if (backendPaths.has(route.path)) continue;
						backendPaths.add(route.path);
						if (route.path.endsWith('/{proxy+}')) addProxyRoute(route.path, `${base}${route.target}`);
						else addExactRoute(route.path, `${base}${route.target}`);
					}
				}
			} else {
				const ns = origin.namespace;
				addProxyRoute(`/aws-blocks/api/${ns}/{proxy+}`, `${base}/aws-blocks/api/${ns}/{proxy}`);
			}
		}

		// Route table → resources (deduped; the catch-all is the root default).
		const seen = new Set<string>();
		// Redirect sources first: each routes to the asset proxy, which answers the
		// redirect with the CloudFront door's semantics (first match, wildcard tail
		// spliced). A source with an inner wildcard has no resource form.
		for (const r of plan.routes.redirects) {
			const path = globToProxyPath(r.source);
			if (path === null || path.includes('*') || seen.has(path) || backendPaths.has(path)) continue;
			if (path.startsWith('/aws-blocks/')) continue; // backend owns these
			seen.add(path);
			this.api.root.resourceForPath(path).addMethod('ANY', assetIntegration);
		}
		const inexpressible: string[] = [];
		for (const entry of plan.routes.entries) {
			// A wildcard inside a segment (`/*.js`) has no resource form: the default serves it.
			if (hasInnerWildcard(entry.pattern)) {
				inexpressible.push(entry.pattern);
				continue;
			}
			const path = globToProxyPath(entry.pattern);
			if (path === null || seen.has(path) || backendPaths.has(path)) continue;
			if (path.startsWith('/aws-blocks/')) continue; // backend owns these
			seen.add(path);
			this.api.root.resourceForPath(path).addMethod('ANY', integrationForKind(entry.kind));
		}
		warnInexpressibleRoutes(this, 'API Gateway (REST)', inexpressible);
		// The quota counts resources (every path segment is one), not methods.
		const resourceCount = this.api.node.findAll().filter((c) => c instanceof Resource).length + 1; // + the root
		if (resourceCount > APIGW_DEFAULT_ROUTE_QUOTA) {
			Annotations.of(this).addWarning(
				`The API Gateway REST front door defines ${resourceCount} resources; a REST API allows ${APIGW_DEFAULT_ROUTE_QUOTA} resources by default. ` +
					'Request a quota increase, or group raw routes under fewer path prefixes.',
			);
		}

		// The rules the proxies can't apply: responses API Gateway sends straight
		// to a function or (natively) to the backend.
		warnRulesNotApplied(this, {
			door: 'API Gateway (REST)',
			headers: plan.routes.headers,
			errorPages: Boolean(props.errorPages?.notFound || props.errorPages?.serverError),
			server: Boolean(serverFn),
			image: Boolean(imageFn),
			nativeApi: backendPaths.size > 0,
			api: (plan.backend?.origins.length ?? 0) > 0,
		});

		this.url = this.api.url; // https://<id>.execute-api.<region>.amazonaws.com/prod/

		// Custom domain(s): a regional DomainName + base-path mapping per name,
		// with a Route 53 A/AAAA alias to the gateway's regional domain. The
		// primary name becomes the door's URL.
		if (props.domain) {
			const { certificate, hostedZone, names } = resolveApiGwDomain(this, 'Domain', props.domain);
			names.forEach((name, i) => {
				const dn = new DomainName(this, `Domain${i}`, {
					domainName: name,
					certificate,
					endpointType: EndpointType.REGIONAL,
					securityPolicy: SecurityPolicy.TLS_1_2,
				});
				new BasePathMapping(this, `DomainMap${i}`, { domainName: dn, restApi: this.api });
				if (hostedZone) {
					const target = RecordTarget.fromAlias(new ApiGatewayDomain(dn));
					new ARecord(this, `DomainA${i}`, { zone: hostedZone, recordName: name, target });
					new AaaaRecord(this, `DomainAAAA${i}`, { zone: hostedZone, recordName: name, target });
				}
			});
			this.url = `https://${names[0]}`;
		}

		new CfnOutput(this, 'ApiGatewayRestUrl', {
			value: this.url,
			description: 'API Gateway REST API front-door URL',
		});
	}
}
