/**
 * MultiTenantApiGateway — EXPERIMENTAL / PROOF-OF-CONCEPT.
 *
 * One Amazon API Gateway (HTTP API v2) fronting N tenant apps, routed by the
 * first path segment (`/<tenantId>/…`) or the Host header's first DNS label
 * (`<tenantId>.example.com`). This is the API-Gateway sibling of the multi-tenant
 * CloudFront POC — the same "one shared door / N tenants" mechanism from the
 * design notes, rendered on a door that has no edge function + KeyValueStore:
 *
 *   one HTTP API ($default → one router Lambda) + a tenant route table + one bucket
 *
 * How it works:
 *   - ONE private S3 bucket holds every tenant's built assets under a per-tenant
 *     prefix `t/<tenantId>/…`.
 *   - ONE HTTP API v2 with a single `$default` route → ONE router Lambda (proxy
 *     integration). The rootless `$default` stage suits a root single-page app.
 *   - The router Lambda reads the tenant (first path segment in `path` mode, or
 *     the Host header's first label in `subdomain` mode), looks it up in a tenant
 *     route table (`tenantId → { prefix, spa }`, baked into the Lambda env for the
 *     POC), streams the object from `t/<tenantId>/…` (extensionless → `index.html`;
 *     SPA fallback), stamps `x-tenant-id` on the response (the tenant-context
 *     contract), and 404s an unknown tenant.
 *
 * Adding a tenant is a route-table entry + a per-tenant asset prefix — NOT a new
 * API, route, stage, or integration. That is what lets one API carry many
 * tenants (a route/integration per tenant would multiply resources and hit the
 * account's API Gateway quotas).
 *
 * POC scope: static/SPA tenants only (no per-tenant SSR/backend fan-out, no
 * custom domains/TLS, no per-tenant throttling/usage plans yet). It exists to
 * prove the one-API/N-tenants routing substrate end to end. `subdomain` mode's
 * real DNS + wildcard TLS is out of scope — only the Host-based routing logic.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Code, Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { BlockPublicAccess, Bucket, type IBucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

/** How a shared door tells tenants apart. */
export type MultiTenantRouting = 'path' | 'subdomain';

/** One tenant fronted by the shared API Gateway. */
export type MultiTenantApiGatewayEntry = {
	/** Tenant key — the first path segment (`path`) or first Host label (`subdomain`). Lowercase `[a-z0-9-]`. */
	tenantId: string;
	/** Local directory of the tenant's built static assets (uploaded to `t/<tenantId>/`). */
	assetDir: string;
	/** Single-page-app fallback (extensionless → the tenant's `index.html`). Default `true`. */
	spaFallback?: boolean;
};

export type MultiTenantApiGatewayProps = {
	/** The tenants to front. Must be non-empty with unique, valid ids. */
	tenants: MultiTenantApiGatewayEntry[];
	/** How tenants are addressed — `path` (`/<tenant>/…`, default) or `subdomain` (`<tenant>.host`). */
	routing?: MultiTenantRouting;
	/** Removal policy for the shared assets bucket. Default `DESTROY` (POC). */
	removalPolicy?: RemovalPolicy;
};

const TENANT_ID_RE = /^[a-z0-9-]+$/;

/**
 * The router Lambda source (payload format 2.0 in, 2.0 out). Reads the tenant
 * per the routing mode, looks it up in the `TENANT_ROUTES` env table, streams
 * `t/<tenant>/…` from the private bucket, stamps `x-tenant-id`. Inline &
 * dependency-free (`@aws-sdk/client-s3` is in the Node.js Lambda runtime).
 */
const generateTenantRouterCode = (): string => `const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
const BUCKET = process.env.ASSET_BUCKET;
const ROUTES = JSON.parse(process.env.TENANT_ROUTES || '{}');
const ROUTING = process.env.TENANT_ROUTING || 'path';
const CT = { html:'text/html; charset=utf-8', js:'text/javascript', mjs:'text/javascript', css:'text/css', json:'application/json', svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', ico:'image/x-icon', txt:'text/plain; charset=utf-8', xml:'application/xml', woff:'font/woff', woff2:'font/woff2', map:'application/json' };
function ctFor(k){ var d=k.lastIndexOf('.'); var e=d===-1?'':k.substring(d+1).toLowerCase(); return CT[e]||'application/octet-stream'; }
async function readStream(b){ var c=[]; for await (var x of b) c.push(x); return Buffer.concat(c); }
async function fetchKey(key){ var r=await s3.send(new GetObjectCommand({Bucket:BUCKET,Key:key})); return { buf: await readStream(r.Body), ct: r.ContentType||ctFor(key) }; }
function res(status, ct, body, b64, tenant){ var h={'content-type':ct}; if(tenant) h['x-tenant-id']=tenant; return { statusCode:status, headers:h, isBase64Encoded:!!b64, body:body }; }
exports.handler = async (event) => {
  var rawPath = event.rawPath || '/';
  var tenant, rest;
  if (ROUTING === 'subdomain') {
    var host = (event.headers && (event.headers.host || event.headers.Host)) || '';
    tenant = host.split(':')[0].split('.')[0];
    rest = rawPath;
  } else {
    var m = rawPath.match(/^\\/([^\\/]+)(\\/.*)?$/);
    if (!m) return res(404,'text/plain; charset=utf-8','MT-APIGW: no tenant in path',false);
    tenant = m[1]; rest = m[2] || '/';
  }
  var meta = ROUTES[tenant];
  if (!meta) return res(404,'text/plain; charset=utf-8','MT-APIGW: unknown tenant '+tenant,false);
  var lastSeg = rest.substring(rest.lastIndexOf('/')+1);
  if (lastSeg.indexOf('.') === -1) { rest = meta.spa ? '/index.html' : (rest.charAt(rest.length-1)==='/' ? rest+'index.html' : rest+'/index.html'); }
  var prefix = String(meta.prefix).replace(/^\\/+|\\/+$/g,'');
  var key = prefix + (rest.charAt(0)==='/'?rest:'/'+rest);
  try {
    var o = await fetchKey(key);
    var isHtml = o.ct.indexOf('text/html')===0;
    var h = { 'content-type':o.ct, 'cache-control': isHtml?'no-cache, no-store, must-revalidate':'public, max-age=31536000, immutable', 'x-tenant-id':tenant };
    return { statusCode:200, headers:h, isBase64Encoded:true, body:o.buf.toString('base64') };
  } catch (e) {
    if (meta.spa && key.slice(-10)!=='index.html') {
      try { var i=await fetchKey(prefix+'/index.html'); return { statusCode:200, headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-cache, no-store, must-revalidate','x-tenant-id':tenant}, isBase64Encoded:true, body:i.buf.toString('base64') }; } catch (_e) {}
    }
    return res(404,'text/plain; charset=utf-8','Not Found',false,tenant);
  }
};
`;

/**
 * One API Gateway (HTTP API v2) fronting many tenants. See the file header for
 * the mechanism. Experimental POC — not part of the supported public API yet.
 */
export class MultiTenantApiGateway extends Construct {
	/** The single shared HTTP API. */
	readonly api: HttpApi;
	/** The single shared assets bucket (`t/<tenantId>/…`). */
	readonly bucket: IBucket;
	/** The single router Lambda. */
	readonly router: IFunction;

	/** The API's public invoke URL (`https://<id>.execute-api.<region>.amazonaws.com`). */
	get url(): string {
		return this.api.apiEndpoint;
	}

	constructor(scope: Construct, id: string, props: MultiTenantApiGatewayProps) {
		super(scope, id);

		if (!props.tenants || props.tenants.length === 0) {
			throw new HostingError('InvalidPropsError', {
				message: 'MultiTenantApiGateway requires at least one tenant.',
				resolution: 'Pass `tenants: [{ tenantId, assetDir }]`.',
			});
		}
		const seen = new Set<string>();
		for (const t of props.tenants) {
			if (!TENANT_ID_RE.test(t.tenantId)) {
				throw new HostingError('InvalidPropsError', {
					message: `Invalid tenantId '${t.tenantId}'.`,
					resolution: 'Tenant ids must match /^[a-z0-9-]+$/ (they are a URL path segment / DNS label).',
				});
			}
			if (seen.has(t.tenantId)) {
				throw new HostingError('InvalidPropsError', {
					message: `Duplicate tenantId '${t.tenantId}'.`,
					resolution: 'Tenant ids must be unique.',
				});
			}
			seen.add(t.tenantId);
		}

		const routing: MultiTenantRouting = props.routing ?? 'path';
		const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

		const bucket = new Bucket(this, 'Assets', {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			enforceSSL: true,
			removalPolicy,
			autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
		});
		this.bucket = bucket;

		// The tenant route table, baked into the router's env (POC). `tenantId →
		// { prefix, spa }`; adding a tenant is one more entry here + an asset prefix.
		const routes: Record<string, { prefix: string; spa: boolean }> = {};
		for (const t of props.tenants) {
			routes[t.tenantId] = { prefix: `t/${t.tenantId}`, spa: t.spaFallback !== false };
		}

		const router = new LambdaFunction(this, 'Router', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: Code.fromInline(generateTenantRouterCode()),
			timeout: Duration.seconds(10),
			memorySize: 256,
			environment: {
				ASSET_BUCKET: bucket.bucketName,
				TENANT_ROUTES: JSON.stringify(routes),
				TENANT_ROUTING: routing,
			},
		});
		bucket.grantRead(router);
		this.router = router;

		// ONE HTTP API: the `$default` route sends every request to the router.
		this.api = new HttpApi(this, 'HttpApi', {
			description: `MT-POC one API / ${props.tenants.length} tenants (${routing})`,
			defaultIntegration: new HttpLambdaIntegration('RouterInt', router),
		});

		// Each tenant's assets upload to its own prefix; the router rewrites the
		// request into `t/<tenantId>/…`. One bucket, N prefixes.
		for (const t of props.tenants) {
			new BucketDeployment(this, `Deploy-${t.tenantId}`, {
				sources: [Source.asset(t.assetDir)],
				destinationBucket: bucket,
				destinationKeyPrefix: `t/${t.tenantId}`,
			});
		}
	}
}
