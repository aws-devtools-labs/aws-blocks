import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PriceClass } from 'aws-cdk-lib/aws-cloudfront';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import {
  Code,
  FunctionUrlAuthType,
  IVersion,
  InvokeMode,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { CdnConstruct } from './cdn_construct.js';
import { createSecurityHeadersPolicy } from './security_headers.js';
import { HostingError } from '../hosting_error.js';
import { DeployManifest } from '../manifest/types.js';
import { ORIGIN_ID, buildKvsEntries } from './kvs_router.js';

// ---- KVS edge-router helpers ----
//
// Routing is no longer expressed as per-route CloudFront cache behaviors. The
// distribution has ONE default behavior; routing decisions live in a
// KeyValueStore route table built by `buildKvsEntries`. Tests that used to
// assert "pattern X → origin Y" now assert (a) the distribution carries the
// expected stable origin ids, and (b) `buildKvsEntries` maps the pattern to
// the right route kind ('s' static / 'c' compute / 'i' image).

/** Origin ids present on the synthesized distribution (Origins[].Id). */
const originIds = (template: Template): string[] => {
  const dist = Object.values(
    template.findResources('AWS::CloudFront::Distribution'),
  )[0] as {
    Properties: { DistributionConfig: { Origins: { Id: string }[] } };
  };
  return dist.Properties.DistributionConfig.Origins.map((o) => o.Id);
};

/** Additional (non-default) cache-behavior path patterns on the distribution. */
const additionalBehaviorPatterns = (template: Template): string[] => {
  const dist = Object.values(
    template.findResources('AWS::CloudFront::Distribution'),
  )[0] as {
    Properties: {
      DistributionConfig: { CacheBehaviors?: { PathPattern: string }[] };
    };
  };
  return (dist.Properties.DistributionConfig.CacheBehaviors ?? []).map(
    (b) => b.PathPattern,
  );
};

/**
 * Flatten the route-table chunks (r0..rN) of a buildKvsEntries() map into a
 * single [pattern, kind] list so tests can assert routing decisions directly.
 */
const routeRows = (
  entries: Record<string, string>,
): [string, string][] => {
  const rows: [string, string][] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (/^r\d+$/.test(key)) {
      rows.push(...(JSON.parse(value) as [string, string][]));
    }
  }
  return rows;
};

// ---- Test helpers ----

const createStack = (): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack');
};

const createEnvStack = (
  region = 'us-east-1',
  account = '123456789012',
): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack', { env: { account, region } });
};

const spaManifest: DeployManifest = {
  version: 1,
  compute: {},
  staticAssets: { directory: '/tmp/assets' },
  routes: [{ pattern: '/*', target: 'static' }],
  buildId: 'test-spa-1',
};

const ssrManifest: DeployManifest = {
  version: 1,
  compute: {
    default: {
      type: 'handler',
      bundle: '/tmp/bundle',
      handler: 'index.handler',
      placement: 'regional',
    },
  },
  staticAssets: { directory: '/tmp/assets' },
  routes: [
    { pattern: '/_next/static/*', target: 'static' },
    { pattern: '/favicon.ico', target: 'static' },
    { pattern: '/*', target: 'default' },
  ],
  buildId: 'test-ssr-1',
};

/**
 * Create a dummy Lambda + Function URL for SSR testing.
 */
const createSsrFunction = (stack: Stack) => {
  const fn = new LambdaFunction(stack, 'SsrFn', {
    runtime: Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: Code.fromInline('exports.handler = async () => {};'),
  });
  const fnUrl = fn.addFunctionUrl({
    authType: FunctionUrlAuthType.AWS_IAM,
    invokeMode: InvokeMode.RESPONSE_STREAM,
  });
  return { fn, fnUrl };
};

// ================================================================
// CdnConstruct — unit tests
// ================================================================

void describe('CdnConstruct', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-construct-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- SPA mode ----

  void describe('SPA mode (no compute)', () => {
    void it('creates CloudFront distribution with S3 origin', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const cdn = new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      assert.ok(cdn.distribution);
      assert.ok(cdn.distributionUrl);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          HttpVersion: 'http2and3',
        }),
      });
    });

    void it('creates 403/404 error responses for SPA', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      // SPA fallback is now handled in the viewer-request function
      // (navigation requests without file extension rewrite to /index.html).
      // No 403/404 custom error responses needed — missing assets correctly
      // return 403 without a blanket fallback.
      const dist = template.findResources('AWS::CloudFront::Distribution');
      const distProps = Object.values(dist)[0].Properties.DistributionConfig;
      assert.equal(
        distProps.CustomErrorResponses,
        undefined,
        'SPA should not have custom error responses (fallback is in viewer-request function)',
      );
    });

    void it('stores buildId in the KVS route table (not baked into the function)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      // The KVS edge router is build-INDEPENDENT: the buildId lives in the
      // KeyValueStore (written by the RouteStoreKeys custom resource), not in
      // the function source. There is one KeyValueStore and one custom
      // resource carrying the buildId in its serialized entries.
      template.resourceCountIs('AWS::CloudFront::KeyValueStore', 1);
      template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
        Entries: Match.stringLikeRegexp('test-spa-1'),
      });
      // And the buildId is in the meta blob produced by the pure builder.
      const entries = buildKvsEntries({
        manifest: spaManifest,
        buildId: 'test-spa-1',
        hasServer: false,
        hasImage: false,
      });
      assert.match(entries.meta, /test-spa-1/);
    });

    void it('does NOT emit a per-prefix behavior when manifest.assetPrefix is set (single-behavior model)', () => {
      // The legacy model emitted a dedicated `<assetPrefix>/*` cache behavior
      // (and a prefix-strip CloudFront Function), consuming a slot of the
      // CloudFront additional-behavior cap. The single-behavior KVS router
      // eliminates per-prefix behaviors entirely: there is one default
      // behavior and asset routing is data in the KVS, not infrastructure.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const prefixedManifest = {
        ...spaManifest,
        assetPrefix: '/shop-static',
      };

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest: prefixedManifest,
            securityHeadersPolicy: policy,
          }),
      );

      const template = Template.fromStack(stack);
      // Static-only deploy → exactly the S3 origin and ZERO additional
      // behaviors (no `/shop-static/*`).
      assert.deepEqual(originIds(template), [ORIGIN_ID.s3]);
      assert.deepEqual(additionalBehaviorPatterns(template), []);
    });

    void it('uses real 404 response when manifest.errorPages declares /404.html (B15)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      // Static deploy with a real 404.html (e.g. Next.js `output: 'export'`).
      const exportManifest = {
        ...spaManifest,
        errorPages: { 404: '/404.html' as const },
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: exportManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      // Real 404 with 404 status, pointing at the build-id-prefixed path.
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CustomErrorResponses: Match.arrayWith([
            Match.objectLike({
              ErrorCode: 404,
              ResponseCode: 404,
              ResponsePagePath: Match.stringLikeRegexp('/404\\.html$'),
            }),
          ]),
        }),
      });
      // SPA fallback (403/404 → 200 /index.html) must NOT be present.
      const config = template.findResources('AWS::CloudFront::Distribution');
      const distRecord = Object.values(config)[0] as Record<string, unknown>;
      const distProps = distRecord['Properties'] as Record<string, unknown>;
      const distCfg = distProps['DistributionConfig'] as Record<
        string,
        unknown
      >;
      const responses = distCfg['CustomErrorResponses'] as
        | Array<Record<string, unknown>>
        | undefined;
      const hasSpaFallback = (responses ?? []).some(
        (r) =>
          (r['ErrorCode'] as number) === 404 &&
          (r['ResponseCode'] as number | undefined) === 200,
      );
      assert.equal(
        hasSpaFallback,
        false,
        'SPA fallback (404→200 /index.html) must not be present when errorPages set',
      );
    });
  });

  // ---- Explicit spaFallback signal (multi-page static) ----

  void describe('explicit staticAssets.spaFallback', () => {
    void it('records spaFallback:false in KVS meta (directory-index, not blanket SPA)', () => {
      // The KVS router function is build-independent and ships BOTH the
      // directory-index and SPA-blanket branches; which one runs is decided
      // at request time from the `meta.spa` flag in the KVS — so the
      // spaFallback decision is now data, asserted on buildKvsEntries() meta.
      const multiPageManifest: DeployManifest = {
        ...spaManifest,
        staticAssets: { directory: '/tmp/assets', spaFallback: false },
      };

      const entries = buildKvsEntries({
        manifest: multiPageManifest,
        buildId: 'test-spa-1',
        hasServer: false,
        hasImage: false,
      });
      const meta = JSON.parse(entries.meta) as { spa: number };
      assert.equal(meta.spa, 0, 'spaFallback:false → meta.spa must be 0');
    });

    void it('honors explicit spaFallback:true even when errorPages are present', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      // errorPages present would, under the legacy heuristic, disable SPA
      // fallback. The explicit signal must win.
      const spaWithErrorPages: DeployManifest = {
        ...spaManifest,
        staticAssets: { directory: '/tmp/assets', spaFallback: true },
        errorPages: { 404: '/404.html' as const },
      };

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest: spaWithErrorPages,
            securityHeadersPolicy: policy,
          }),
      );

      // The explicit spaFallback:true signal must win over the errorPages
      // heuristic → meta.spa must be 1 (SPA blanket rewrite at the edge).
      const entries = buildKvsEntries({
        manifest: spaWithErrorPages,
        buildId: 'test-spa-1',
        hasServer: false,
        hasImage: false,
      });
      const meta = JSON.parse(entries.meta) as { spa: number };
      assert.equal(meta.spa, 1, 'explicit spaFallback:true → meta.spa must be 1');
    });

    void it('wires a default 404 response for multi-page static with no errorPages', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const multiPageNoErr: DeployManifest = {
        ...spaManifest,
        staticAssets: { directory: '/tmp/assets', spaFallback: false },
      };

      const cdn = new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: multiPageNoErr,
        securityHeadersPolicy: policy,
      });

      // The construct should expose the built-in default 404 page so the
      // L3 can deploy it.
      assert.ok(
        cdn.defaultNotFoundPageHtml &&
          cdn.defaultNotFoundPageHtml.includes('404'),
        'multi-page static with no 404 should get a default 404 page',
      );

      // And wire CloudFront 403/404 → the default page at status 404.
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CustomErrorResponses: Match.arrayWith([
            Match.objectLike({
              ErrorCode: 403,
              ResponseCode: 404,
              ResponsePagePath: Match.stringLikeRegexp('_not_found\\.html$'),
            }),
            Match.objectLike({
              ErrorCode: 404,
              ResponseCode: 404,
              ResponsePagePath: Match.stringLikeRegexp('_not_found\\.html$'),
            }),
          ]),
        }),
      });
    });

    void it('does NOT add a default 404 when the framework emitted its own (errorPages set)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const multiPageWithErr: DeployManifest = {
        ...spaManifest,
        staticAssets: { directory: '/tmp/assets', spaFallback: false },
        errorPages: { 404: '/404.html' as const },
      };

      const cdn = new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: multiPageWithErr,
        securityHeadersPolicy: policy,
      });

      assert.equal(
        cdn.defaultNotFoundPageHtml,
        undefined,
        'framework-emitted 404 takes precedence over the built-in default',
      );
    });

    void it('does NOT add a default 404 for SPA sites', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const cdn = new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: {
          ...spaManifest,
          staticAssets: { directory: '/tmp/assets', spaFallback: true },
        },
        securityHeadersPolicy: policy,
      });

      assert.equal(
        cdn.defaultNotFoundPageHtml,
        undefined,
        'SPA sites deep-link to /index.html at 200; no default 404',
      );
    });
  });

  // ---- SSR mode ----

  void describe('SSR mode (with compute)', () => {
    void it('creates distribution with Lambda Function URL origin', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            AllowedMethods: Match.arrayWith([
              'GET',
              'HEAD',
              'OPTIONS',
              'PUT',
              'PATCH',
              'POST',
              'DELETE',
            ]),
          }),
        }),
      });
    });

    void it('uses a custom CachePolicy that honors origin Cache-Control on SSR (B21)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      // SSR cache policy is created with a content-derived comment.
      // NOTE: CloudFront rejects `Accept-Encoding` from `headerBehavior.allowList`
      // when `EnableAcceptEncodingGzip:true` is set — gzip handling is implicit
      // in that flag. So the allowList only contains the Next.js router cache
      // keys, not Accept-Encoding.
      template.hasResourceProperties(
        'AWS::CloudFront::CachePolicy',
        Match.objectLike({
          CachePolicyConfig: Match.objectLike({
            Comment: Match.stringLikeRegexp('SSR/ISR/SWR'),
            // Min/default 0 (origin opts out via no-store); max 1 year
            // (clamps wild origin values).
            MinTTL: 0,
            DefaultTTL: 0,
            MaxTTL: 31536000,
            ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
              EnableAcceptEncodingBrotli: true,
              EnableAcceptEncodingGzip: true,
              HeadersConfig: Match.objectLike({
                HeaderBehavior: 'whitelist',
                Headers: Match.arrayWith([
                  'rsc',
                  'next-router-prefetch',
                  'next-router-state-tree',
                  'next-router-segment-prefetch',
                  // Server Actions identify themselves with this header.
                  'next-action',
                ]),
              }),
              CookiesConfig: Match.objectLike({
                CookieBehavior: 'whitelist',
                // Next.js Draft Mode preview cookies — cache key
                // includes them so preview requests bypass cached
                // anonymous responses.
                Cookies: Match.arrayWith([
                  '__prerender_bypass',
                  '__next_preview_data',
                ]),
              }),
            }),
          }),
        }),
      );

      // Assert Accept-Encoding is NOT in the allowList (CloudFront rejects
      // it alongside EnableAcceptEncodingGzip:true).
      const cachePolicies = template.findResources(
        'AWS::CloudFront::CachePolicy',
      );
      const ssrPolicy = Object.values(cachePolicies).find((r) => {
        const props = (r as Record<string, Record<string, unknown>>).Properties;
        const cfg = props.CachePolicyConfig as Record<string, unknown>;
        return typeof cfg.Comment === 'string' && cfg.Comment.includes('SSR');
      }) as Record<string, Record<string, unknown>> | undefined;
      assert.ok(ssrPolicy, 'Should have an SSR CachePolicy');
      const cfg = ssrPolicy.Properties.CachePolicyConfig as Record<
        string,
        unknown
      >;
      const params = cfg.ParametersInCacheKeyAndForwardedToOrigin as Record<
        string,
        unknown
      >;
      const headersCfg = params.HeadersConfig as Record<string, unknown>;
      const headers = (headersCfg.Headers ?? []) as string[];
      const lowerHeaders = headers.map((h) => h.toLowerCase());
      assert.ok(
        !lowerHeaders.includes('accept-encoding'),
        'Accept-Encoding must NOT appear in headerBehavior.allowList when EnableAcceptEncodingGzip:true',
      );
      // SSR default behavior must reference our custom CachePolicy
      // (synthesized as a Ref), NOT the AWS-managed CACHING_DISABLED
      // policy (which would be a string ID literal).
      const json = template.toJSON() as Record<string, unknown>;
      const resources = json['Resources'] as Record<
        string,
        Record<string, unknown>
      >;
      const distResource = Object.values(resources).find(
        (r) => r['Type'] === 'AWS::CloudFront::Distribution',
      );
      const props = distResource?.['Properties'] as
        | Record<string, unknown>
        | undefined;
      const distConfig = props?.['DistributionConfig'] as
        | Record<string, unknown>
        | undefined;
      const defaultBehavior = distConfig?.['DefaultCacheBehavior'] as
        | Record<string, unknown>
        | undefined;
      const cachePolicyId = defaultBehavior?.['CachePolicyId'];
      assert.equal(
        typeof cachePolicyId === 'object' &&
          cachePolicyId !== null &&
          'Ref' in (cachePolicyId as Record<string, unknown>),
        true,
        'SSR default behavior must use a synthesized CachePolicy (Ref), not the AWS-managed CACHING_DISABLED string ID (B21)',
      );
    });

    void it('routes static routes to S3 via the KVS table (no per-route behaviors)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      // Static routes are NOT per-route cache behaviors anymore. The only
      // additional behaviors are the origin-binding sentinels (server here).
      const patterns = additionalBehaviorPatterns(template);
      assert.ok(
        !patterns.includes('/_next/static/*') &&
          !patterns.includes('/favicon.ico'),
        `static routes must not be wired as behaviors; got ${JSON.stringify(patterns)}`,
      );
      assert.deepEqual(patterns.sort(), ['/__blocks_origin_server/*']);

      // The distribution carries the S3 + server origins by stable id.
      const ids = originIds(template);
      assert.ok(ids.includes(ORIGIN_ID.s3));
      assert.ok(ids.includes(ORIGIN_ID.server));

      // The KVS route table maps the static patterns to the S3 ('s') kind.
      const rows = routeRows(
        buildKvsEntries({
          manifest: ssrManifest,
          buildId: 'test-ssr-1',
          hasServer: true,
          hasImage: false,
        }),
      );
      const kindFor = (p: string) => rows.find(([pat]) => pat === p)?.[1];
      assert.equal(kindFor('/_next/static/*'), 's');
      assert.equal(kindFor('/favicon.ico'), 's');
    });

    void it('creates 5xx error responses for SSR', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CustomErrorResponses: Match.arrayWith([
            Match.objectLike({ ErrorCode: 502 }),
            Match.objectLike({ ErrorCode: 503 }),
            Match.objectLike({ ErrorCode: 504 }),
          ]),
        }),
      });
    });
  });

  // ---- APIGW origin verification ----

  void describe('APIGW origin verification (SSR via REST API)', () => {
    void it('RestApi has resource policy with DENY + StringNotEquals on aws:Referer', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn } = createSsrFunction(stack);

      // Don't pass computeFunctionUrls for 'default' — the L3 skips the
      // Function URL for SSR compute so that the APIGW origin is used.
      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Policy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: Match.objectLike({
                StringNotEquals: Match.objectLike({
                  'aws:Referer': Match.anyValue(),
                }),
              }),
            }),
          ]),
        }),
      });
    });

    void it('CloudFront origin custom headers include Referer', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Origins: Match.arrayWith([
            Match.objectLike({
              CustomOriginConfig: Match.anyValue(),
              OriginCustomHeaders: Match.arrayWith([
                Match.objectLike({
                  HeaderName: 'Referer',
                  HeaderValue: Match.anyValue(),
                }),
              ]),
            }),
          ]),
        }),
      });
    });

    void it('origin Referer header value matches resource policy secret', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      const json = template.toJSON() as Record<string, unknown>;
      const resources = json['Resources'] as Record<
        string,
        Record<string, unknown>
      >;

      // Extract the Referer value from the APIGW resource policy
      const restApi = Object.values(resources).find(
        (r) => r['Type'] === 'AWS::ApiGateway::RestApi',
      );
      const restApiProps = restApi?.['Properties'] as Record<string, unknown>;
      const policyDoc = restApiProps?.['Policy'] as Record<string, unknown>;
      const statements = policyDoc['Statement'] as Array<
        Record<string, unknown>
      >;
      const denyStatement = statements.find((s) => s['Effect'] === 'Deny');
      const condition = denyStatement?.['Condition'] as
        | Record<string, unknown>
        | undefined;
      const stringNotEquals = condition?.['StringNotEquals'] as
        | Record<string, string>
        | undefined;
      const policySecret = stringNotEquals?.['aws:Referer'];

      // Extract the Referer custom header value from the CloudFront origin
      const dist = Object.values(resources).find(
        (r) => r['Type'] === 'AWS::CloudFront::Distribution',
      );
      const distProps = dist?.['Properties'] as Record<string, unknown>;
      const distConfig = distProps?.['DistributionConfig'] as Record<
        string,
        unknown
      >;
      const origins = distConfig?.['Origins'] as Array<Record<string, unknown>>;
      const apiOrigin = origins.find((o) => o['OriginCustomHeaders']);
      const customHeaders = apiOrigin?.['OriginCustomHeaders'] as
        | Array<Record<string, string>>
        | undefined;
      const refererHeader = customHeaders?.find(
        (h) => h['HeaderName'] === 'Referer',
      );

      assert.ok(policySecret, 'Resource policy must contain a Referer secret');
      assert.ok(refererHeader, 'CloudFront origin must include Referer header');
      assert.strictEqual(
        refererHeader['HeaderValue'],
        policySecret,
        'Origin Referer header value must match the resource policy secret',
      );
    });
  });

  // ---- Validation ----

  void describe('validation', () => {
    void it('throws MissingBuildIdError when buildId is not set', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const manifestWithoutBuildId: DeployManifest = {
        version: 1,
        compute: {},
        staticAssets: { directory: '/tmp/assets' },
        routes: [{ pattern: '/*', target: 'static' }],
      };

      assert.throws(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest: manifestWithoutBuildId,
            securityHeadersPolicy: policy,
          }),
        (error: unknown) => {
          assert.ok(error instanceof HostingError);
          assert.strictEqual(error.name, 'MissingBuildIdError');
          return true;
        },
      );
    });

    void it('synthesizes >24 static routes without throwing (behavior cap eliminated)', () => {
      // The per-behavior cap is gone: route count is data in the KVS, not
      // CloudFront infrastructure. 25 specific routes + catch-all that used to
      // overflow the 24-additional-behavior cap now synth cleanly with ZERO
      // additional behaviors (static-only → just the S3 origin).
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const manyRoutes = Array.from({ length: 25 }, (_, i) => ({
        pattern: `/route-${i}`,
        target: 'static',
      }));
      manyRoutes.push({ pattern: '/*', target: 'static' });

      const manifest: DeployManifest = {
        version: 1,
        compute: {},
        staticAssets: { directory: '/tmp/assets' },
        routes: manyRoutes,
        buildId: 'test-1',
      };

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
          }),
      );
      const template = Template.fromStack(stack);
      assert.deepEqual(originIds(template), [ORIGIN_ID.s3]);
      assert.deepEqual(additionalBehaviorPatterns(template), []);

      // All 25 routes are in the KVS route table as static ('s').
      const rows = routeRows(
        buildKvsEntries({
          manifest,
          buildId: 'test-1',
          hasServer: false,
          hasImage: false,
        }),
      );
      assert.equal(rows.length, 25);
      assert.ok(rows.every(([, kind]) => kind === 's'));
    });

    void it('synthesizes many subtree routes without throwing (no derived-behavior cap)', () => {
      // The legacy model derived a bare `/page` behavior per `/page/*` route
      // and counted both against the cap. There is no behavior derivation now:
      // subtree routes are KVS rows. 40 of them synth with no additional
      // behaviors and no error.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const subtreeRoutes = Array.from({ length: 40 }, (_, i) => ({
        pattern: `/page-${i}/*`,
        target: 'static',
      }));
      subtreeRoutes.push({ pattern: '/*', target: 'static' });

      const manifest: DeployManifest = {
        version: 1,
        compute: {},
        staticAssets: { directory: '/tmp/assets' },
        routes: subtreeRoutes,
        buildId: 'test-derive-1',
      };

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
          }),
      );
      const template = Template.fromStack(stack);
      assert.deepEqual(additionalBehaviorPatterns(template), []);
    });

    void it('quotas.cacheBehaviors prop is accepted but no longer gates routing', () => {
      // The `quotas` prop still exists on CdnConstructProps (kept for type
      // compatibility), but the single-behavior router means behavior count is
      // fixed at 1-3 regardless of route count — there is no cap to raise.
      // Both the unset and set forms must synth identically and not throw.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const manyRoutes = Array.from({ length: 25 }, (_, i) => ({
        pattern: `/route-${i}`,
        target: 'static',
      }));
      manyRoutes.push({ pattern: '/*', target: 'static' });

      const manifest: DeployManifest = {
        version: 1,
        compute: {},
        staticAssets: { directory: '/tmp/assets' },
        routes: manyRoutes,
        buildId: 'test-quota-override-1',
      };

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'CdnDefault', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
          }),
      );
      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'CdnRaised', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
            quotas: { cacheBehaviors: 30 },
          }),
      );
    });

    void it('coalesces co-located sibling pages into one parent wildcard (static-only)', () => {
      // 24 sibling subtree pages under /docs synth with ZERO additional
      // behaviors. Because they share parent /docs and one kind (static), the
      // KVS builder coalesces them into a single `/docs/*` row — bounding the
      // per-request edge scan so a large SSG fan-out can't trip the CloudFront
      // Function instruction limit. All 24 still route to S3 via `/docs/*`.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const docRoutes = Array.from({ length: 24 }, (_, i) => ({
        pattern: `/docs/page-${i}/*`,
        target: 'static',
      }));
      const manifest: DeployManifest = {
        version: 1,
        compute: {},
        staticAssets: { directory: '/tmp/assets', spaFallback: false },
        routes: [...docRoutes, { pattern: '/*', target: 'static' }],
        buildId: 'test-group-1',
      };

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
          }),
      );
      const template = Template.fromStack(stack);
      assert.deepEqual(additionalBehaviorPatterns(template), []);
      // The sibling /docs/page-N/* rows are coalesced into a single /docs/*
      // wildcard (same kind), so the route table stays small.
      const rows = routeRows(
        buildKvsEntries({
          manifest,
          buildId: 'test-group-1',
          hasServer: false,
          hasImage: false,
        }),
      );
      const patterns = rows.map(([p]) => p);
      assert.ok(patterns.includes('/docs/*'));
      assert.ok(!patterns.includes('/docs/page-0/*'));
    });

    void it('keeps every page on the edge under compute (no demotion to the SSR runtime)', () => {
      // The legacy model "demoted" low-priority pages to the SSR Lambda when
      // over the behavior budget. There is no budget now: every static route
      // stays mapped to S3 ('s') in the KVS, regardless of count.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      const pageRoutes = Array.from({ length: 40 }, (_, i) => ({
        pattern: `/page-${i}/*`,
        target: 'static',
      }));
      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: { type: 'handler', bundle: '/tmp/b', handler: 'i.h', placement: 'regional' },
        },
        staticAssets: { directory: '/tmp/assets', immutablePaths: ['_nuxt/*'] },
        routes: [...pageRoutes, { pattern: '/*', target: 'default' }],
        buildId: 'test-demote-1',
      };

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
            computeFunctionUrls: new Map([['default', fnUrl]]),
            computeFunctions: new Map([['default', fn]]),
          }),
      );
      // Only the sentinel server binding behavior — no per-page behaviors.
      const template = Template.fromStack(stack);
      assert.deepEqual(additionalBehaviorPatterns(template).sort(), [
        '/__blocks_origin_server/*',
      ]);
      // Every page route remains static ('s') in the KVS table.
      const rows = routeRows(
        buildKvsEntries({
          manifest,
          buildId: 'test-demote-1',
          hasServer: true,
          hasImage: false,
        }),
      );
      const pageRows = rows.filter(([p]) => p.startsWith('/page-'));
      assert.equal(pageRows.length, 40);
      assert.ok(pageRows.every(([, kind]) => kind === 's'));
    });

    void it('keeps a hashed-asset prefix on S3 in the route table under compute', () => {
      // _nuxt/* (hashed assets) must resolve from S3, never the SSR Lambda.
      // In the KVS model it is simply a static ('s') row alongside the pages.
      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: { type: 'handler', bundle: '/tmp/b', handler: 'i.h', placement: 'regional' },
        },
        staticAssets: { directory: '/tmp/assets', immutablePaths: ['_nuxt/*'] },
        routes: [
          { pattern: '/_nuxt/*', target: 'static' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'test-demote-keep-assets',
      };

      const rows = routeRows(
        buildKvsEntries({
          manifest,
          buildId: 'test-demote-keep-assets',
          hasServer: true,
          hasImage: false,
        }),
      );
      const nuxt = rows.find(([p]) => p === '/_nuxt/*');
      assert.ok(nuxt, `/_nuxt/* must be in the route table; got ${JSON.stringify(rows)}`);
      assert.equal(nuxt[1], 's', '/_nuxt/* must route to S3 (static), not compute');
    });

    void it('quotas.edgeFunctions override raises the edge-function cap', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const edgeRoutes: Map<string, IVersion> = new Map();
      for (let i = 0; i < 26; i++) {
        const fn = new LambdaFunction(stack, `QEdgeFn${i}`, {
          runtime: Runtime.NODEJS_20_X,
          handler: 'index.handler',
          code: Code.fromInline('exports.handler = async () => {};'),
        });
        edgeRoutes.set(`/edge-${i}`, fn.currentVersion);
      }
      const manifest: DeployManifest = {
        version: 1,
        compute: {},
        staticAssets: { directory: '/tmp/assets' },
        routes: [{ pattern: '/*', target: 'static' }],
        buildId: 'test-quota-edge-1',
      };
      // 26 edge routes > default 25 → throws; raised to 30 → fine.
      assert.throws(
        () =>
          new CdnConstruct(stack, 'CdnEdgeDefault', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
            routeEdgeFunctions: edgeRoutes,
          }),
        (e: unknown) => (e as HostingError).name === 'TooManyEdgeRoutesError',
      );
      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'CdnEdgeRaised', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
            routeEdgeFunctions: edgeRoutes,
            quotas: { edgeFunctions: 30 },
          }),
      );
    });

    void it('wires an OpenNext edge route to a dedicated behavior + Lambda@Edge (origin-request)', () => {
      // Regression: under the KVS single-behavior model the edge-split bundles
      // (edge1/edge2) were built but never attached, so /edge + /api/edge fell
      // through to the default server Lambda (which lacks them) → 500. Each
      // edge route must get its own cache behavior with the EdgeFunction on
      // origin-request, AND be excluded from the KVS route table.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);
      const edgeFn = new LambdaFunction(stack, 'EdgeRouteFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: { type: 'handler', bundle: '/tmp/bundle', handler: 'index.handler', placement: 'regional' },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/edge', target: 'edge1' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'edge-wire-1',
      };

      new CdnConstruct(stack, 'CdnEdge', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
        routeEdgeFunctions: new Map([['edge1', edgeFn.currentVersion]]),
      });
      const template = Template.fromStack(stack);

      // A dedicated /api/edge cache behavior exists with a Lambda@Edge
      // origin-request association.
      const dist = Object.values(
        template.findResources('AWS::CloudFront::Distribution'),
      )[0] as { Properties: { DistributionConfig: { CacheBehaviors?: Array<Record<string, unknown>> } } };
      const behaviors = dist.Properties.DistributionConfig.CacheBehaviors ?? [];
      const edgeBehavior = behaviors.find((b) => b.PathPattern === '/api/edge');
      assert.ok(edgeBehavior, '/api/edge must have a dedicated cache behavior');
      const assocs =
        (edgeBehavior!.LambdaFunctionAssociations as Array<{ EventType?: string }> | undefined) ?? [];
      assert.ok(
        assocs.some((a) => a.EventType === 'origin-request'),
        'edge behavior must attach the Lambda@Edge on origin-request',
      );

      // And /api/edge must be EXCLUDED from the KVS route table.
      const rows = routeRows(
        buildKvsEntries({
          manifest,
          buildId: 'edge-wire-1',
          hasServer: true,
          hasImage: false,
          edgeTargets: new Set(['edge1']),
        }),
      );
      assert.ok(
        !rows.some(([p]) => p === '/api/edge'),
        '/api/edge must not be in the KVS table (handled by its own behavior)',
      );
    });

    void it('attaches includeBody on the edge origin-request association (POST/PUT body)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);
      const edgeFn = new LambdaFunction(stack, 'EdgeBodyFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const manifest: DeployManifest = {
        version: 1,
        compute: { default: { type: 'handler', bundle: '/tmp/bundle', handler: 'index.handler', placement: 'regional' } },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/edge', target: 'edge1' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'edge-body-1',
      };
      new CdnConstruct(stack, 'CdnEdgeBody', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
        routeEdgeFunctions: new Map([['edge1', edgeFn.currentVersion]]),
      });
      const template = Template.fromStack(stack);
      const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as {
        Properties: { DistributionConfig: { CacheBehaviors?: Array<Record<string, unknown>> } };
      };
      const b = (dist.Properties.DistributionConfig.CacheBehaviors ?? []).find(
        (x) => x.PathPattern === '/api/edge',
      );
      const assoc = (b!.LambdaFunctionAssociations as Array<{ EventType?: string; IncludeBody?: boolean }>)[0];
      assert.equal(assoc.EventType, 'origin-request');
      assert.equal(assoc.IncludeBody, true, 'edge handler must receive the request body');
    });

    void it('orders edge behaviors by specificity (literal before wildcard) — C2 first-match-wins', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);
      const mk = (id: string) =>
        new LambdaFunction(stack, id, {
          runtime: Runtime.NODEJS_20_X,
          handler: 'index.handler',
          code: Code.fromInline('exports.handler = async () => {};'),
        }).currentVersion;
      // Manifest deliberately lists the WILDCARD before the literal.
      const manifest: DeployManifest = {
        version: 1,
        compute: { default: { type: 'handler', bundle: '/tmp/bundle', handler: 'index.handler', placement: 'regional' } },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/edge/*', target: 'edgeWild' },
          { pattern: '/api/edge/special', target: 'edgeLit' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'edge-order-1',
      };
      new CdnConstruct(stack, 'CdnEdgeOrder', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
        routeEdgeFunctions: new Map([
          ['edgeWild', mk('EdgeWildFn')],
          ['edgeLit', mk('EdgeLitFn')],
        ]),
      });
      const template = Template.fromStack(stack);
      const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as {
        Properties: { DistributionConfig: { CacheBehaviors?: Array<Record<string, unknown>> } };
      };
      const patterns = (dist.Properties.DistributionConfig.CacheBehaviors ?? []).map(
        (b) => b.PathPattern as string,
      );
      const litIdx = patterns.indexOf('/api/edge/special');
      const wildIdx = patterns.indexOf('/api/edge/*');
      assert.ok(litIdx >= 0 && wildIdx >= 0, 'both edge behaviors present');
      assert.ok(
        litIdx < wildIdx,
        `literal /api/edge/special (idx ${litIdx}) must precede wildcard /api/edge/* (idx ${wildIdx})`,
      );
    });

    void it('throws TooManyCacheBehaviorsError when edge routes exceed the behavior cap (C3)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);
      // 25 edge routes (each → 1 behavior) + 1 server sentinel + 1 default = 27
      // behaviors > the 25 cap, but only 25 edge FUNCTIONS (the function cap is
      // not exceeded). The behavior cap must catch this with a friendly error.
      const edgeRoutes = new Map<string, IVersion>();
      const routes: DeployManifest['routes'] = [{ pattern: '/*', target: 'default' }];
      for (let i = 0; i < 25; i++) {
        const v = new LambdaFunction(stack, `BehFn${i}`, {
          runtime: Runtime.NODEJS_20_X,
          handler: 'index.handler',
          code: Code.fromInline('exports.handler = async () => {};'),
        }).currentVersion;
        edgeRoutes.set(`edge${i}`, v);
        routes.push({ pattern: `/edge-${i}`, target: `edge${i}` });
      }
      const manifest: DeployManifest = {
        version: 1,
        compute: { default: { type: 'handler', bundle: '/tmp/bundle', handler: 'index.handler', placement: 'regional' } },
        staticAssets: { directory: '/tmp/assets' },
        routes,
        buildId: 'edge-behavior-cap-1',
      };
      assert.throws(
        () =>
          new CdnConstruct(stack, 'CdnBehCap', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
            computeFunctionUrls: new Map([['default', fnUrl]]),
            computeFunctions: new Map([['default', fn]]),
            routeEdgeFunctions: edgeRoutes,
          }),
        (e: unknown) => (e as HostingError).name === 'TooManyCacheBehaviorsError',
      );
    });

    void it('throws EdgeCatchAllUnsupportedError when an edge route is the catch-all (C5)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);
      const edgeFn = new LambdaFunction(stack, 'EdgeAllFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const manifest: DeployManifest = {
        version: 1,
        compute: { default: { type: 'handler', bundle: '/tmp/bundle', handler: 'index.handler', placement: 'regional' } },
        staticAssets: { directory: '/tmp/assets' },
        // An edge route mapped to the catch-all (in addition to the real default).
        routes: [
          { pattern: '/*', target: 'edgeAll' },
        ],
        buildId: 'edge-catchall-1',
      };
      assert.throws(
        () =>
          new CdnConstruct(stack, 'CdnEdgeAll', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
            computeFunctionUrls: new Map([['default', fnUrl]]),
            computeFunctions: new Map([['default', fn]]),
            routeEdgeFunctions: new Map([['edgeAll', edgeFn.currentVersion]]),
          }),
        (e: unknown) => (e as HostingError).name === 'EdgeCatchAllUnsupportedError',
      );
    });

    void it('throws EmptyGeoRestrictionError for empty countries', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      assert.throws(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest: spaManifest,
            securityHeadersPolicy: policy,
            geoRestriction: { type: 'whitelist', countries: [] },
          }),
        (error: unknown) => {
          assert.ok(error instanceof HostingError);
          assert.strictEqual(error.name, 'EmptyGeoRestrictionError');
          return true;
        },
      );
    });

    void it('throws TooManyEdgeRoutesError for >25 edge-runtime routes', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const edgeRoutes: Map<string, IVersion> = new Map();
      for (let i = 0; i < 26; i++) {
        const fn = new LambdaFunction(stack, `EdgeFn${i}`, {
          runtime: Runtime.NODEJS_20_X,
          handler: 'index.handler',
          code: Code.fromInline('exports.handler = async () => {};'),
        });
        edgeRoutes.set(`edge${i}`, fn.currentVersion);
      }

      assert.throws(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest: spaManifest,
            securityHeadersPolicy: policy,
            routeEdgeFunctions: edgeRoutes,
          }),
        (error: unknown) => {
          assert.ok(error instanceof HostingError);
          assert.strictEqual(error.name, 'TooManyEdgeRoutesError');
          return true;
        },
      );
    });

    void it('does not throw at exactly 25 edge-runtime routes', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const edgeRoutes: Map<string, IVersion> = new Map();
      for (let i = 0; i < 25; i++) {
        const fn = new LambdaFunction(stack, `EdgeFn${i}`, {
          runtime: Runtime.NODEJS_20_X,
          handler: 'index.handler',
          code: Code.fromInline('exports.handler = async () => {};'),
        });
        edgeRoutes.set(`edge${i}`, fn.currentVersion);
      }

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest: spaManifest,
            securityHeadersPolicy: policy,
            routeEdgeFunctions: edgeRoutes,
          }),
      );
    });

    void it('default behavior uses the synthesized SsrCachePolicy under compute (honors origin Cache-Control)', () => {
      // Edge routes no longer get a dedicated cache behavior — they route
      // through the single default behavior + KVS. The meaningful invariant
      // preserved here: when compute is present, the default behavior
      // references the synthesized SsrCachePolicy (a Ref), not the AWS-managed
      // CACHING_DISABLED string ID.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const defaultFn = new LambdaFunction(stack, 'DefaultFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const defaultUrl = defaultFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });
      const edgeFn = new LambdaFunction(stack, 'EdgeRouteFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });

      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/default-bundle',
            handler: 'index.handler',
            placement: 'regional',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/edge/*', target: 'edge-api' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'test-edge-cache',
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', defaultUrl]]),
        computeFunctions: new Map([['default', defaultFn]]),
        routeEdgeFunctions: new Map([['edge-api', edgeFn.currentVersion]]),
      });

      const template = Template.fromStack(stack);
      // eslint-disable-next-line @typescript-eslint/naming-convention
      const json = template.toJSON() as Record<string, unknown>;
      const resources = json['Resources'] as Record<
        string,
        Record<string, unknown>
      >;
      const distResource = Object.values(resources).find(
        (r) => r['Type'] === 'AWS::CloudFront::Distribution',
      );
      assert.ok(distResource, 'distribution resource present');
      const distProps = distResource['Properties'] as Record<string, unknown>;
      const distConfig = distProps['DistributionConfig'] as Record<
        string,
        unknown
      >;
      const defaultBehavior = distConfig['DefaultCacheBehavior'] as Record<
        string,
        unknown
      >;
      const cachePolicyId = defaultBehavior['CachePolicyId'];
      assert.equal(
        typeof cachePolicyId === 'object' &&
          cachePolicyId !== null &&
          'Ref' in (cachePolicyId as Record<string, unknown>),
        true,
        'default behavior must reference the synthesized SsrCachePolicy via Ref under compute',
      );
    });

    void it('orders multi-wildcard patterns above /_next/* by literal-segment count in the KVS route table', () => {
      // Route ordering is now done by buildKvsEntries (the router scans the
      // table first-match-wins). A pattern like /api/*/data/* (2 literal
      // segments) must rank ABOVE /_next/* (1 literal segment) so it is
      // matched first — preserving the old behavior-ordering semantics.
      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/b1',
            handler: 'index.handler',
            placement: 'regional',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/*', target: 'default' },
          { pattern: '/api/*/data/*', target: 'default' },
          { pattern: '/_next/*', target: 'default' },
        ],
        buildId: 'test-specificity',
      };

      const rows = routeRows(
        buildKvsEntries({
          manifest,
          buildId: 'test-specificity',
          hasServer: true,
          hasImage: false,
        }),
      );
      const patternOrder = rows.map(([p]) => p);
      const idxMultiWildcard = patternOrder.indexOf('/api/*/data/*');
      const idxSingleWildcard = patternOrder.indexOf('/_next/*');
      // /* (catch-all) is implicit and not stored as a row.
      assert.ok(idxMultiWildcard >= 0, '/api/*/data/* row present');
      assert.ok(idxSingleWildcard >= 0, '/_next/* row present');
      assert.ok(
        idxMultiWildcard < idxSingleWildcard,
        '/api/*/data/* (2 literal segments) must rank above /_next/* (1 literal segment)',
      );
    });
  });

  // ---- Optional features ----

  void describe('optional features', () => {
    void it('applies WAF WebACL', () => {
      const stack = createEnvStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const webAcl = new CfnWebACL(stack, 'WebAcl', {
        scope: 'CLOUDFRONT',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'test',
          sampledRequestsEnabled: true,
        },
      });

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        webAcl,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          WebACLId: Match.anyValue(),
        }),
      });
    });

    void it('sets custom domain name and certificate', () => {
      const stack = createEnvStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const cert = Certificate.fromCertificateArn(
        stack,
        'Cert',
        'arn:aws:acm:us-east-1:123456789012:certificate/test-id',
      );

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        certificate: cert,
        domainName: 'example.com',
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Aliases: ['example.com'],
        }),
      });
    });

    void it('uses custom price class', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        priceClass: PriceClass.PRICE_CLASS_ALL,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          PriceClass: 'PriceClass_All',
        }),
      });
    });

    void it('applies geo restriction', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        geoRestriction: { type: 'whitelist', countries: ['US', 'CA'] },
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Restrictions: Match.objectLike({
            GeoRestriction: Match.objectLike({
              RestrictionType: 'whitelist',
              Locations: ['US', 'CA'],
            }),
          }),
        }),
      });
    });
  });

  // ---- OAC ----

  void describe('OAC permissions', () => {
    void it('adds S3 bucket policy for CloudFront access', () => {
      const stack = createEnvStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 's3:GetObject',
              Principal: { Service: 'cloudfront.amazonaws.com' },
            }),
          ]),
        }),
      });
    });
  });

  // ---- Multi-origin routing ----

  void describe('multi-origin routing', () => {
    void it('routes /api/* to api origin and /* to default origin', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      // Create two separate Lambda functions for default and api compute
      const defaultFn = new LambdaFunction(stack, 'DefaultFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const defaultFnUrl = defaultFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const apiFn = new LambdaFunction(stack, 'ApiFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const apiFnUrl = apiFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const multiOriginManifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/bundle-default',
            handler: 'index.handler',
            placement: 'regional',
          },
          api: {
            type: 'handler',
            bundle: '/tmp/bundle-api',
            handler: 'index.handler',
            placement: 'regional',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/*', target: 'api' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'test-multi-origin-1',
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: multiOriginManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([
          ['default', defaultFnUrl],
          ['api', apiFnUrl],
        ]),
        computeFunctions: new Map([
          ['default', defaultFn],
          ['api', apiFn],
        ]),
      });

      const template = Template.fromStack(stack);

      // /api/* is NOT a dedicated cache behavior anymore — it's a KVS route
      // row routed to the compute origin via the single default behavior.
      const rows = routeRows(
        buildKvsEntries({
          manifest: multiOriginManifest,
          buildId: 'test-multi-origin-1',
          hasServer: true,
          hasImage: false,
        }),
      );
      const apiRow = rows.find(([p]) => p === '/api/*');
      assert.ok(apiRow, '/api/* must be in the KVS route table');
      assert.equal(apiRow[1], 'c', '/api/* must route to the compute origin');

      // The distribution carries the S3 + server origins by stable id.
      const ids = originIds(template);
      assert.ok(ids.includes(ORIGIN_ID.s3));
      assert.ok(ids.includes(ORIGIN_ID.server));

      // The single default behavior uses ALL allowed methods (compute) so the
      // router can forward any request to the server origin.
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            AllowedMethods: Match.arrayWith([
              'GET',
              'HEAD',
              'OPTIONS',
              'PUT',
              'PATCH',
              'POST',
              'DELETE',
            ]),
          }),
        }),
      });
    });
  });

  // ---- TLS Protocol ----

  void describe('TLS protocol version', () => {
    void it('sets minimum TLS protocol version to TLSv1.2_2021', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const cert = Certificate.fromCertificateArn(
        stack,
        'TlsCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/tls-test-id',
      );

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        certificate: cert,
        domainName: ['tls-test.example.com'],
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          ViewerCertificate: Match.objectLike({
            MinimumProtocolVersion: 'TLSv1.2_2021',
          }),
        }),
      });
    });
  });

  // ---- HTTP version ----

  void describe('HTTP version', () => {
    void it('enables HTTP/2 and HTTP/3', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          HttpVersion: 'http2and3',
        }),
      });
    });
  });

  // ---- Default price class ----

  void describe('default price class', () => {
    void it('defaults to PRICE_CLASS_100', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          PriceClass: 'PriceClass_100',
        }),
      });
    });
  });

  // ---- Access logging ----

  void describe('access logging', () => {
    void it('enables logging when accessLogBucket is provided', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const logBucket = new Bucket(stack, 'LogBucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        accessLogBucket: logBucket,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Logging: Match.objectLike({
            Bucket: Match.anyValue(),
          }),
        }),
      });
    });

    void it('does not enable logging when accessLogBucket is omitted', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      // Distribution should NOT have logging
      const distributions = template.findResources(
        'AWS::CloudFront::Distribution',
      );
      const dist = Object.values(distributions)[0] as Record<
        string,
        Record<string, unknown>
      >;
      const config = dist.Properties.DistributionConfig as Record<
        string,
        unknown
      >;
      assert.strictEqual(
        config.Logging,
        undefined,
        'Should not have logging when no log bucket',
      );
    });
  });

  // ---- Geo restriction: blacklist ----

  void describe('geo restriction blacklist', () => {
    void it('applies denylist geo restriction', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        geoRestriction: { type: 'blacklist', countries: ['RU', 'CN'] },
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Restrictions: Match.objectLike({
            GeoRestriction: Match.objectLike({
              RestrictionType: 'blacklist',
              Locations: ['RU', 'CN'],
            }),
          }),
        }),
      });
    });
  });

  // ---- InvalidRoutePatternError ----

  void describe('route patterns (KVS table)', () => {
    void it('stores route patterns verbatim in the KVS table without per-behavior validation', () => {
      // The per-behavior CloudFront pattern validation (which rejected regex
      // syntax because a CloudFront PathPattern can't contain it) no longer
      // applies: patterns are KVS data scanned by the router function, not
      // CloudFront behavior patterns. Synth must NOT throw; the pattern is
      // simply stored (and harmlessly never matches the router's glob form).
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const manifest: DeployManifest = {
        version: 1,
        compute: {},
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/(.*)', target: 'static' },
          { pattern: '/*', target: 'static' },
        ],
        buildId: 'test-regex',
      };

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
          }),
      );
      const rows = routeRows(
        buildKvsEntries({
          manifest,
          buildId: 'test-regex',
          hasServer: false,
          hasImage: false,
        }),
      );
      assert.ok(rows.some(([p]) => p === '/api/(.*)'));
    });
  });

  // ---- NoComputeOriginsError ----

  void describe('NoComputeOriginsError', () => {
    void it('throws when computeFunctionUrls is empty and routes target compute', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/bundle',
            handler: 'index.handler',
            placement: 'regional',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [{ pattern: '/*', target: 'default' }],
        buildId: 'test-no-origins',
      };

      assert.throws(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
            computeFunctionUrls: new Map(),
          }),
        (error: unknown) => {
          assert.ok(error instanceof HostingError);
          assert.strictEqual(error.name, 'NoComputeOriginsError');
          return true;
        },
      );
    });

    void it('creates compute origin when computeFunctionUrls has entries', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/bundle',
            handler: 'index.handler',
            placement: 'regional',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [{ pattern: '/*', target: 'default' }],
        buildId: 'test-with-origins',
      };

      const cdn = new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
      });

      assert.ok(cdn.distribution, 'Should create distribution');
      const template = Template.fromStack(stack);
      // Default behavior should allow all methods (compute)
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            AllowedMethods: Match.arrayWith(['POST', 'DELETE']),
          }),
        }),
      });
    });
  });

  // ---- BuildId CloudFront Function ----

  void describe('BuildId rewrite (KVS-backed)', () => {
    void it('writes the build ID into the KVS route table, not the function code', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const manifest: DeployManifest = {
        ...spaManifest,
        buildId: 'custom-build-123',
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      // The router functions are build-independent — the buildId is carried by
      // the RouteStoreKeys custom resource that writes the KVS.
      template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
        Entries: Match.stringLikeRegexp('custom-build-123'),
      });
      // And it appears in the meta blob from the pure builder.
      const meta = JSON.parse(
        buildKvsEntries({
          manifest,
          buildId: 'custom-build-123',
          hasServer: false,
          hasImage: false,
        }).meta,
      ) as { b: string };
      assert.equal(meta.b, 'custom-build-123');
    });
  });

  // ---- Distribution URL output ----

  void describe('distribution URL', () => {
    void it('uses custom domain in distributionUrl when domainName is set', () => {
      const stack = createEnvStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const cert = Certificate.fromCertificateArn(
        stack,
        'Cert',
        'arn:aws:acm:us-east-1:123456789012:certificate/test-id',
      );

      const cdn = new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        certificate: cert,
        domainName: 'my-site.example.com',
      });

      assert.strictEqual(cdn.distributionUrl, 'https://my-site.example.com');
    });

    void it('uses CloudFront domain when no custom domainName', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const cdn = new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      assert.ok(
        cdn.distributionUrl.startsWith('https://'),
        'URL should start with https://',
      );
      const isTokenizedUrl = cdn.distributionUrl.includes('${Token');
      const isCloudFrontHost = !isTokenizedUrl
        ? (() => {
            try {
              const hostname = new URL(cdn.distributionUrl).hostname;
              return (
                hostname === 'cloudfront.net' ||
                hostname.endsWith('.cloudfront.net')
              );
            } catch {
              return false;
            }
          })()
        : false;
      assert.ok(
        isCloudFrontHost || isTokenizedUrl,
        'URL should use CloudFront domain or token',
      );
    });
  });

  // ---- Viewer protocol policy ----

  void describe('viewer protocol policy', () => {
    void it('redirects HTTP to HTTPS for static behaviors', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        }),
      });
    });
  });

  // ---- CSP ResponseHeadersPolicy on behaviors ----

  void describe('CSP applied on all behaviors via ResponseHeadersPolicy', () => {
    void it('default behavior references a ResponseHeadersPolicyId', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            ResponseHeadersPolicyId: Match.anyValue(),
          }),
        }),
      });
    });

    void it('all additional behaviors reference a ResponseHeadersPolicyId', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources(
        'AWS::CloudFront::Distribution',
      );
      const distConfig = (
        Object.values(distributions)[0] as Record<
          string,
          Record<string, unknown>
        >
      ).Properties.DistributionConfig as Record<string, unknown>;
      const cacheBehaviors = distConfig.CacheBehaviors as Array<
        Record<string, unknown>
      >;

      assert.ok(
        cacheBehaviors && cacheBehaviors.length > 0,
        'Should have additional cache behaviors',
      );
      for (const behavior of cacheBehaviors) {
        assert.ok(
          behavior.ResponseHeadersPolicyId !== undefined,
          `Behavior for ${String(behavior.PathPattern)} should have ResponseHeadersPolicyId`,
        );
      }
    });
  });

  // ---- Multi-compute TargetOriginId binding ----

  void describe('multi-compute KVS routing', () => {
    void it('routes /api/* to compute and /* (catch-all) to compute in the KVS table', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const defaultFn = new LambdaFunction(stack, 'DefaultFn2', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const defaultFnUrl = defaultFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const apiFn = new LambdaFunction(stack, 'ApiFn2', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const apiFnUrl = apiFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const multiOriginManifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/bundle-default',
            handler: 'index.handler',
            placement: 'regional',
          },
          api: {
            type: 'handler',
            bundle: '/tmp/bundle-api',
            handler: 'index.handler',
            placement: 'regional',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/*', target: 'api' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'test-origin-binding-1',
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: multiOriginManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([
          ['default', defaultFnUrl],
          ['api', apiFnUrl],
        ]),
        computeFunctions: new Map([
          ['default', defaultFn],
          ['api', apiFn],
        ]),
      });

      // Per-route TargetOriginId no longer exists: the single default behavior
      // forwards to the server origin and the KVS router decides per request.
      // Assert the route table maps /api/* to compute ('c').
      const rows = routeRows(
        buildKvsEntries({
          manifest: multiOriginManifest,
          buildId: 'test-origin-binding-1',
          hasServer: true,
          hasImage: false,
        }),
      );
      const apiRow = rows.find(([p]) => p === '/api/*');
      assert.ok(apiRow, '/api/* must be in the KVS route table');
      assert.equal(apiRow[1], 'c', '/api/* must route to compute');

      // The server origin is bound to the distribution by stable id.
      const template = Template.fromStack(stack);
      assert.ok(originIds(template).includes(ORIGIN_ID.server));
    });

    void it('each behavior TargetOriginId matches an origin in the Origins array', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const defaultFn = new LambdaFunction(stack, 'DefFn3', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const defaultFnUrl = defaultFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const apiFn = new LambdaFunction(stack, 'ApiFn3', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const apiFnUrl = apiFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/b1',
            handler: 'index.handler',
            placement: 'regional',
          },
          api: {
            type: 'handler',
            bundle: '/tmp/b2',
            handler: 'index.handler',
            placement: 'regional',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/*', target: 'api' },
          { pattern: '/_next/static/*', target: 'static' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'test-origin-binding-2',
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([
          ['default', defaultFnUrl],
          ['api', apiFnUrl],
        ]),
        computeFunctions: new Map([
          ['default', defaultFn],
          ['api', apiFn],
        ]),
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources(
        'AWS::CloudFront::Distribution',
      );
      const distConfig = (
        Object.values(distributions)[0] as Record<
          string,
          Record<string, unknown>
        >
      ).Properties.DistributionConfig as Record<string, unknown>;

      const origins = distConfig.Origins as Array<Record<string, unknown>>;
      const originIds = new Set(origins.map((o) => o.Id));

      const defaultBehavior = distConfig.DefaultCacheBehavior as Record<
        string,
        unknown
      >;
      const cacheBehaviors = distConfig.CacheBehaviors as Array<
        Record<string, unknown>
      >;

      // Default behavior TargetOriginId must exist in origins
      assert.ok(
        originIds.has(defaultBehavior.TargetOriginId as string),
        `Default behavior TargetOriginId '${String(defaultBehavior.TargetOriginId)}' must match an origin`,
      );

      // All additional behaviors must reference valid origins
      for (const behavior of cacheBehaviors) {
        assert.ok(
          originIds.has(behavior.TargetOriginId as string),
          `Behavior ${String(behavior.PathPattern)} TargetOriginId '${String(behavior.TargetOriginId)}' must match an origin`,
        );
      }
    });
  });

  // ---- OAC Lambda Permission specifics ----

  void describe('OAC Lambda permissions per-function', () => {
    void it('each compute function gets a Permission with lambda:InvokeFunctionUrl', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const defaultFn = new LambdaFunction(stack, 'OacDefaultFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const defaultFnUrl = defaultFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const apiFn = new LambdaFunction(stack, 'OacApiFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const apiFnUrl = apiFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/b1',
            handler: 'index.handler',
            placement: 'regional',
          },
          api: {
            type: 'handler',
            bundle: '/tmp/b2',
            handler: 'index.handler',
            placement: 'regional',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/*', target: 'api' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'test-oac-perms-1',
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([
          ['default', defaultFnUrl],
          ['api', apiFnUrl],
        ]),
        computeFunctions: new Map([
          ['default', defaultFn],
          ['api', apiFn],
        ]),
      });

      const template = Template.fromStack(stack);
      const permissions = template.findResources('AWS::Lambda::Permission');

      // Find all InvokeFunctionUrl permissions from CDN construct
      const invokeUrlPerms = Object.entries(permissions).filter(
        ([, resource]) => {
          const props = (resource as Record<string, Record<string, unknown>>)
            .Properties;
          return (
            props.Action === 'lambda:InvokeFunctionUrl' &&
            props.Principal === 'cloudfront.amazonaws.com'
          );
        },
      );

      // Each compute function that has a URL should get exactly 1 InvokeFunctionUrl permission
      assert.strictEqual(
        invokeUrlPerms.length,
        2,
        'Should have exactly 2 InvokeFunctionUrl permissions (one per compute function)',
      );
    });

    void it('each InvokeFunctionUrl permission has correct FunctionName', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const defaultFn = new LambdaFunction(stack, 'PermDefaultFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const defaultFnUrl = defaultFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const apiFn = new LambdaFunction(stack, 'PermApiFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const apiFnUrl = apiFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/b1',
            handler: 'index.handler',
            placement: 'regional',
          },
          api: {
            type: 'handler',
            bundle: '/tmp/b2',
            handler: 'index.handler',
            placement: 'regional',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [
          { pattern: '/api/*', target: 'api' },
          { pattern: '/*', target: 'default' },
        ],
        buildId: 'test-oac-perms-2',
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([
          ['default', defaultFnUrl],
          ['api', apiFnUrl],
        ]),
        computeFunctions: new Map([
          ['default', defaultFn],
          ['api', apiFn],
        ]),
      });

      const template = Template.fromStack(stack);
      const permissions = template.findResources('AWS::Lambda::Permission');
      const lambdas = template.findResources('AWS::Lambda::Function');

      // Collect Lambda function ARN refs
      const lambdaLogicalIds = Object.keys(lambdas);

      const invokeUrlPerms = Object.entries(permissions).filter(
        ([, resource]) => {
          const props = (resource as Record<string, Record<string, unknown>>)
            .Properties;
          return (
            props.Action === 'lambda:InvokeFunctionUrl' &&
            props.Principal === 'cloudfront.amazonaws.com'
          );
        },
      );

      // Each permission's FunctionName must reference a Lambda function (via GetAtt or Ref)
      for (const [permId, resource] of invokeUrlPerms) {
        const props = (resource as Record<string, Record<string, unknown>>)
          .Properties;
        const fnName = props.FunctionName as Record<string, unknown>;

        // eslint-disable-next-line spellcheck/spell-checker
        // CDK uses { 'Fn::GetAtt': [logicalId, 'Arn'] } or { Ref: logicalId }
        const refId = fnName['Fn::GetAtt']
          ? (fnName['Fn::GetAtt'] as string[])[0]
          : (fnName['Ref'] as string | undefined);

        assert.ok(
          refId && lambdaLogicalIds.includes(refId),
          `Permission ${permId} FunctionName must reference a Lambda function`,
        );
      }
    });

    void it('edge functions do NOT get InvokeFunctionUrl permissions', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      // Only one compute function with a URL
      const defaultFn = new LambdaFunction(stack, 'EdgeTestFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });
      const defaultFnUrl = defaultFn.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode: InvokeMode.RESPONSE_STREAM,
      });

      // Simulate edge function: it has no function URL (not in computeFunctionUrls)
      const edgeFn = new LambdaFunction(stack, 'EdgeFn', {
        runtime: Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => {};'),
      });

      const manifest: DeployManifest = {
        version: 1,
        compute: {
          default: {
            type: 'handler',
            bundle: '/tmp/b1',
            handler: 'index.handler',
            placement: 'regional',
          },
          middleware: {
            type: 'edge',
            bundle: '/tmp/b-edge',
            handler: 'index.handler',
            placement: 'global',
          },
        },
        staticAssets: { directory: '/tmp/assets' },
        routes: [{ pattern: '/*', target: 'default' }],
        buildId: 'test-edge-no-perm',
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        // Only the regional function has a URL; edge does not
        computeFunctionUrls: new Map([['default', defaultFnUrl]]),
        computeFunctions: new Map([
          ['default', defaultFn],
          ['middleware', edgeFn],
        ]),
      });

      const template = Template.fromStack(stack);
      const permissions = template.findResources('AWS::Lambda::Permission');

      const invokeUrlPerms = Object.entries(permissions).filter(
        ([, resource]) => {
          const props = (resource as Record<string, Record<string, unknown>>)
            .Properties;
          return (
            props.Action === 'lambda:InvokeFunctionUrl' &&
            props.Principal === 'cloudfront.amazonaws.com'
          );
        },
      );

      // Only 1 permission for the 'default' function — edge function must NOT get one
      assert.strictEqual(
        invokeUrlPerms.length,
        1,
        'Edge functions should NOT get InvokeFunctionUrl permissions',
      );

      // Verify the single permission references the correct function (defaultFn, not edgeFn)
      const lambdas = template.findResources('AWS::Lambda::Function');
      const edgeFnLogicalId = Object.keys(lambdas).find((key) =>
        key.includes('EdgeFn'),
      );

      for (const [, resource] of invokeUrlPerms) {
        const props = (resource as Record<string, Record<string, unknown>>)
          .Properties;
        const fnName = props.FunctionName as Record<string, unknown>;
        const refId = fnName['Fn::GetAtt']
          ? (fnName['Fn::GetAtt'] as string[])[0]
          : (fnName['Ref'] as string | undefined);

        assert.notStrictEqual(
          refId,
          edgeFnLogicalId,
          'InvokeFunctionUrl permission must NOT reference the edge function',
        );
      }
    });
  });

  // ---- Error page ResponsePagePath with buildId prefix ----

  void describe('error page ResponsePagePath with buildId prefix', () => {
    void it('SPA error responses use buildId prefix in ResponsePagePath', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      // SPA fallback is now in the viewer-request function — no error
      // responses are created for SPA mode without custom error pages.
      const dist = template.findResources('AWS::CloudFront::Distribution');
      const distProps = Object.values(dist)[0].Properties.DistributionConfig;
      assert.equal(
        distProps.CustomErrorResponses,
        undefined,
        'SPA without errorPages should not have custom error responses',
      );
    });

    void it('SSR error responses use buildId prefix in ResponsePagePath for 5xx errors', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CustomErrorResponses: Match.arrayWith([
            Match.objectLike({
              ErrorCode: 502,
              ResponsePagePath: `/builds/${ssrManifest.buildId}/_error.html`,
            }),
            Match.objectLike({
              ErrorCode: 503,
              ResponsePagePath: `/builds/${ssrManifest.buildId}/_error.html`,
            }),
            Match.objectLike({
              ErrorCode: 504,
              ResponsePagePath: `/builds/${ssrManifest.buildId}/_error.html`,
            }),
          ]),
        }),
      });
    });

    void it('error page path pattern includes buildId for atomic deploys', () => {
      const customBuildId = 'my-custom-build-42';
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      const manifestWithCustomBuildId: DeployManifest = {
        ...ssrManifest,
        buildId: customBuildId,
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: manifestWithCustomBuildId,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CustomErrorResponses: Match.arrayWith([
            Match.objectLike({
              ErrorCode: 502,
              ResponsePagePath: `/builds/${customBuildId}/_error.html`,
            }),
          ]),
        }),
      });
    });
  });
});

// ================================================================
// P0.3 — dropped header at the behavior cap: fail loud for security
// headers, warn-only for cosmetic ones.
// ================================================================

void describe('CdnConstruct — header drop at behavior cap (P0.3)', () => {
  const baseStatic = (
    headers: { source: string; headers: Record<string, string> }[],
  ): DeployManifest => ({
    version: 1,
    compute: {},
    staticAssets: { directory: '/tmp/assets' },
    routes: [{ pattern: '/*', target: 'static' }],
    headers,
    buildId: 'test-hdrcap-1',
  });

  // 24 distinct header patterns fill the additional-behavior cap; the 25th
  // overflows. (MAX_ADDITIONAL_BEHAVIORS = 24.)
  const fill = (last: Record<string, string>) => {
    const rules: { source: string; headers: Record<string, string> }[] = [];
    for (let i = 0; i < 24; i++) {
      rules.push({ source: `/h${i}`, headers: { 'x-h': String(i) } });
    }
    rules.push({ source: '/overflow', headers: last });
    return rules;
  };

  void it('does NOT drop a security header over the old behavior cap (all headers live in KVS)', () => {
    // The legacy model expressed per-pattern headers as per-behavior
    // ResponseHeadersPolicies, capped at 24 behaviors — so an over-cap rule
    // carrying a security header (CSP) was dropped and the build failed loud
    // (SecurityHeaderDroppedError). Headers are now KVS rows applied by the
    // viewer-response router function: there is no behavior cap to overflow,
    // so 25 header rules (including a CSP one) synth cleanly.
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    const manifest = baseStatic(
      fill({ 'content-security-policy': "default-src 'self'" }),
    );
    assert.doesNotThrow(
      () =>
        new CdnConstruct(stack, 'Cdn', {
          bucket,
          manifest,
          securityHeadersPolicy: policy,
        }),
    );
    // The CSP header rule survives — it's a header row in the KVS (h0..hN).
    const entries = buildKvsEntries({
      manifest,
      buildId: 'test-hdrcap-1',
      hasServer: false,
      hasImage: false,
    });
    const headerJson = Object.entries(entries)
      .filter(([k]) => /^h\d+$/.test(k))
      .map(([, v]) => v)
      .join('');
    assert.match(headerJson, /content-security-policy/);
  });

  void it('does NOT throw when an over-cap rule drops only a cosmetic header', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    // Should synth fine (the cosmetic header is dropped with a warning).
    // The 24 distinct filler policies would themselves exceed the default
    // account RHP quota (20); raise headerPolicies so this test isolates the
    // BEHAVIOR cap it actually exercises (the RHP quota has its own test).
    assert.doesNotThrow(
      () =>
        new CdnConstruct(stack, 'Cdn', {
          bucket,
          manifest: baseStatic(fill({ 'x-custom-cosmetic': 'value' })),
          securityHeadersPolicy: policy,
          quotas: { headerPolicies: 100 },
        }),
    );
  });

  void it('does NOT throw for a security header that fits under the cap', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    assert.doesNotThrow(
      () =>
        new CdnConstruct(stack, 'Cdn', {
          bucket,
          manifest: baseStatic([
            { source: '/secure', headers: { 'content-security-policy': "default-src 'self'" } },
          ]),
          securityHeadersPolicy: policy,
        }),
    );
  });

  void it('synthesizes many distinct header rules without a ResponseHeadersPolicy quota (headers are KVS data)', () => {
    // The legacy model minted one ResponseHeadersPolicy per distinct header
    // set, hitting the account RHP quota (20) and throwing
    // TooManyHeaderPoliciesError. With the KVS router, per-pattern headers are
    // table rows applied by the response function — no RHP resources, no
    // quota — so 25 distinct header sets synth cleanly.
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    assert.doesNotThrow(
      () =>
        new CdnConstruct(stack, 'Cdn', {
          bucket,
          manifest: baseStatic(fill({ 'x-custom-cosmetic': 'value' })),
          securityHeadersPolicy: policy,
        }),
    );
    // No PER-PATTERN ResponseHeadersPolicy resources are minted: only the one
    // base security-headers policy passed in exists, regardless of how many
    // distinct header rules the manifest declares (they're KVS rows).
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1);
  });

  void it('dedupes identical header sets so they draw the RHP quota once', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    // 24 patterns but all the SAME header value → 1 deduped policy. Must NOT
    // trip the RHP quota (proves dedup feeds the budget, not raw rule count).
    const sameHeaderRules = Array.from({ length: 24 }, (_, i) => ({
      source: `/h${i}`,
      headers: { 'x-shared': 'same-value' },
    }));
    assert.doesNotThrow(
      () =>
        new CdnConstruct(stack, 'Cdn', {
          bucket,
          manifest: baseStatic(sameHeaderRules),
          securityHeadersPolicy: policy,
        }),
    );
  });

  // ----------------------------------------------------------------
  // Runtime delegation: when compute is present, a header-only pattern
  // (one with no behavior of its own) is NOT given a dedicated CloudFront
  // behavior. Its requests fall through to the catch-all SSR Lambda, which
  // already emits the framework's headers() / routeRules at runtime — so a
  // dedicated edge behavior would be redundant and would burn a scarce
  // behavior slot. Two consequences we assert:
  //   1. Even a CSP rule that "overflows" the static cap does NOT fail the
  //      build (the runtime applies it).
  //   2. No extra per-pattern behavior is synthesized for the header rule.
  // ----------------------------------------------------------------

  // Manifest with an SSR compute origin (catch-all → 'default') so
  // `hasCompute` is true, plus N header-only patterns.
  const baseCompute = (
    headers: { source: string; headers: Record<string, string> }[],
  ): DeployManifest => ({
    version: 1,
    compute: {
      default: {
        type: 'handler',
        bundle: '/tmp/bundle',
        handler: 'index.handler',
        placement: 'regional',
      },
    },
    staticAssets: { directory: '/tmp/assets' },
    routes: [{ pattern: '/*', target: 'default' }],
    headers,
    buildId: 'test-hdrcap-compute-1',
  });

  void it('does NOT throw for a SECURITY header over the static cap when compute is present (runtime delegation)', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    const { fn, fnUrl } = createSsrFunction(stack);
    // 24 cosmetic + 1 CSP rule: far past the static-only cap, but every
    // header-only pattern delegates to the SSR runtime, so synth succeeds.
    assert.doesNotThrow(
      () =>
        new CdnConstruct(stack, 'Cdn', {
          bucket,
          manifest: baseCompute(fill({ 'content-security-policy': "default-src 'self'" })),
          securityHeadersPolicy: policy,
          computeFunctionUrls: new Map([['default', fnUrl]]),
          computeFunctions: new Map([['default', fn]]),
        }),
    );
  });

  void it('synthesizes NO per-pattern behavior for header-only rules under compute (delegates to runtime)', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    const { fn, fnUrl } = createSsrFunction(stack);
    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: baseCompute([
        { source: '/secure', headers: { 'content-security-policy': "default-src 'self'" } },
        { source: '/promo', headers: { 'x-custom-cosmetic': 'value' } },
      ]),
      securityHeadersPolicy: policy,
      computeFunctionUrls: new Map([['default', fnUrl]]),
      computeFunctions: new Map([['default', fn]]),
    });
    // The header-only patterns must NOT appear as CloudFront cache
    // behaviors — they're served by the catch-all SSR Lambda.
    const template = Template.fromStack(stack);
    const dist = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    )[0] as {
      Properties: {
        DistributionConfig: { CacheBehaviors?: { PathPattern: string }[] };
      };
    };
    const patterns = (
      dist.Properties.DistributionConfig.CacheBehaviors ?? []
    ).map((b) => b.PathPattern);
    assert.ok(
      !patterns.includes('/secure') && !patterns.includes('/promo'),
      `header-only patterns should not be wired as behaviors; got ${JSON.stringify(patterns)}`,
    );
  });
});

// ================================================================
// Sentinel-behavior guard (G21)
//
// The `/__blocks_origin_*/*` behaviors exist ONLY to bind the server/image
// origins (so CDK materializes them + their OAC). They must NOT be a usable
// route: a direct client hit would reach the SSR Lambda without the router's
// x-forwarded-host injection, or hit the image origin directly — bypassing all
// routing (a foot-gun / SSRF-ish surface). The construct attaches a viewer-
// request SentinelGuard function that 403s those patterns. These assert the
// guard is created AND bound, and that pure-static deploys create no guard.
// ================================================================

void describe('CdnConstruct — sentinel-behavior guard (G21)', () => {
  // Returns the set of PathPatterns whose behavior has a viewer-request
  // function association (i.e. the guard is attached).
  const guardedPatterns = (template: Template): string[] => {
    const dists = template.findResources('AWS::CloudFront::Distribution');
    const out: string[] = [];
    for (const d of Object.values(dists)) {
      const cfg = (d as { Properties: { DistributionConfig: { CacheBehaviors?: Array<Record<string, unknown>> } } })
        .Properties.DistributionConfig;
      for (const b of cfg.CacheBehaviors ?? []) {
        const assocs =
          (b.FunctionAssociations as Array<{ EventType?: string }> | undefined) ?? [];
        if (assocs.some((a) => a.EventType === 'viewer-request')) {
          out.push(b.PathPattern as string);
        }
      }
    }
    return out;
  };

  void it('attaches a viewer-request guard to the server sentinel behavior', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    const { fn, fnUrl } = createSsrFunction(stack);
    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: ssrManifest,
      securityHeadersPolicy: policy,
      computeFunctionUrls: new Map([['default', fnUrl]]),
      computeFunctions: new Map([['default', fn]]),
    });
    const template = Template.fromStack(stack);

    // The sentinel behavior carries a viewer-request association.
    assert.ok(
      guardedPatterns(template).includes('/__blocks_origin_server/*'),
      'server sentinel behavior must have a viewer-request guard',
    );

    // A SentinelGuard CloudFront Function exists and returns 403 in its code.
    const fns = template.findResources('AWS::CloudFront::Function');
    const guard = Object.values(fns).find((f) =>
      String(
        (f as { Properties?: { FunctionCode?: string } }).Properties?.FunctionCode ?? '',
      ).includes('statusCode: 403'),
    );
    assert.ok(guard, 'a SentinelGuard function returning 403 must be synthesized');
  });

  void it('does NOT create a SentinelGuard for a pure-static deploy (no sentinels)', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: spaManifest, // static-only: no server/image origin → no sentinel
      securityHeadersPolicy: policy,
    });
    const template = Template.fromStack(stack);
    const fns = template.findResources('AWS::CloudFront::Function');
    const guard = Object.values(fns).find((f) =>
      String(
        (f as { Properties?: { FunctionCode?: string } }).Properties?.FunctionCode ?? '',
      ).includes('statusCode: 403'),
    );
    assert.ok(!guard, 'no guard function should exist without a sentinel behavior');
  });
});

// ================================================================
// Deploy-time CloudFront invalidation (hasCompute-scoped)
// ================================================================
//
// Any compute-backed deploy can edge-cache HTML that references the previous
// build's hashed assets and 403s after a redeploy — Next SSG/ISR, Nuxt
// routeRules swr/isr, Astro SSR. So the L3 issues `/*` for ANY deploy with a
// compute origin (default), nothing for pure-static, and honors
// `manifest.invalidationPaths` as an override/opt-out. The invalidation is an
// AwsCustomResource that synthesizes as `Custom::AWS`.
void describe('CdnConstruct — deploy-time invalidation', () => {
  void it('creates a Custom::AWS createInvalidation by default for a compute deploy', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    const { fn, fnUrl } = createSsrFunction(stack);

    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: ssrManifest, // compute, no explicit invalidationPaths
      securityHeadersPolicy: policy,
      computeFunctionUrls: new Map([['default', fnUrl]]),
      computeFunctions: new Map([['default', fn]]),
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::AWS', 1);
    // The Create/Update payload is an Fn::Join (the DistributionId is a CFN
    // token); JSON.stringify the whole thing to assert the createInvalidation
    // call, the build-id CallerReference, and the default `/*` path.
    const customAws = Object.values(template.findResources('Custom::AWS'))[0] as {
      Properties: { Create?: unknown; Update?: unknown };
    };
    const blob = JSON.stringify(
      customAws.Properties.Update ?? customAws.Properties.Create ?? '',
    );
    assert.match(blob, /createInvalidation/);
    assert.match(blob, /blocks-test-ssr-1/); // CallerReference keyed on buildId
    assert.match(blob, /\\"Items\\":\[\\"\/\*\\"\]/);
  });

  void it('grants only cloudfront:CreateInvalidation to the invalidation resource', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    const { fn, fnUrl } = createSsrFunction(stack);

    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: ssrManifest,
      securityHeadersPolicy: policy,
      computeFunctionUrls: new Map([['default', fnUrl]]),
      computeFunctions: new Map([['default', fn]]),
    });

    const template = Template.fromStack(stack);
    // The AwsCustomResource provider policy carries exactly the one action.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudfront:CreateInvalidation',
            Effect: 'Allow',
            Resource: '*',
          }),
        ]),
      }),
    });
  });

  void it('honors an explicit invalidationPaths override on a compute deploy', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    const { fn, fnUrl } = createSsrFunction(stack);

    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: { ...ssrManifest, invalidationPaths: ['/blog/*'] },
      securityHeadersPolicy: policy,
      computeFunctionUrls: new Map([['default', fnUrl]]),
      computeFunctions: new Map([['default', fn]]),
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::AWS', 1);
    const customAws = Object.values(template.findResources('Custom::AWS'))[0] as {
      Properties: { Create?: unknown; Update?: unknown };
    };
    const blob = JSON.stringify(
      customAws.Properties.Update ?? customAws.Properties.Create ?? '',
    );
    assert.match(blob, /\\"Items\\":\[\\"\/blog\/\*\\"\]/);
  });

  void it('does NOT create an invalidation for a pure-static deploy (no compute)', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});

    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: spaManifest, // static-only: HTML served from S3 with no-cache
      securityHeadersPolicy: policy,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::AWS', 0);
  });

  void it('lets a compute deploy opt out with invalidationPaths: []', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    const { fn, fnUrl } = createSsrFunction(stack);

    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: { ...ssrManifest, invalidationPaths: [] },
      securityHeadersPolicy: policy,
      computeFunctionUrls: new Map([['default', fnUrl]]),
      computeFunctions: new Map([['default', fn]]),
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::AWS', 0);
  });
});
