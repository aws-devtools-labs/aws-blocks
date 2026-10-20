// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared multi-tenant front doors — EXPERIMENTAL / POC.
 *
 * ONE front door fronting N tenant apps. Each tenant is a real, independent
 * `Hosting` app (its own bucket, build, and backend) that opts into the shared
 * door with one line:
 *
 *   // platform team, once
 *   const shared = new SharedCloudFrontDoor(stack, 'Shared', { routing: 'path' });
 *   // every app / tenant
 *   new Hosting(stack, 'TenantA', { root, api, frontDoor: { kind: 'custom', door: shared.forTenant('tenant-a') } });
 *
 * `forTenant(id)` returns a free-form front door (`defineFrontDoor({ service, build })`).
 * Its `build` builds nothing per tenant — the shared door already exists. It:
 *   1. claims the tenant id: a duplicate or malformed id fails synth (the first
 *      tenant-isolation check);
 *   2. rejects what a shared door can't serve per tenant: server rendering, and
 *      a custom domain, WAF, geo restriction, access logs or alarms;
 *   3. registers THIS tenant in the shared route table — its own bucket, build
 *      prefix and SPA flag, and its backend for `/aws-blocks/*` — and grants the
 *      shared door read on that bucket;
 *   4. returns the tenant's URL on the shared door.
 *
 * The route table is rendered lazily (once every tenant has registered) into the
 * door's router: the CloudFront Function's code, or the router Lambda's env. The
 * router resolves the tenant (first path segment, or the Host header's first DNS
 * label), 404s an unknown tenant, OVERWRITES any client-sent `x-tenant-id`, and
 * only ever reads the resolved tenant's bucket / calls the resolved tenant's API
 * — the cross-tenant isolation boundary.
 *
 * Three doors: CloudFront (origin switched per request with
 * `cf.updateRequestOrigin`), API Gateway HTTP API and ALB (one router Lambda).
 */
import { Duration, Fn, Lazy, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
	AllowedMethods,
	CachePolicy,
	Distribution,
	Function as CloudFrontFunction,
	FunctionCode,
	FunctionEventType,
	FunctionRuntime,
	OriginRequestPolicy,
	ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { BlockPublicAccess, Bucket, type IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import { cf } from './cf_helpers.js';
import { BLOCKS_API_SUBTREE } from './door_input.js';
import { type DoorInput, defineFrontDoor, type FrontDoor } from './front_door.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

/** How a shared door tells tenants apart. */
export type TenantRouting = 'path' | 'subdomain';

/** Options common to every shared door. */
export type SharedDoorProps = {
	/** `path` (`/<tenant>/…`, default) or `subdomain` (tenant = the Host header's first DNS label). */
	routing?: TenantRouting;
	/**
	 * Base domain for `subdomain` tenant URLs (`https://<tenant>.<domain>/`). Only
	 * used to report each tenant's URL; DNS + a wildcard certificate are platform
	 * plumbing outside this POC.
	 */
	domain?: string;
};

/** One registered tenant (values may be deploy-time tokens). */
type TenantEntry = {
	bucket: IBucket;
	prefix?: string;
	spa?: boolean;
	/**
	 * The tenant backend's base URL (scheme + host + stage, without `/aws-blocks`),
	 * when the app has an API. The router appends the request's `/aws-blocks/…` path.
	 */
	apiBase?: string;
};

const TENANT_ID_RE = /^[a-z0-9-]+$/;

/** The `features` a shared door can't apply per tenant (it owns one door for all of them). */
const UNSUPPORTED_FEATURES = ['domain', 'waf', 'geoRestriction', 'logging', 'monitoring'] as const;

/**
 * Base class for a shared door: the tenant registry + the `forTenant` door.
 * Subclasses own the door resource and how a tenant's bucket is made readable.
 */
abstract class SharedDoor extends Construct {
	/** `path` or `subdomain`. */
	readonly routing: TenantRouting;
	protected readonly domain?: string;
	protected readonly tenants = new Map<string, TenantEntry>();

	protected constructor(scope: Construct, id: string, props: SharedDoorProps) {
		super(scope, id);
		this.routing = props.routing ?? 'path';
		this.domain = props.domain;
		if (this.routing === 'subdomain' && !this.domain) {
			throw new HostingError('InvalidPropsError', {
				message: `${this.constructor.name}: \`routing: 'subdomain'\` needs \`domain\` (the base domain tenants live under).`,
				resolution: "Pass `domain: 'app.example.com'` (tenants are served at `<tenant>.app.example.com`).",
			});
		}
	}

	/** Stable diagnostics id of the door (`shared-cloudfront`, …). */
	protected abstract readonly service: string;
	/** The door's own public host (distribution domain, API host, ALB DNS). */
	protected abstract get doorHost(): string;
	/** The door's public scheme. */
	protected abstract readonly scheme: 'http' | 'https';
	/** Let the door read `bucket` (bucket policy for CloudFront OAC; IAM grant for a router Lambda). */
	protected abstract grantTenantBucket(bucket: IBucket): void;

	/** The tenant's public URL on this door. */
	protected tenantUrl(tenantId: string): string {
		return this.routing === 'subdomain'
			? `${this.scheme}://${tenantId}.${this.domain}/`
			: `${this.scheme}://${this.doorHost}/${tenantId}/`;
	}

	/**
	 * The route table, rendered lazily — after every tenant's `route` hook has
	 * registered. Values can be tokens (bucket names, API hosts); CDK resolves
	 * them in place.
	 */
	protected renderRoutes(field: 'bucketName' | 'bucketRegionalDomainName'): string {
		return Lazy.string({
			produce: () => {
				const out: Record<string, { bucket: string; prefix: string; spa: boolean; api?: string }> = {};
				for (const [tenantId, e] of this.tenants) {
					out[tenantId] = {
						bucket: e.bucket[field],
						prefix: e.prefix ?? '',
						spa: e.spa !== false,
						...(e.apiBase ? { api: e.apiBase } : {}),
					};
				}
				return JSON.stringify(out);
			},
		});
	}

	/** The tenant ids registered so far. */
	get tenantIds(): string[] {
		return [...this.tenants.keys()];
	}

	/**
	 * The front door for ONE tenant — pass it as `frontDoor: { kind: 'custom', door }`.
	 * It serves static/SPA tenants with a same-origin API (`/aws-blocks/*`). A tenant
	 * with server rendering, or one that asks for a custom domain, WAF, geo
	 * restriction, access logs or alarms, fails at synth: those belong to the
	 * shared door, not to one tenant.
	 *
	 * @throws HostingError('InvalidPropsError') for a malformed or duplicate tenant id.
	 * @throws HostingError('UnsupportedFrontDoorError') for a tenant the shared door can't serve.
	 */
	forTenant(tenantId: string): FrontDoor {
		const door = this;
		const service = `${this.service}:${tenantId}`;
		return defineFrontDoor({
			service,
			build(_scope, input: DoorInput) {
				door.claim(tenantId);
				door.assertServable(service, input);
				const { assets, api } = input.origins;
				const entry: TenantEntry = {
					bucket: assets.bucket,
					// `builds/<buildId>/` → `builds/<buildId>`: the router joins it with the request path.
					prefix: assets.prefix.replace(/\/$/, ''),
					spa: input.app.spaFallback,
				};
				door.grantTenantBucket(assets.bucket);
				cf.recordWired(assets);
				if (api) {
					// `https://<host>[/<stage>]/aws-blocks` → `https://<host>[/<stage>]`.
					entry.apiBase = Fn.select(0, Fn.split('/aws-blocks', api.url));
					cf.recordWired(api, [BLOCKS_API_SUBTREE]);
				}
				door.tenants.set(tenantId, entry);
				return {
					url: door.tenantUrl(tenantId),
					originHandle: { domainName: door.doorHost, protocol: door.scheme },
				};
			},
		});
	}

	/** Claim `tenantId` on this door: it must be a valid path segment / DNS label, and unique. */
	private claim(tenantId: string): void {
		if (!TENANT_ID_RE.test(tenantId)) {
			throw new HostingError('InvalidPropsError', {
				message: `Invalid tenantId '${tenantId}'.`,
				resolution: 'Tenant ids must match /^[a-z0-9-]+$/ (they are a URL path segment / DNS label).',
			});
		}
		if (this.tenants.has(tenantId)) {
			throw new HostingError('InvalidPropsError', {
				message: `Tenant '${tenantId}' is already registered on ${this.node.path}.`,
				resolution: 'Each app must use a unique tenant id on a shared door.',
			});
		}
	}

	/** Fail synth for a tenant this shared door can't serve (see {@link forTenant}). */
	private assertServable(service: string, input: DoorInput): void {
		const problems: string[] = [];
		if (input.origins.server) problems.push('server rendering (the shared door serves static/SPA tenants only)');
		for (const feature of UNSUPPORTED_FEATURES) {
			if (input.features[feature]) problems.push(`features.${feature} (set it on the shared door, not per tenant)`);
		}
		if (problems.length === 0) return;
		throw new HostingError('UnsupportedFrontDoorError', {
			message: `Front door '${service}' cannot serve this tenant: ${problems.join('; ')}.`,
			resolution: 'Remove these from the tenant app, or give the app its own front door.',
		});
	}
}

// ── CloudFront ───────────────────────────────────────────────────────────────

/**
 * The viewer-request CloudFront Function: tenant → route-table lookup → switch
 * the request's origin to THAT tenant's bucket (OAC-signed) or THAT tenant's API
 * (`cf.updateRequestOrigin`), rewrite the URI, stamp `x-tenant-id`. The table is
 * inlined (CloudFront Functions can't read DynamoDB/S3); `routes` is a lazy token.
 */
const cloudFrontRouterCode = (routing: TenantRouting, routes: string): string =>
	[
		"import cf from 'cloudfront';",
		`var ROUTING = ${JSON.stringify(routing)};`,
		'var ROUTES = ',
		routes,
		';',
		`function notFound(msg) { return { statusCode: 404, statusDescription: 'Not Found', headers: {}, body: msg }; }
function handler(event) {
  var req = event.request;
  var uri = req.uri || '/';
  var tenant, rest;
  if (ROUTING === 'subdomain') {
    var host = (req.headers.host && req.headers.host.value) ? req.headers.host.value : '';
    tenant = host.split(':')[0].split('.')[0];
    rest = uri;
  } else {
    var m = uri.match(/^\\/([^\\/]+)(\\/.*)?$/);
    if (!m) return notFound('MT-SHARED: no tenant in path');
    tenant = m[1];
    rest = m[2] || '/';
  }
  var meta = ROUTES[tenant];
  if (!tenant || !meta) return notFound('MT-SHARED: unknown tenant ' + tenant);
  // Tenant context inward — overwrites anything the client sent.
  req.headers['x-tenant-id'] = { value: tenant };
  if (meta.api && (rest === '/aws-blocks' || rest.indexOf('/aws-blocks/') === 0)) {
    // meta.api is https://<host>[/<stage>]: the host is the origin, the stage its origin path.
    var hostAndPath = meta.api.replace(/^https:\\/\\//, '');
    var slash = hostAndPath.indexOf('/');
    var apiOrigin = {
      domainName: slash === -1 ? hostAndPath : hostAndPath.substring(0, slash),
      originAccessControlConfig: { enabled: false },
      customOriginConfig: { port: 443, protocol: 'https', sslProtocols: ['TLSv1.2'] },
    };
    if (slash !== -1) apiOrigin.originPath = hostAndPath.substring(slash);
    cf.updateRequestOrigin(apiOrigin);
    req.uri = rest;
    return req;
  }
  var lastSeg = rest.substring(rest.lastIndexOf('/') + 1);
  if (lastSeg.indexOf('.') === -1) {
    if (meta.spa) rest = '/index.html';
    else rest = rest.charAt(rest.length - 1) === '/' ? rest + 'index.html' : rest + '/index.html';
  }
  cf.updateRequestOrigin({
    domainName: meta.bucket,
    originAccessControlConfig: { enabled: true, signingBehavior: 'always', signingProtocol: 'sigv4', originType: 's3' },
  });
  req.uri = '/' + meta.prefix + rest;
  return req;
}
`,
	].join('');

/**
 * ONE CloudFront distribution shared by N tenant apps. A single CloudFront
 * Function picks the tenant and switches the origin per request, so adding a
 * tenant adds a route-table entry — not a behavior, origin, or distribution.
 * Two fixed behaviors: assets (default, S3 + OAC) and the API subtree
 * (`/*\/aws-blocks/*` or `/aws-blocks/*`, uncached, all viewer headers).
 */
export class SharedCloudFrontDoor extends SharedDoor {
	protected readonly service = 'shared-cloudfront';
	protected readonly scheme = 'https' as const;
	/** The shared distribution. */
	readonly distribution: Distribution;
	/** The router function. */
	readonly router: CloudFrontFunction;

	protected get doorHost(): string {
		return this.distribution.distributionDomainName;
	}

	constructor(scope: Construct, id: string, props: SharedDoorProps = {}) {
		super(scope, id, props);
		// A tiny platform bucket is the default behavior's assigned origin — it gives
		// the distribution an S3 OAC; every real request is switched to a tenant bucket.
		const placeholder = new Bucket(this, 'Placeholder', {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			enforceSSL: true,
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});
		this.router = new CloudFrontFunction(this, 'TenantRouter', {
			code: FunctionCode.fromInline(cloudFrontRouterCode(this.routing, this.renderRoutes('bucketRegionalDomainName'))),
			runtime: FunctionRuntime.JS_2_0,
			comment: `MT-SHARED: ${this.routing} tenant → per-tenant origin`,
		});
		const fn = [{ function: this.router, eventType: FunctionEventType.VIEWER_REQUEST }];
		this.distribution = new Distribution(this, 'Distribution', {
			comment: 'MT-SHARED one distribution / N tenant apps',
			defaultBehavior: {
				origin: S3BucketOrigin.withOriginAccessControl(placeholder, { originId: 'mt-s3' }),
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				functionAssociations: fn,
			},
			additionalBehaviors: {
				[this.routing === 'subdomain' ? '/aws-blocks/*' : '/*/aws-blocks/*']: {
					origin: new HttpOrigin('example.com', { originId: 'mt-api' }),
					viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
					allowedMethods: AllowedMethods.ALLOW_ALL,
					cachePolicy: CachePolicy.CACHING_DISABLED,
					originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
					functionAssociations: fn,
				},
			},
		});
	}

	/** OAC read of the tenant's build prefix, scoped to THIS distribution. */
	protected grantTenantBucket(bucket: IBucket): void {
		bucket.addToResourcePolicy(
			new PolicyStatement({
				actions: ['s3:GetObject'],
				principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
				resources: [bucket.arnForObjects('builds/*')],
				conditions: {
					StringEquals: {
						'AWS:SourceArn': Stack.of(this).formatArn({
							service: 'cloudfront',
							region: '',
							resource: 'distribution',
							resourceName: this.distribution.distributionId,
						}),
					},
				},
			}),
		);
	}
}

// ── API Gateway / ALB (one router Lambda) ────────────────────────────────────

/**
 * The router Lambda: tenant → route table (env) → stream THAT tenant's object
 * from its own bucket, or proxy `/aws-blocks/*` to THAT tenant's API with
 * `x-tenant-id`. Handles both HTTP API v2 and ALB events.
 */
const routerLambdaCode = (): string => `const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
const ROUTES = JSON.parse(process.env.TENANT_ROUTES || '{}');
const ROUTING = process.env.TENANT_ROUTING || 'path';
const CT = { html:'text/html; charset=utf-8', js:'text/javascript', css:'text/css', json:'application/json', svg:'image/svg+xml', png:'image/png', ico:'image/x-icon', txt:'text/plain; charset=utf-8' };
function ctFor(k){ var d=k.lastIndexOf('.'); return CT[d===-1?'':k.substring(d+1).toLowerCase()]||'application/octet-stream'; }
async function readStream(b){ var c=[]; for await (var x of b) c.push(x); return Buffer.concat(c); }
function out(alb, status, headers, body, b64){ var r={ statusCode:status, headers:headers, body:body, isBase64Encoded:!!b64 }; if (alb) r.statusDescription = status + ' ' + (status===200?'OK':'Error'); return r; }
exports.handler = async (event) => {
  var alb = !!(event.requestContext && event.requestContext.elb);
  var path = alb ? (event.path || '/') : (event.rawPath || '/');
  var headers = event.headers || {};
  var method = alb ? event.httpMethod : (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
  var qs = alb ? (event.queryStringParameters ? new URLSearchParams(event.queryStringParameters).toString() : '') : (event.rawQueryString || '');
  var tenant, rest;
  if (ROUTING === 'subdomain') { tenant = String(headers.host || headers.Host || '').split(':')[0].split('.')[0]; rest = path; }
  else { var m = path.match(/^\\/([^\\/]+)(\\/.*)?$/); if (!m) return out(alb,404,{'content-type':'text/plain'},'MT-SHARED: no tenant in path'); tenant = m[1]; rest = m[2] || '/'; }
  var meta = ROUTES[tenant];
  if (!tenant || !meta) return out(alb,404,{'content-type':'text/plain'},'MT-SHARED: unknown tenant ' + tenant);
  if (meta.api && (rest === '/aws-blocks' || rest.indexOf('/aws-blocks/') === 0)) {
    var fwd = {};
    for (var k in headers) { var lk = k.toLowerCase(); if (lk !== 'host' && lk !== 'x-tenant-id' && lk !== 'content-length' && lk.indexOf('x-forwarded') !== 0) fwd[lk] = headers[k]; }
    fwd['x-tenant-id'] = tenant;
    var body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined;
    var r = await fetch(meta.api + rest + (qs ? '?' + qs : ''), { method: method, headers: fwd, body: (method === 'GET' || method === 'HEAD') ? undefined : body });
    var buf = Buffer.from(await r.arrayBuffer());
    return out(alb, r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'x-tenant-id': tenant }, buf.toString('base64'), true);
  }
  var lastSeg = rest.substring(rest.lastIndexOf('/') + 1);
  if (lastSeg.indexOf('.') === -1) rest = meta.spa ? '/index.html' : (rest.charAt(rest.length-1)==='/' ? rest+'index.html' : rest+'/index.html');
  var key = meta.prefix + rest;
  async function get(k){ var o = await s3.send(new GetObjectCommand({ Bucket: meta.bucket, Key: k })); return { buf: await readStream(o.Body), ct: o.ContentType || ctFor(k) }; }
  try {
    var o = await get(key);
    return out(alb, 200, { 'content-type': o.ct, 'x-tenant-id': tenant, 'cache-control': o.ct.indexOf('text/html')===0 ? 'no-cache' : 'public, max-age=31536000, immutable' }, o.buf.toString('base64'), true);
  } catch (e) {
    if (meta.spa && rest !== '/index.html') { try { var i = await get(meta.prefix + '/index.html'); return out(alb, 200, { 'content-type': 'text/html; charset=utf-8', 'x-tenant-id': tenant }, i.buf.toString('base64'), true); } catch (_e) {} }
    return out(alb, 404, { 'content-type': 'text/plain', 'x-tenant-id': tenant }, 'Not Found');
  }
};
`;

/** A shared door whose router is one Lambda reading the tenant route table from its env. */
abstract class SharedRouterDoor extends SharedDoor {
	/** The router Lambda. */
	readonly router: LambdaFunction;

	protected constructor(scope: Construct, id: string, props: SharedDoorProps) {
		super(scope, id, props);
		this.router = new LambdaFunction(this, 'Router', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: Code.fromInline(routerLambdaCode()),
			timeout: Duration.seconds(15),
			memorySize: 256,
			environment: { TENANT_ROUTES: this.renderRoutes('bucketName'), TENANT_ROUTING: this.routing },
		});
	}

	/** IAM read of the tenant's build prefix for the router. */
	protected grantTenantBucket(bucket: IBucket): void {
		bucket.grantRead(this.router, 'builds/*');
	}
}

/** ONE API Gateway HTTP API (`$default` → the router) shared by N tenant apps. */
export class SharedApiGatewayDoor extends SharedRouterDoor {
	protected readonly service = 'shared-api-gateway';
	protected readonly scheme = 'https' as const;
	/** The shared HTTP API. */
	readonly api: HttpApi;

	protected get doorHost(): string {
		return Fn.select(1, Fn.split('://', this.api.apiEndpoint));
	}

	constructor(scope: Construct, id: string, props: SharedDoorProps = {}) {
		super(scope, id, props);
		this.api = new HttpApi(this, 'HttpApi', {
			description: `MT-SHARED one API / N tenant apps (${this.routing})`,
			defaultIntegration: new HttpLambdaIntegration('RouterInt', this.router),
		});
	}
}

/** Options for {@link SharedAlbDoor}. */
export type SharedAlbDoorProps = SharedDoorProps & {
	/** The VPC to place the ALB in (e.g. the account's default VPC). */
	vpc: ec2.IVpc;
};

/** ONE internet-facing ALB (one listener, one default action → the router) shared by N tenant apps. */
export class SharedAlbDoor extends SharedRouterDoor {
	protected readonly service = 'shared-alb';
	protected readonly scheme = 'http' as const;
	/** The shared load balancer. */
	readonly loadBalancer: elbv2.ApplicationLoadBalancer;

	protected get doorHost(): string {
		return this.loadBalancer.loadBalancerDnsName;
	}

	constructor(scope: Construct, id: string, props: SharedAlbDoorProps) {
		super(scope, id, props);
		this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
			vpc: props.vpc,
			internetFacing: true,
			vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
		});
		// No listener rule per tenant (that hits the ~100-rule cap) — one default action.
		this.loadBalancer.addListener('Http', {
			port: 80,
			defaultTargetGroups: [
				new elbv2.ApplicationTargetGroup(this, 'RouterTarget', {
					targets: [new targets.LambdaTarget(this.router)],
				}),
			],
		});
	}
}
