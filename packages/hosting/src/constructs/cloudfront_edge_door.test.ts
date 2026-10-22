import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { HostingPlan } from '../plan/types.js';
import { AlbConstruct } from './alb_construct.js';
import { cloudFrontEdgeDoor } from './cloudfront_edge_door.js';
import { buildFrontDoor } from './custom_door.js';
import { buildDoorInput } from './door_input.js';

const plan: HostingPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [{ pattern: '/assets/*', kind: 'static' }], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'testbuild' },
};

/** The composable path: an `AlbConstruct` locked to CloudFront, fronted by `cloudFrontEdgeDoor`. */
const compose = (id: string, opts: { internal: boolean; https: boolean }) => {
  const stack = new Stack(new App(), id, { env: { account: '111111111111', region: 'us-west-2' } });
  const bucket = new Bucket(stack, 'Assets');
  const vpc = new Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 });
  const certificate = opts.https
    ? Certificate.fromCertificateArn(stack, 'Cert', 'arn:aws:acm:us-west-2:111111111111:certificate/test')
    : undefined;
  const alb = new AlbConstruct(stack, 'Router', {
    plan,
    bucket,
    vpc,
    internal: opts.internal,
    certificate,
    // A certificate serves a domain (it can't cover the load balancer's own name).
    ...(certificate ? { domain: { names: ['router.example.com'], hostedZone: 'example.com', hostedZoneId: 'Z1' } } : {}),
    restrictToCloudFront: true,
  });
  // The API is dynamic, so the edge sends it to the router.
  const input = buildDoorInput({
    plan,
    bucket,
    staticDir: '.',
    api: { url: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' },
  });
  buildFrontDoor(
    stack,
    cloudFrontEdgeDoor,
    { ...input, upstream: { service: 'alb', url: alb.url, originHandle: alb.originHandle } },
    { wiringCheck: false },
  );
  return Template.fromStack(stack);
};

const listenerPort = (t: Template) => {
  const listeners = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::Listener'));
  assert.equal(listeners.length, 1);
  return listeners[0].Properties.Port as number;
};

describe('cloudFrontEdgeDoor — edge → router hop follows the router listener', () => {
  for (const https of [false, true]) {
    const scheme = https ? 'HTTPS :443' : 'HTTP :80';

    it(`internal router on ${scheme}: the VPC origin and its ingress use the listener's protocol and port`, () => {
      const t = compose(`Internal${https ? 'Https' : 'Http'}`, { internal: true, https });
      const port = listenerPort(t);
      assert.equal(port, https ? 443 : 80);

      const vpcOrigins = Object.values(t.findResources('AWS::CloudFront::VpcOrigin'));
      assert.equal(vpcOrigins.length, 1);
      const endpoint = vpcOrigins[0].Properties.VpcOriginEndpointConfig;
      assert.equal(endpoint.OriginProtocolPolicy, https ? 'https-only' : 'http-only');
      assert.equal((https ? endpoint.HTTPSPort : endpoint.HTTPPort) ?? (https ? 443 : 80), port);

      const ingress = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).filter(
        (r) => r.Properties.Description === 'CloudFront VPC origin only',
      );
      assert.ok(ingress.length > 0, 'the VPC origin is admitted');
      for (const rule of ingress) {
        assert.equal(rule.Properties.FromPort, port);
        assert.equal(rule.Properties.ToPort, port);
      }
    });

    it(`public router on ${scheme}: the custom origin uses the listener's protocol`, () => {
      const t = compose(`Public${https ? 'Https' : 'Http'}`, { internal: false, https });
      listenerPort(t);
      const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
      const origins = dist.Properties.DistributionConfig.Origins as Array<{
        CustomOriginConfig?: { OriginProtocolPolicy: string };
      }>;
      const router = origins.find((o) => o.CustomOriginConfig);
      assert.ok(router, 'the public ALB is a custom origin');
      assert.equal(router.CustomOriginConfig?.OriginProtocolPolicy, https ? 'https-only' : 'http-only');
      // The ALB admits the CloudFront origin-facing prefix list on the listener's port only.
      const sg = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress'))
        .map((r) => r.Properties as { SourcePrefixListId?: unknown; FromPort: number; ToPort: number })
        .filter((r) => r.SourcePrefixListId !== undefined);
      assert.equal(sg.length, 1);
      assert.equal(sg[0]?.FromPort, https ? 443 : 80);
      assert.equal(sg[0]?.ToPort, https ? 443 : 80);
    });
  }
});

describe('cloudFrontEdgeDoor — an HTTPS router at its own domain', () => {
  for (const internal of [false, true]) {
    it(`${internal ? 'internal (VPC origin)' : 'public'}: the edge connects to the domain the certificate covers, over HTTPS`, () => {
      const stack = new Stack(new App(), `Tls${internal}`, { env: { account: '111111111111', region: 'us-west-2' } });
      const bucket = new Bucket(stack, 'Assets');
      const certificate = Certificate.fromCertificateArn(stack, 'Cert', 'arn:aws:acm:us-west-2:111111111111:certificate/test');
      const alb = new AlbConstruct(stack, 'Router', {
        plan,
        bucket,
        vpc: new Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 }),
        internal,
        certificate,
        domain: { names: ['router.example.com'], hostedZone: 'example.com', hostedZoneId: 'Z1' },
        restrictToCloudFront: true,
      });
      assert.equal(alb.originHandle.protocol, 'https');
      const input = buildDoorInput({
        plan,
        bucket,
        staticDir: '.',
        api: { url: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' },
      });
      buildFrontDoor(stack, cloudFrontEdgeDoor, { ...input, upstream: { service: 'alb', url: alb.url, originHandle: alb.originHandle } }, { wiringCheck: false });
      const t = Template.fromStack(stack);
      assert.equal(listenerPort(t), 443);
      const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
      const origins = dist?.Properties.DistributionConfig.Origins as Array<{ DomainName: unknown; S3OriginConfig?: unknown }>;
      assert.ok(origins.some((o) => o.DomainName === 'router.example.com'), JSON.stringify(origins.map((o) => o.DomainName)));
      if (internal) {
        const vpcOrigin = Object.values(t.findResources('AWS::CloudFront::VpcOrigin'))[0];
        assert.equal(vpcOrigin?.Properties.VpcOriginEndpointConfig.OriginProtocolPolicy, 'https-only');
      }
    });
  }
});

// ── What the edge builds, from the app ─────────────────────────────────────

type Behavior = {
  PathPattern?: string;
  TargetOriginId: string;
  CachePolicyId?: unknown;
  ResponseHeadersPolicyId?: unknown;
  FunctionAssociations?: Array<{ EventType: string; FunctionARN: unknown }>;
};

/** Build the edge alone over a stand-in router, from a plan (+ an image function, + a static dir). */
const edgeFor = (
  id: string,
  p: HostingPlan,
  opts: { image?: boolean; server?: boolean; apiPaths?: string[]; staticDir?: string } = {},
) => {
  const stack = new Stack(new App(), id, { env: { account: '111111111111', region: 'us-east-1' } });
  const bucket = new Bucket(stack, 'Assets');
  const fn = (name: string) =>
    new LambdaFunction(stack, name, { runtime: Runtime.NODEJS_22_X, handler: 'index.handler', code: Code.fromInline('exports.handler=async()=>({})') });
  const image = opts.image ? fn('Image') : undefined;
  const server = opts.server ? fn('Server') : undefined;
  const input = buildDoorInput({
    plan: p,
    bucket,
    staticDir: opts.staticDir ?? '.',
    ...(server ? { server: { fn: server, streaming: false } } : {}),
    ...(image ? { image: { fn: image, url: image.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM }) } } : {}),
    api: { url: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api', paths: opts.apiPaths },
  });
  buildFrontDoor(
    stack,
    cloudFrontEdgeDoor,
    {
      ...input,
      upstream: {
        service: 'alb',
        url: 'http://router.example.com',
        originHandle: { domainName: 'router.example.com', protocol: 'http', customHeaders: { 'x-blocks-origin-verify': 'v' } },
      },
    },
    { wiringCheck: false },
  );
  const t = Template.fromStack(stack);
  const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
  const config = dist?.Properties.DistributionConfig as {
    DefaultCacheBehavior: Behavior;
    CacheBehaviors?: Behavior[];
    CustomErrorResponses?: Array<{ ErrorCode: number; ResponsePagePath?: string }>;
    DefaultRootObject?: string;
    Origins: Array<{ Id: string; S3OriginConfig?: unknown; CustomOriginConfig?: unknown }>;
  };
  const s3Id = config.Origins.find((o) => o.S3OriginConfig)?.Id;
  return { stack, t, config, s3Id, behaviors: config.CacheBehaviors ?? [] };
};

const serverPlan = (entries: HostingPlan['routes']['entries'], extra: Partial<HostingPlan['routes']> = {}): HostingPlan => ({
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries, redirects: [], headers: [], ...extra },
  policies: { spaFallback: false, hasServer: true, skewEnabled: false },
  release: { buildId: 'b42' },
});

describe('cloudFrontEdgeDoor — behaviors, caching, rules', () => {
  it('an image route the router serves: cached on the origin TTLs with no cookies in the key', () => {
    const { t, behaviors } = edgeFor('Img', serverPlan([{ pattern: '/_img/*', kind: 'image' }, { pattern: '/*', kind: 'server' }]), {
      image: true,
      server: true,
    });
    const image = behaviors.find((b) => b.PathPattern === '/_img/*');
    assert.ok(image);
    const policies = t.findResources('AWS::CloudFront::CachePolicy');
    const config = policies[(image.CachePolicyId as { Ref: string }).Ref]?.Properties.CachePolicyConfig;
    assert.equal(config.ParametersInCacheKeyAndForwardedToOrigin.CookiesConfig.CookieBehavior, 'none');
    assert.equal(config.MaxTTL, 31536000);
  });

  it("the app's header rules run on the S3 behaviors and the router behaviors alike", () => {
    const { t, config, behaviors, s3Id } = edgeFor(
      'Hdr',
      serverPlan([{ pattern: '/assets/*', kind: 'static' }, { pattern: '/*', kind: 'server' }], {
        headers: [{ pattern: '/*', headers: { 'X-Rule': 'r' } }],
      }),
      { server: true },
    );
    const fns = t.findResources('AWS::CloudFront::Function');
    const headerFn = Object.keys(fns).find((id) => String(fns[id].Properties.FunctionCode).includes('X-Rule'));
    assert.ok(headerFn);
    const responseFns = (b: Behavior) => JSON.stringify(b.FunctionAssociations?.filter((f) => f.EventType === 'viewer-response'));
    const s3 = behaviors.find((b) => b.TargetOriginId === s3Id);
    assert.ok(s3, 'an S3 behavior');
    assert.ok(responseFns(s3).includes(headerFn), 'on the S3 behavior');
    assert.ok(responseFns(config.DefaultCacheBehavior).includes(headerFn), 'on the router default');
  });

  it("the app's error pages answer from S3 under this build's prefix", () => {
    const p: HostingPlan = { ...plan, release: { buildId: 'b9' } };
    const stack = new Stack(new App(), 'Err', { env: { account: '111111111111', region: 'us-east-1' } });
    const bucket = new Bucket(stack, 'Assets');
    const input = buildDoorInput({ plan: p, bucket, staticDir: '.', errorPages: { notFound: './404.html' } });
    buildFrontDoor(
      stack,
      cloudFrontEdgeDoor,
      { ...input, upstream: { service: 'alb', url: 'http://r.example.com', originHandle: { domainName: 'r.example.com', protocol: 'http' } } },
      { wiringCheck: false },
    );
    const dist = Object.values(Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'))[0];
    const errors = dist?.Properties.DistributionConfig.CustomErrorResponses as Array<{ ErrorCode: number; ResponsePagePath?: string }>;
    assert.ok(errors.some((e) => e.ErrorCode === 404 && e.ResponsePagePath === '/builds/b9/404.html'));
  });

  it('the behavior budget is 24 besides the default; over it, the router becomes the default and S3 routes keep the budget', () => {
    const entries: HostingPlan['routes']['entries'] = [
      ...Array.from({ length: 30 }, (_, i) => ({ pattern: `/s${i}/*`, kind: 'static' as const })),
      { pattern: '/*', kind: 'server' },
    ];
    const apiPaths = Array.from({ length: 10 }, (_, i) => `/hook${i}/*`);
    const { stack, config, behaviors, s3Id } = edgeFor('Budget', serverPlan(entries), { server: true, apiPaths });
    assert.equal(behaviors.length, 24);
    assert.notEqual(config.DefaultCacheBehavior.TargetOriginId, s3Id, 'the router is the default');
    // No static route shares a prefix with the raw API routes, so those reach the router default.
    assert.ok(!behaviors.some((b) => b.PathPattern?.startsWith('/hook')));
    assert.ok(behaviors.every((b) => b.TargetOriginId === s3Id));
    assert.equal(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('StackedEdgeBehaviorLimit')).length, 1);
  });

  it('an API path a kept S3 pattern could shadow keeps its (uncached) behavior ahead of it', () => {
    const entries: HostingPlan['routes']['entries'] = [
      ...Array.from({ length: 30 }, (_, i) => ({ pattern: `/s${i}/*`, kind: 'static' as const })),
      { pattern: '/*', kind: 'server' },
    ];
    const { behaviors } = edgeFor('Shadow', serverPlan(entries), { server: true, apiPaths: ['/s1/hook'] });
    const order = behaviors.map((b) => b.PathPattern);
    assert.ok(order.indexOf('/s1/hook') >= 0 && order.indexOf('/s1/hook') < order.indexOf('/s1/*'));
  });

  it('files the router serves (beyond the S3 behaviors) are checked against the ALB 1 MB limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-big-'));
    try {
      fs.mkdirSync(path.join(dir, 's0'));
      fs.mkdirSync(path.join(dir, 'other'));
      fs.writeFileSync(path.join(dir, 's0', 'big.bin'), randomBytes(1_200_000));
      fs.writeFileSync(path.join(dir, 'other', 'big.bin'), randomBytes(1_200_000));
      const entries: HostingPlan['routes']['entries'] = [
        ...Array.from({ length: 30 }, (_, i) => ({ pattern: `/s${i}/*`, kind: 'static' as const })),
        { pattern: '/*', kind: 'server' },
      ];
      const { stack } = edgeFor('Big', serverPlan(entries), { server: true, staticDir: dir });
      const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AssetExceedsProxyLimit'));
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]?.entry.data), /\/other\/big\.bin/);
      assert.doesNotMatch(String(warnings[0]?.entry.data), /\/s0\/big\.bin/, 'served from S3 by a kept behavior');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
