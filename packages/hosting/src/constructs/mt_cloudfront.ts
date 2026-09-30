/**
 * MultiTenantCloudFront — EXPERIMENTAL / PROOF-OF-CONCEPT.
 *
 * One CloudFront distribution fronting N tenant apps, routed by the first path
 * segment (`/<tenantId>/…`, default) or the Host header's first DNS label
 * (`<tenantId>.host`) — see `routing`. This is the concrete demonstration of the shared
 * multi-tenant front-door mechanism from the design notes:
 *
 *   single behavior + a KeyValueStore (KVS) tenant route table + one distribution
 *
 * How it works:
 *   - ONE private S3 bucket holds every tenant's built assets under a per-tenant
 *     prefix `t/<tenantId>/…`.
 *   - ONE CloudFront `Distribution` with a SINGLE default behavior → the bucket
 *     via Origin Access Control (OAC).
 *   - A CloudFront KVS holds the tenant route table (`tenantId → { prefix, spa }`),
 *     seeded at create time from the tenant list.
 *   - A viewer-request CloudFront Function reads the first path segment as the
 *     tenant, looks it up in the KVS, rewrites the request URI to
 *     `/t/<tenantId>/<rest>` (extensionless → `index.html`; SPA fallback to the
 *     tenant's `index.html`), stamps `x-tenant-id` inward (the tenant-context
 *     contract), and 404s an unknown tenant.
 *
 * Adding a tenant is a KVS entry + a per-tenant asset prefix — NOT a new
 * distribution or a new cache behavior. That is what lets one distribution carry
 * thousands of tenants (a per-tenant CloudFront behavior would hit the ~25/
 * distribution limit almost immediately).
 *
 * POC scope: static/SPA tenants only (no per-tenant SSR/backend, no custom
 * domains, no per-tenant cache-key isolation yet). It exists to prove the
 * one-distribution/N-tenants routing substrate end to end.
 */

import { RemovalPolicy } from 'aws-cdk-lib';
import {
	Function as CloudFrontFunction,
	Distribution,
	FunctionCode,
	FunctionEventType,
	FunctionRuntime,
	ImportSource,
	KeyValueStore,
	ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, type IBucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';

/** One tenant fronted by the shared distribution. */
export type MultiTenantEntry = {
	/** Tenant key — the first path segment (`/<tenantId>/…`). Lowercase `[a-z0-9-]`. */
	tenantId: string;
	/** Local directory of the tenant's built static assets (uploaded to `t/<tenantId>/`). */
	assetDir: string;
	/** Single-page-app fallback (extensionless → the tenant's `index.html`). Default `true`. */
	spaFallback?: boolean;
};

export type MultiTenantCloudFrontProps = {
	/** The tenants to front. Must be non-empty with unique, valid ids. */
	tenants: MultiTenantEntry[];
	/**
	 * How tenants are addressed — `path` (`/<tenant>/…`, default) or `subdomain`
	 * (tenant = the Host header's first DNS label, `<tenant>.host`). Note: real
	 * subdomain serving needs the distribution's alternate domain names + a
	 * wildcard TLS cert; this POC exercises the Host-based routing logic only.
	 */
	routing?: 'path' | 'subdomain';
	/** Removal policy for the shared assets bucket. Default `DESTROY` (POC). */
	removalPolicy?: RemovalPolicy;
};

const TENANT_ID_RE = /^[a-z0-9-]+$/;

/**
 * The viewer-request CloudFront Function: resolves the tenant (first path
 * segment in `path` mode, or the Host header's first DNS label in `subdomain`
 * mode) → KVS lookup → URI rewrite into the tenant's prefix. Runtime
 * `cloudfront-js-2.0` (async KVS access). Kept inline and dependency-free.
 */
const generateTenantRouterCode = (routing: 'path' | 'subdomain'): string => `import cf from 'cloudfront';
var KVS = cf.kvs();
var ROUTING = ${JSON.stringify(routing)};
async function handler(event) {
  var req = event.request;
  var uri = req.uri || '/';
  var tenant, rest;
  if (ROUTING === 'subdomain') {
    var hostHeader = (req.headers.host && req.headers.host.value) ? req.headers.host.value : '';
    tenant = hostHeader.split(':')[0].split('.')[0];
    rest = uri;
    if (!tenant) {
      return { statusCode: 404, statusDescription: 'Not Found', headers: {}, body: 'MT-POC: no tenant in host' };
    }
  } else {
    var m = uri.match(/^\\/([^\\/]+)(\\/.*)?$/);
    if (!m) {
      return { statusCode: 404, statusDescription: 'Not Found', headers: {}, body: 'MT-POC: no tenant in path' };
    }
    tenant = m[1];
    rest = m[2] || '/';
  }
  var meta;
  try {
    var raw = await KVS.get(tenant);
    meta = JSON.parse(raw);
  } catch (e) {
    return { statusCode: 404, statusDescription: 'Not Found', headers: {}, body: 'MT-POC: unknown tenant ' + tenant };
  }
  var lastSeg = rest.substring(rest.lastIndexOf('/') + 1);
  if (lastSeg.indexOf('.') === -1) {
    if (meta.spa) { rest = '/index.html'; }
    else { rest = rest.charAt(rest.length - 1) === '/' ? rest + 'index.html' : rest + '/index.html'; }
  }
  var prefix = String(meta.prefix).replace(/^\\/+|\\/+$/g, '');
  req.uri = '/' + prefix + rest;
  // Stamp the tenant context inward — the 'X-Tenant-Id' contract from the design.
  req.headers['x-tenant-id'] = { value: tenant };
  return req;
}
`;

/**
 * One CloudFront distribution fronting many tenants. See the file header for the
 * mechanism. Experimental POC — not part of the supported public API yet.
 */
export class MultiTenantCloudFront extends Construct {
	/** The single shared distribution. */
	readonly distribution: Distribution;
	/** The single shared assets bucket (`t/<tenantId>/…`). */
	readonly bucket: IBucket;

	/** The distribution's public domain name. */
	get domainName(): string {
		return this.distribution.distributionDomainName;
	}

	constructor(scope: Construct, id: string, props: MultiTenantCloudFrontProps) {
		super(scope, id);

		if (!props.tenants || props.tenants.length === 0) {
			throw new HostingError('InvalidPropsError', {
				message: 'MultiTenantCloudFront requires at least one tenant.',
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

		const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;
		const bucket = new Bucket(this, 'Assets', {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			enforceSSL: true,
			removalPolicy,
			autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
		});
		this.bucket = bucket;

		// The tenant route table, seeded at create time. KVS import format is
		// `{ data: [{ key, value }] }`; value is the per-tenant JSON the edge
		// function parses (`{ prefix, spa }`).
		const store = new KeyValueStore(this, 'TenantRoutes', {
			comment: `MT-POC tenant route table for ${this.node.path}`,
			source: ImportSource.fromInline(
				JSON.stringify({
					data: props.tenants.map((t) => ({
						key: t.tenantId,
						value: JSON.stringify({ prefix: `t/${t.tenantId}`, spa: t.spaFallback !== false }),
					})),
				}),
			),
		});

		const routing = props.routing ?? 'path';
		const router = new CloudFrontFunction(this, 'TenantRouter', {
			code: FunctionCode.fromInline(generateTenantRouterCode(routing)),
			runtime: FunctionRuntime.JS_2_0,
			keyValueStore: store,
			comment: `MT-POC: ${routing} tenant → KVS prefix rewrite`,
		});

		this.distribution = new Distribution(this, 'Distribution', {
			comment: `MT-POC one distribution / ${props.tenants.length} tenants`,
			defaultBehavior: {
				origin: S3BucketOrigin.withOriginAccessControl(bucket, { originId: 'mt-s3' }),
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				functionAssociations: [{ function: router, eventType: FunctionEventType.VIEWER_REQUEST }],
			},
		});

		// Each tenant's assets upload to its own prefix; the edge function rewrites
		// `/<tenantId>/…` → `/t/<tenantId>/…`. One bucket, N prefixes.
		for (const t of props.tenants) {
			new BucketDeployment(this, `Deploy-${t.tenantId}`, {
				sources: [Source.asset(t.assetDir)],
				destinationBucket: bucket,
				destinationKeyPrefix: `t/${t.tenantId}`,
			});
		}
	}
}
