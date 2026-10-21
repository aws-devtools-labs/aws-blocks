import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { HostingPlan } from '../plan/types.js';
import { buildDoorInput } from './door_input.js';

const ssrPlan: HostingPlan = {
  origins: [
    { id: 'blocks-s3', kind: 'static' },
    { id: 'blocks-server', kind: 'server' },
    { id: 'blocks-image', kind: 'image' },
  ],
  routes: {
    entries: [
      { pattern: '/_next/static/*', kind: 'static' },
      { pattern: '/_next/image*', kind: 'image' },
      { pattern: '/*', kind: 'server' },
    ],
    redirects: [{ source: '/old', destination: '/new', statusCode: 308 }],
    headers: [{ pattern: '/*', headers: { 'x-a': '1' } }],
  },
  policies: { spaFallback: false, hasServer: true, skewEnabled: true, basePath: '/app' },
  release: { buildId: 'b7' },
};

const fn = (stack: Stack, id: string) =>
  new LambdaFunction(stack, id, { runtime: Runtime.NODEJS_22_X, handler: 'index.handler', code: Code.fromInline('x') });

const setup = () => {
  const stack = new Stack(new App(), 'In', { env: { account: '111111111111', region: 'us-east-1' } });
  const bucket = new Bucket(stack, 'Assets');
  const server = fn(stack, 'Server');
  const image = fn(stack, 'Image');
  const imageUrl = image.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });
  return { stack, bucket, server, image, imageUrl };
};

describe('buildDoorInput — app facts and origins', () => {
  it('joins every route to its origin object (no lookup by name)', () => {
    const { bucket, server, image, imageUrl } = setup();
    const input = buildDoorInput({
      plan: ssrPlan,
      bucket,
      staticDir: '/tmp/static',
      server: { fn: server, streaming: true },
      image: { fn: image, url: imageUrl },
    });
    const byPattern = Object.fromEntries(input.app.routes.map((r) => [r.pattern, r.origin]));
    assert.equal(byPattern['/_next/static/*'], input.origins.assets);
    assert.equal(byPattern['/_next/image*'], input.origins.image);
    assert.equal(byPattern['/*'], input.origins.server);
    assert.deepEqual(
      input.app.routes.map((r) => r.pattern),
      ['/_next/static/*', '/_next/image*', '/*'],
      'route order (most-specific first) is preserved',
    );
    assert.equal(input.origins.assets.prefix, 'builds/b7/');
    assert.equal(input.origins.assets.sourceDir, '/tmp/static');
    assert.ok(input.origins.image, 'the image origin (its route is in app.routes)');
    assert.equal(input.app.buildId, 'b7');
    assert.equal(input.app.basePath, '/app');
    assert.deepEqual(input.app.redirects, ssrPlan.routes.redirects);
    assert.deepEqual(input.app.headers, ssrPlan.routes.headers);
    assert.deepEqual(input.features.skewProtection, { enabled: true, maxAge: 86400 }, 'skew protection is on by default');
  });

  it('creates the server Function URL only when a door reads it', () => {
    const { stack, bucket, server } = setup();
    const input = buildDoorInput({ plan: ssrPlan, bucket, staticDir: '.', server: { fn: server, streaming: true } });
    assert.equal(server.node.tryFindChild('FunctionUrl'), undefined, 'building the input added no Function URL');
    const url = input.origins.server?.url;
    assert.ok(url);
    assert.equal(input.origins.server?.url, url, 'created once');
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Url', { InvokeMode: 'RESPONSE_STREAM' });
    Template.fromStack(stack).resourceCountIs('AWS::Lambda::Url', 2); // the image URL + the server URL
  });

  it('lists /aws-blocks/* plus the raw routes as API paths, (sign-in included under /aws-blocks/*)', () => {
    const { bucket } = setup();
    const input = buildDoorInput({
      plan: ssrPlan,
      bucket,
      staticDir: '.',
      api: { url: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks', paths: ['/webhooks/*', '/health'] },
    });
    assert.deepEqual(input.origins.api?.paths, ['/aws-blocks/*', '/webhooks/*', '/health']);
    assert.ok(!input.origins.api?.paths.includes('/aws-blocks-auth/*'), 'no stale /aws-blocks-auth/* path');
    // A literal URL resolves at synth; a token URL is split in-template.
    assert.equal(input.origins.api?.host, 'abc123.execute-api.us-east-1.amazonaws.com');
    assert.equal(input.origins.api?.stagePath, '/prod');
  });

  it('splits a token API URL in-template (Fn::Split / Fn::Select)', () => {
    const { stack, bucket, image } = setup();
    const input = buildDoorInput({
      plan: ssrPlan,
      bucket,
      staticDir: '.',
      api: { url: `https://${image.functionName}.example.com/prod/aws-blocks` },
    });
    const host = JSON.stringify(stack.resolve(input.origins.api?.host));
    assert.match(host, /Fn::Select/);
    assert.match(host, /Fn::Split/);
  });

  it('has no api origin when Hosting was given no API', () => {
    const { bucket } = setup();
    assert.equal(buildDoorInput({ plan: ssrPlan, bucket, staticDir: '.' }).origins.api, undefined);
  });
});

describe('buildDoorInput — features are present only when the app asked for them', () => {
  it('no feature props → only the default-on skew protection', () => {
    const { bucket } = setup();
    const input = buildDoorInput({ plan: ssrPlan, bucket, staticDir: '.' });
    assert.deepEqual(input.features, { skewProtection: { enabled: true, maxAge: 86400 } });
  });

  it('a disabled WAF / logging / monitoring is not a request', () => {
    const { bucket } = setup();
    const input = buildDoorInput({
      plan: ssrPlan,
      bucket,
      staticDir: '.',
      waf: { enabled: false },
      logging: { enabled: false },
      monitoring: { enabled: false },
      skewProtection: { enabled: false },
    });
    assert.deepEqual(input.features, {});
  });

  it('each requested feature carries its settings', () => {
    const { bucket } = setup();
    const input = buildDoorInput({
      plan: ssrPlan,
      bucket,
      staticDir: '.',
      domain: { domainName: ['app.example.com', 'www.example.com'], hostedZoneId: 'Z123', hostedZone: 'example.com' },
      waf: { enabled: true, rateLimit: 500 },
      logging: { enabled: true, retentionDays: 7 },
      monitoring: { enabled: true },
      geoRestriction: { type: 'whitelist', countries: ['US', 'CA'] },
      errorPages: { notFound: './404.html' },
    });
    // One vocabulary: the same names and shapes as `frontDoor.features`.
    assert.deepEqual(input.features.domain, {
      domainName: ['app.example.com', 'www.example.com'],
      hostedZoneId: 'Z123',
      hostedZone: 'example.com',
    });
    assert.deepEqual(input.features.waf, { enabled: true, rateLimit: 500 });
    assert.deepEqual(input.features.logging, { enabled: true, retentionDays: 7 });
    assert.deepEqual(input.features.monitoring, { enabled: true });
    // The legacy spelling reaches the door as the inclusive one.
    assert.deepEqual(input.features.geoRestriction, { type: 'allowlist', countries: ['US', 'CA'] });
    assert.deepEqual(input.app.errorPages, { notFound: '404.html' });
  });

  it('a BYO web ACL (waf.webAclArn or cdn.webAclArn) is a WAF request', () => {
    const { bucket } = setup();
    const arn = 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/x/1';
    assert.deepEqual(buildDoorInput({ plan: ssrPlan, bucket, staticDir: '.', cdnWebAclArn: arn }).features.waf, {
      enabled: false,
      webAclArn: arn,
    });
  });
});
