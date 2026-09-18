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
 *   - `/aws-blocks/*` + `/aws-blocks-auth/*` (or `/aws-blocks/api/<ns>/*`) →
 *     an `HTTP_PROXY` integration straight to the backend (same-origin; no
 *     forwarder Lambda).
 *
 * Trade-offs (declared `degraded`/`unsupported` on {@link ApiGatewayAdapter},
 * enforced by the negotiator): no global edge cache, no per-route response
 * headers, no skew-pin, buffered SSR only (no streaming), ~10 MB payload cap,
 * ~29 s integration timeout.
 */
import { CfnOutput, Duration, Fn } from 'aws-cdk-lib';
import {
	BasePathMapping,
	ConnectionType,
	DomainName,
	EndpointType,
	Integration,
	IntegrationType,
	LambdaIntegration,
	RestApi,
	SecurityPolicy,
} from 'aws-cdk-lib/aws-apigateway';
import { Code, Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { AaaaRecord, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayDomain } from 'aws-cdk-lib/aws-route53-targets';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { CapabilityPlan } from '../plan/types.js';
import { generateApiGwAssetProxyCode } from './apigw_asset_proxy.js';
import { type ApiGwCustomDomain, resolveApiGwDomain } from './apigw_domain.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

export type ApiGatewayRestConstructProps = {
	plan: CapabilityPlan;
	bucket: IBucket;
	computeFunctions?: Map<string, IFunction>;
	serverComputeName?: string;
	imageComputeName?: string;
	/** Custom domain(s) — a regional cert + DomainName + base-path mapping + Route 53 alias. */
	domain?: ApiGwCustomDomain;
};

/**
 * Convert a route-table glob pattern to a REST API resource path (or null for
 * the catch-all root). `/assets/*` → `/assets/{proxy+}`; `/about` → `/about`.
 */
const toRestPath = (pattern: string): string | null => {
	if (pattern === '/*' || pattern === '*') return null; // → root default
	if (pattern.endsWith('/*')) return `${pattern.slice(0, -2)}/{proxy+}`;
	return pattern; // exact
};

export class ApiGatewayRestConstruct extends Construct {
	readonly api: RestApi;
	readonly url: string;

	constructor(scope: Construct, id: string, props: ApiGatewayRestConstructProps) {
		super(scope, id);
		const { plan, bucket } = props;
		const buildId = plan.release.buildId;
		const compute = props.computeFunctions ?? new Map<string, IFunction>();
		const serverFn = props.serverComputeName ? compute.get(props.serverComputeName) : undefined;
		const imageFn = props.imageComputeName ? compute.get(props.imageComputeName) : undefined;

		// Asset-proxy Lambda → private S3. Payload-format-agnostic: the REST API
		// delivers a v1 event (`event.path`), which the shared generator reads.
		const stripPrefix = plan.policies.basePath ?? plan.policies.assetPrefix ?? '';
		const spaFallback = plan.policies.spaFallback && !serverFn;
		const assetProxy = new LambdaFunction(this, 'AssetProxy', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: Code.fromInline(generateApiGwAssetProxyCode({ stripPrefix, spaFallback })),
			timeout: Duration.seconds(15),
			memorySize: 256,
			environment: { ASSET_BUCKET: bucket.bucketName, ASSET_KEY_PREFIX: `builds/${buildId}` },
		});
		bucket.grantRead(assetProxy);

		// REGIONAL: no CloudFront in front, so no edge-optimized double proxy.
		// All bodies binary so the asset-proxy's base64 output decodes and binary
		// uploads/downloads pass through untouched.
		this.api = new RestApi(this, 'RestApi', {
			restApiName: `blocks-${buildId}`.substring(0, 128),
			endpointTypes: [EndpointType.REGIONAL],
			deployOptions: { stageName: 'prod' },
			binaryMediaTypes: ['*/*'],
		});

		const assetIntegration = new LambdaIntegration(assetProxy, { proxy: true });
		const serverIntegration = serverFn ? new LambdaIntegration(serverFn, { proxy: true }) : undefined;
		const imageIntegration = imageFn ? new LambdaIntegration(imageFn, { proxy: true }) : undefined;
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
		// A lone `'*'` origin is the single-compute case (`/aws-blocks/*` +
		// `/aws-blocks-auth/*` → one backend); a named namespace path-routes
		// `/aws-blocks/api/<ns>/*` to that compute's ingress.
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
		for (const origin of plan.backend?.origins ?? []) {
			// Split the ingress URL on the `/aws-blocks/api` suffix (token-safe) to
			// get the backend base — same shape whether Lambda API Gateway, an ALB,
			// or a BYOC endpoint.
			const base = Fn.select(0, Fn.split('/aws-blocks/api', origin.ingress.url)); // https://…/prod
			if (origin.namespace === '*') {
				addProxyRoute('/aws-blocks/{proxy+}', `${base}/aws-blocks/{proxy}`);
				addProxyRoute('/aws-blocks-auth/{proxy+}', `${base}/aws-blocks-auth/{proxy}`);
			} else {
				const ns = origin.namespace;
				addProxyRoute(`/aws-blocks/api/${ns}/{proxy+}`, `${base}/aws-blocks/api/${ns}/{proxy}`);
			}
		}

		// Route table → resources (deduped; the catch-all is the root default).
		const seen = new Set<string>();
		for (const entry of plan.routes.entries) {
			const path = toRestPath(entry.pattern);
			if (path === null || seen.has(path)) continue;
			if (path.startsWith('/aws-blocks/') || path.startsWith('/aws-blocks-auth/')) continue; // backend owns these
			seen.add(path);
			this.api.root.resourceForPath(path).addMethod('ANY', integrationForKind(entry.kind));
		}

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
			this.url = `https://${names[0]}/`;
		}

		new CfnOutput(this, 'ApiGatewayRestUrl', {
			value: this.url,
			description: 'API Gateway REST API front-door URL',
		});
	}
}
