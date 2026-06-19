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

    void it('creates BuildId CloudFront Function', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('test-spa-1'),
      });
    });

    void it('emits a single prefixed catch-all when manifest.assetPrefix is set (P2.7)', () => {
      // P2.7: previous implementation emitted FOUR prefixed
      // behaviors (`_next/static/*`, `_next/image*`, `_next/data/*`,
      // `_next/*`) — each consuming a slot of the CloudFront 24-
      // additional-behavior cap. Customers with even modest route
      // counts hit the cap. Now we emit a single `<assetPrefix>/*`
      // behavior backed by the same strip function; CloudFront's
      // longest-prefix-wins matching is irrelevant here because
      // there's only one pattern under the prefix.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const prefixedManifest = {
        ...spaManifest,
        assetPrefix: '/shop-static',
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: prefixedManifest,
        securityHeadersPolicy: policy,
      });

      const template = Template.fromStack(stack);
      // Exactly one /<prefix>/* behavior should exist on the
      // distribution.
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/shop-static/*',
            }),
          ]),
        }),
      });
      // Should have created the strip function with the prefix baked
      // into its source.
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('shop-static'),
      });
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
    // Helper: pull the viewer-request CloudFront Function source.
    const viewerRequestCode = (template: Template): string => {
      const fns = template.findResources('AWS::CloudFront::Function');
      const codes = Object.values(fns)
        .map((f) => (f.Properties as Record<string, unknown>)?.FunctionCode)
        .filter((c): c is string => typeof c === 'string');
      // The build-id rewrite (viewer-request) function contains the
      // '/builds/' prefix rewrite; the response/strip functions don't.
      return codes.find((c) => c.includes("'/builds/'")) ?? codes.join('\n');
    };

    void it('uses directory-index resolution (not SPA fallback) when spaFallback:false', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const multiPageManifest: DeployManifest = {
        ...spaManifest,
        staticAssets: { directory: '/tmp/assets', spaFallback: false },
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: multiPageManifest,
        securityHeadersPolicy: policy,
      });

      const code = viewerRequestCode(Template.fromStack(stack));
      // Directory-index mode appends '/index.html' to extensionless paths
      // (`uri = uri + '/index.html'`) and must NOT blanket-rewrite every
      // path to a single '/index.html' (the SPA form `uri = '/index.html'`).
      assert.ok(
        code.includes("uri = uri + '/index.html'"),
        'multi-page mode should resolve <path>/index.html via directory-index',
      );
      assert.ok(
        code.includes("uri = '/index.html'") === false,
        'multi-page mode must not blanket-rewrite every path to /index.html',
      );
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

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaWithErrorPages,
        securityHeadersPolicy: policy,
      });

      const code = viewerRequestCode(Template.fromStack(stack));
      assert.ok(
        code.includes("uri = '/index.html'"),
        'explicit spaFallback:true must force the SPA blanket rewrite',
      );
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

    void it('creates additional behaviors for static routes', () => {
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

      // CdnConstruct sorts cache behaviors by descending specificity so
      // that literal paths win over wildcards (CloudFront evaluates first-
      // match-wins). `/favicon.ico` (literal, 0 wildcards) ends up before
      // `/_next/static/*` (1 wildcard), so we assert each separately
      // rather than rely on a relative-order arrayWith.
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({ PathPattern: '/_next/static/*' }),
          ]),
        }),
      });
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({ PathPattern: '/favicon.ico' }),
          ]),
        }),
      });
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

    void it('throws TooManyRoutesError for >24 specific routes', () => {
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

      assert.throws(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
          }),
        (error: unknown) => {
          assert.ok(error instanceof HostingError);
          assert.strictEqual(error.name, 'TooManyRoutesError');
          return true;
        },
      );
    });

    void it('counts derived bare behaviors — throws when subtree routes double past the cap', () => {
      // Regression (T13): the old guard counted manifest routes BEFORE the
      // L3 derived a bare `/page` behavior from each `/page/*` route. 13
      // subtree routes (13 ≤ 24, so the old guard passed) expand to 13
      // subtree + 13 bare = 26 actual behaviors > 24 — which used to fail
      // opaquely in CloudFormation. The authoritative count must catch it.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const subtreeRoutes = Array.from({ length: 13 }, (_, i) => ({
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

      assert.throws(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
          }),
        (error: unknown) => {
          assert.ok(error instanceof HostingError);
          assert.strictEqual(error.name, 'TooManyRoutesError');
          return true;
        },
      );
    });

    void it('allows subtree routes whose derived count stays within the cap', () => {
      // 11 subtree routes → 11 + 11 derived bare = 22 behaviors ≤ 24. OK.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const subtreeRoutes = Array.from({ length: 11 }, (_, i) => ({
        pattern: `/page-${i}/*`,
        target: 'static',
      }));
      subtreeRoutes.push({ pattern: '/*', target: 'static' });

      const manifest: DeployManifest = {
        version: 1,
        compute: {},
        staticAssets: { directory: '/tmp/assets' },
        routes: subtreeRoutes,
        buildId: 'test-derive-2',
      };

      assert.doesNotThrow(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
          }),
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

    void it('edge route behaviors use the synthesized SsrCachePolicy (honors origin Cache-Control)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      // Configure a regional default (so hasCompute=true and ssrCachePolicy
      // is created) plus an edge route handled by Lambda@Edge.
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
      const edgeBehavior = (
        distConfig['CacheBehaviors'] as Array<Record<string, unknown>>
      ).find((b) => b['PathPattern'] === '/api/edge/*');
      assert.ok(edgeBehavior, 'edge route cache behavior present');
      const cachePolicyId = edgeBehavior['CachePolicyId'];
      assert.equal(
        typeof cachePolicyId === 'object' &&
          cachePolicyId !== null &&
          'Ref' in (cachePolicyId as Record<string, unknown>),
        true,
        'edge route must reference the synthesized SsrCachePolicy via Ref, not the AWS-managed CACHING_DISABLED string ID',
      );
    });

    void it('orders multi-wildcard patterns above /* by literal-segment count', () => {
      // Regression for the route-specificity formula: a pattern like
      // /api/*/data/* (2 literal segments, 2 wildcards) must rank ABOVE
      // /* (0 literal segments, 1 wildcard). The previous formula
      // (length × 1000 - wildcards × 1_000_000) inverted this and let
      // /* shadow more-specific multi-wildcard patterns.
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

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

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
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
      assert.ok(distResource);
      const distProps = distResource['Properties'] as Record<string, unknown>;
      const distConfig = distProps['DistributionConfig'] as Record<
        string,
        unknown
      >;
      const cacheBehaviors = distConfig['CacheBehaviors'] as Array<
        Record<string, unknown>
      >;
      const patternOrder = cacheBehaviors.map(
        (b) => b['PathPattern'] as string,
      );

      const idxMultiWildcard = patternOrder.indexOf('/api/*/data/*');
      const idxSingleWildcard = patternOrder.indexOf('/_next/*');
      // /* is the catch-all and lives on the default behavior, so it
      // doesn't appear in CacheBehaviors. The two patterns we declared
      // as additional behaviors must be ordered by literal segments:
      // /api/*/data/* (2 literals) before /_next/* (1 literal).
      assert.ok(idxMultiWildcard >= 0, '/api/*/data/* behavior present');
      assert.ok(idxSingleWildcard >= 0, '/_next/* behavior present');
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

      // Verify CloudFront distribution has a /api/* cache behavior
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/api/*',
            }),
          ]),
        }),
      });

      // Verify there are at least 2 origins (one per compute function URL)
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Origins: Match.arrayWith([
            Match.objectLike({
              DomainName: Match.anyValue(),
            }),
            Match.objectLike({
              DomainName: Match.anyValue(),
            }),
          ]),
        }),
      });

      // Verify the default behavior uses ALL allowed methods (compute)
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

  void describe('InvalidRoutePatternError', () => {
    void it('throws for regex syntax in route pattern', () => {
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

      assert.throws(
        () =>
          new CdnConstruct(stack, 'Cdn', {
            bucket,
            manifest,
            securityHeadersPolicy: policy,
          }),
        (error: unknown) => {
          assert.ok(error instanceof HostingError);
          assert.strictEqual(error.name, 'InvalidRoutePatternError');
          return true;
        },
      );
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

  void describe('BuildId rewrite function', () => {
    void it('creates CloudFront Function with build ID in code', () => {
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
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('custom-build-123'),
      });
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

  void describe('multi-compute TargetOriginId binding', () => {
    void it('api behavior TargetOriginId differs from default behavior TargetOriginId', () => {
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

      const defaultBehavior = distConfig.DefaultCacheBehavior as Record<
        string,
        unknown
      >;
      const cacheBehaviors = distConfig.CacheBehaviors as Array<
        Record<string, unknown>
      >;

      // Find the /api/* behavior
      const apiBehavior = cacheBehaviors.find(
        (b) => b.PathPattern === '/api/*',
      );
      assert.ok(apiBehavior, 'Should have a /api/* cache behavior');

      const defaultOriginId = defaultBehavior.TargetOriginId;
      const apiOriginId = apiBehavior.TargetOriginId;

      assert.ok(defaultOriginId, 'Default behavior should have TargetOriginId');
      assert.ok(apiOriginId, '/api/* behavior should have TargetOriginId');
      assert.notStrictEqual(
        defaultOriginId,
        apiOriginId,
        'Default and API behaviors must route to DIFFERENT origins',
      );
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

  void it('throws when an over-cap rule drops a security header (CSP)', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    assert.throws(
      () =>
        new CdnConstruct(stack, 'Cdn', {
          bucket,
          manifest: baseStatic(fill({ 'content-security-policy': "default-src 'self'" })),
          securityHeadersPolicy: policy,
        }),
      (e: Error) => {
        assert.strictEqual(e.name, 'SecurityHeaderDroppedError');
        return true;
      },
    );
  });

  void it('does NOT throw when an over-cap rule drops only a cosmetic header', () => {
    const stack = createStack();
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    // Should synth fine (the cosmetic header is dropped with a warning).
    assert.doesNotThrow(
      () =>
        new CdnConstruct(stack, 'Cdn', {
          bucket,
          manifest: baseStatic(fill({ 'x-custom-cosmetic': 'value' })),
          securityHeadersPolicy: policy,
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
});
