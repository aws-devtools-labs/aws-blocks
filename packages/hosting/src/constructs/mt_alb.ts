/**
 * MultiTenantAlb — EXPERIMENTAL / PROOF-OF-CONCEPT.
 *
 * One Application Load Balancer (ALB) fronting N tenant apps, routed by tenant
 * key. The ALB sibling of {@link MultiTenantCloudFront} — the concrete
 * demonstration of the shared multi-tenant front-door mechanism from the design
 * notes, on the ALB door:
 *
 *   one ALB + ONE default action → ONE router Lambda + a tenant route table
 *
 * How it works:
 *   - ONE internet-facing ALB with a single HTTP :80 listener (no certificate —
 *     path/Host routing works over HTTP for the POC). A default 2-AZ, public-only
 *     VPC (no NAT Gateway) is created when one isn't supplied.
 *   - ONE default listener action → a SINGLE Lambda target group (the router).
 *     There is deliberately NO listener rule per tenant — a rule-per-tenant design
 *     hits the ~100-rule/listener cap almost immediately, which is the whole thing
 *     the shared door avoids.
 *   - ONE private S3 bucket holds every tenant's assets under `t/<tenantId>/…`.
 *   - The router Lambda (ALB target contract) reads the tenant from the first path
 *     segment (`/<tenantId>/…`) — or, in `subdomain` mode, the Host header's first
 *     DNS label — looks it up in a baked `tenantId → { prefix, spa }` route table,
 *     streams the object from `t/<tenantId>/…` (extensionless → `index.html`, SPA
 *     fallback), stamps `x-tenant-id`, and 404s an unknown tenant.
 *
 * Adding a tenant is a route-table entry + a per-tenant asset prefix — NOT a new
 * ALB, listener, or rule. That is what lets one ALB carry many tenants.
 *
 * POC scope: static/SPA tenants only (no per-tenant SSR/backend, no custom
 * domains/TLS, no per-tenant WAF/throttle yet). It exists to prove the
 * one-ALB/N-tenants routing substrate end to end. `routing: 'subdomain'` reads
 * the Host header; wiring real DNS + a wildcard certificate onto the ALB is
 * separate plumbing, out of scope here.
 */

import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Code, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { BlockPublicAccess, Bucket, type IBucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

/** How the shared ALB tells tenants apart. */
export type MultiTenantAlbRouting = 'path' | 'subdomain';

/** One tenant fronted by the shared ALB. */
export type MultiTenantAlbEntry = {
	/** Tenant key — the first path segment (`/<tenantId>/…`) or subdomain label. Lowercase `[a-z0-9-]`. */
	tenantId: string;
	/** Local directory of the tenant's built static assets (uploaded to `t/<tenantId>/`). */
	assetDir: string;
	/** Single-page-app fallback (extensionless → the tenant's `index.html`). Default `true`. */
	spaFallback?: boolean;
};

export type MultiTenantAlbProps = {
	/** The tenants to front. Must be non-empty with unique, valid ids. */
	tenants: MultiTenantAlbEntry[];
	/** How tenants are distinguished. `'path'` (default) = first path segment; `'subdomain'` = Host first label. */
	routing?: MultiTenantAlbRouting;
	/** Bring-your-own VPC. When omitted, a default 2-AZ public-only VPC (no NAT) is created. */
	vpc?: ec2.IVpc;
	/** Removal policy for the shared assets bucket. Default `DESTROY` (POC). */
	removalPolicy?: RemovalPolicy;
};

const TENANT_ID_RE = /^[a-z0-9-]+$/;

/**
 * The router Lambda source (ALB ↔ Lambda contract): tenant from the first path
 * segment (path mode) or the Host header's first label (subdomain mode) → route
 * table lookup → stream the tenant's object from its `t/<tenantId>/` prefix.
 * Inline, dependency-free (uses `@aws-sdk/client-s3`, present in the Node.js
 * Lambda runtime). Reads the route table + mode from the environment.
 */
const generateTenantRouterCode = (): string => `const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
const BUCKET = process.env.ASSET_BUCKET;
const ROUTES = JSON.parse(process.env.TENANT_ROUTES || '{}');
const MODE = process.env.ROUTING || 'path';

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  map: 'application/json', webmanifest: 'application/manifest+json',
};
function contentTypeFor(key) {
  const dot = key.lastIndexOf('.');
  const ext = dot === -1 ? '' : key.substring(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}
async function readStream(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function notFound(msg) {
  return { statusCode: 404, statusDescription: '404 Not Found', isBase64Encoded: false,
    headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'MT-ALB: ' + msg };
}
exports.handler = async (event) => {
  const uri = event.path || '/';
  const headers = event.headers || {};
  let tenant, rest;
  if (MODE === 'subdomain') {
    const host = String(headers.host || headers.Host || '').split(':')[0];
    tenant = host.split('.')[0];
    rest = uri;
  } else {
    const m = uri.match(/^\\/([^\\/]+)(\\/.*)?$/);
    if (!m) return notFound('no tenant in path');
    tenant = m[1];
    rest = m[2] || '/';
  }
  const meta = ROUTES[tenant];
  if (!meta) return notFound('unknown tenant ' + tenant);
  const lastSeg = rest.substring(rest.lastIndexOf('/') + 1);
  if (lastSeg.indexOf('.') === -1) {
    if (meta.spa) rest = '/index.html';
    else rest = rest.charAt(rest.length - 1) === '/' ? rest + 'index.html' : rest + '/index.html';
  }
  const prefix = String(meta.prefix).replace(/^\\/+|\\/+$/g, '');
  const key = prefix + '/' + rest.replace(/^\\/+/, '');
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buf = await readStream(res.Body);
    const contentType = res.ContentType || contentTypeFor(key);
    const isHtml = contentType.indexOf('text/html') === 0;
    return {
      statusCode: 200, statusDescription: '200 OK', isBase64Encoded: true,
      headers: {
        'content-type': contentType,
        'cache-control': isHtml ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
        'x-tenant-id': tenant,
      },
      body: buf.toString('base64'),
    };
  } catch (err) {
    if (meta.spa && key.slice(-10) !== 'index.html') {
      try {
        const idxKey = prefix + '/index.html';
        const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: idxKey }));
        const buf = await readStream(r.Body);
        return { statusCode: 200, statusDescription: '200 OK', isBase64Encoded: true,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate', 'x-tenant-id': tenant },
          body: buf.toString('base64') };
      } catch (_e) { /* fall through */ }
    }
    return notFound('not found: ' + key);
  }
};
`;

/**
 * One ALB fronting many tenants. See the file header for the mechanism.
 * Experimental POC — not part of the supported public API yet.
 */
export class MultiTenantAlb extends Construct {
	/** The single shared load balancer. */
	readonly loadBalancer: elbv2.ApplicationLoadBalancer;
	/** The single shared assets bucket (`t/<tenantId>/…`). */
	readonly bucket: IBucket;
	/** The VPC the ALB lives in (created or bring-your-own). */
	readonly vpc: ec2.IVpc;
	/** Public URL of the deploy (`http://<alb-dns>`). */
	readonly url: string;

	constructor(scope: Construct, id: string, props: MultiTenantAlbProps) {
		super(scope, id);

		if (!props.tenants || props.tenants.length === 0) {
			throw new HostingError('InvalidPropsError', {
				message: 'MultiTenantAlb requires at least one tenant.',
				resolution: 'Pass `tenants: [{ tenantId, assetDir }]`.',
			});
		}
		const seen = new Set<string>();
		for (const t of props.tenants) {
			if (!TENANT_ID_RE.test(t.tenantId)) {
				throw new HostingError('InvalidPropsError', {
					message: `Invalid tenantId '${t.tenantId}'.`,
					resolution: 'Tenant ids must match /^[a-z0-9-]+$/ (they are a URL path segment / subdomain label).',
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

		const routing: MultiTenantAlbRouting = props.routing ?? 'path';
		const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

		const bucket = new Bucket(this, 'Assets', {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			enforceSSL: true,
			removalPolicy,
			autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
		});
		this.bucket = bucket;

		// A public ALB lives in public subnets and the router Lambda is not
		// VPC-attached, so the default VPC needs no private subnets and no NAT
		// Gateway (which would be billed-but-idle). Matches AlbConstruct's default.
		this.vpc =
			props.vpc ??
			new ec2.Vpc(this, 'Vpc', {
				maxAzs: 2,
				natGateways: 0,
				subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
			});

		// The tenant route table, baked into the router Lambda's environment
		// (POC: seeded at synth; a data-driven runtime table is the design's
		// follow-up). value = `{ prefix, spa }` per tenant.
		const routes: Record<string, { prefix: string; spa: boolean }> = {};
		for (const t of props.tenants) {
			routes[t.tenantId] = { prefix: `t/${t.tenantId}`, spa: t.spaFallback !== false };
		}

		const router = new LambdaFunction(this, 'TenantRouter', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: Code.fromInline(generateTenantRouterCode()),
			timeout: Duration.seconds(15),
			memorySize: 256,
			environment: {
				ASSET_BUCKET: bucket.bucketName,
				TENANT_ROUTES: JSON.stringify(routes),
				ROUTING: routing,
			},
		});
		bucket.grantRead(router);

		// ONE ALB, ONE listener, ONE default action → the router Lambda target.
		// No per-tenant listener rules (that would hit the ~100-rule/listener cap).
		this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
			vpc: this.vpc,
			internetFacing: true,
		});
		const routerTg = new elbv2.ApplicationTargetGroup(this, 'RouterTg', {
			targetType: elbv2.TargetType.LAMBDA,
			targets: [new targets.LambdaTarget(router)],
			healthCheck: { enabled: false },
		});
		this.loadBalancer.addListener('Listener', {
			port: 80,
			protocol: elbv2.ApplicationProtocol.HTTP,
			defaultTargetGroups: [routerTg],
		});

		// Each tenant's assets upload to its own prefix; the router rewrites to it.
		// One bucket, N prefixes.
		for (const t of props.tenants) {
			new BucketDeployment(this, `Deploy-${t.tenantId}`, {
				sources: [Source.asset(t.assetDir)],
				destinationBucket: bucket,
				destinationKeyPrefix: `t/${t.tenantId}`,
			});
		}

		this.url = `http://${this.loadBalancer.loadBalancerDnsName}`;
		new CfnOutput(this, 'AlbUrl', { value: this.url, description: 'Multi-tenant ALB URL' });
		new CfnOutput(this, 'AlbDnsName', {
			value: this.loadBalancer.loadBalancerDnsName,
			description: 'ALB DNS name — point a wildcard CNAME here for subdomain-per-tenant.',
		});
	}

	/** The ALB's public DNS name. */
	get domainName(): string {
		return this.loadBalancer.loadBalancerDnsName;
	}
}
