import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { Code, FunctionUrlAuthType, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { HostingPlan } from '../plan/types.js';
import { cf, registerUploads, trimSlashes } from './cf_helpers.js';
import { buildDoorInput } from './door_input.js';

const plan: HostingPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: {
    entries: [
      { pattern: '/assets/*', kind: 'static' },
      { pattern: '/*', kind: 'static' },
    ],
    redirects: [],
    headers: [],
  },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'b42' },
};

const setup = () => {
  const stack = new Stack(new App(), 'Cf', { env: { account: '111111111111', region: 'us-east-1' } });
  const input = buildDoorInput({
    plan,
    bucket: new Bucket(stack, 'Assets'),
    staticDir: '.',
    api: { url: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api', paths: ['/hooks/*'] },
  });
  return { stack, input };
};

describe('cf.origin', () => {
  it('is memoized per origin, so every behavior shares one CloudFront origin', () => {
    const { input } = setup();
    assert.equal(cf.origin(input.origins.assets), cf.origin(input.origins.assets));
  });

  it('serves the assets from the build prefix via OAC, and the API at its stage path', () => {
    const { stack, input } = setup();
    new Distribution(stack, 'Cdn', {
      defaultBehavior: { origin: cf.origin(input.origins.assets) },
      additionalBehaviors: cf.apiBehaviors(input.origins.api),
    });
    const origins = Template.fromStack(stack).findResources('AWS::CloudFront::Distribution');
    const config = Object.values(origins)[0]?.Properties.DistributionConfig;
    const s3 = config.Origins.find((o: { S3OriginConfig?: unknown }) => o.S3OriginConfig);
    assert.equal(s3.OriginPath, '/builds/b42');
    assert.ok(s3.OriginAccessControlId, 'reaches the private bucket with OAC');
    const api = config.Origins.find((o: { CustomOriginConfig?: unknown }) => o.CustomOriginConfig);
    assert.ok(api.OriginPath, 'the API origin carries the stage path');
  });
});

describe('cf.behaviors', () => {
  it('emits one behavior per route and skips the catch-all (that is the defaultBehavior)', () => {
    const { input } = setup();
    assert.deepEqual(Object.keys(cf.behaviors(input.app.routes)), ['/assets/*']);
  });
});

describe('cf.behaviors — image optimization', () => {
  it('caches on the origin Cache-Control with the query string and Accept in the key, no cookies (one policy per stack)', () => {
    const stack = new Stack(new App(), 'CfImg', { env: { account: '111111111111', region: 'us-east-1' } });
    const image = new LambdaFunction(stack, 'Image', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => ({})'),
    });
    const input = buildDoorInput({
      plan: {
        ...plan,
        routes: { ...plan.routes, entries: [{ pattern: '/_img/*', kind: 'image' }, { pattern: '/img2/*', kind: 'image' }, ...plan.routes.entries] },
      },
      bucket: new Bucket(stack, 'Assets'),
      staticDir: '.',
      image: { fn: image, url: image.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM }) },
    });
    new Distribution(stack, 'Cdn', {
      defaultBehavior: { origin: cf.origin(input.origins.assets) },
      additionalBehaviors: cf.behaviors(input.app.routes),
    });
    const t = Template.fromStack(stack);
    const policies = Object.values(t.findResources('AWS::CloudFront::CachePolicy'));
    assert.equal(policies.length, 1, 'one image cache policy, shared');
    const config = policies[0]?.Properties.CachePolicyConfig;
    assert.equal(config.MaxTTL, 31536000);
    assert.equal(config.DefaultTTL, 0);
    const key = config.ParametersInCacheKeyAndForwardedToOrigin;
    assert.equal(key.CookiesConfig.CookieBehavior, 'none');
    assert.equal(key.QueryStringsConfig.QueryStringBehavior, 'all');
    assert.deepEqual(key.HeadersConfig.Headers, ['accept']);
  });
});

describe('cf.apiBehaviors', () => {
  it('emits a behavior for /aws-blocks/* and every raw route; {} without an API', () => {
    const { input } = setup();
    assert.deepEqual(Object.keys(cf.apiBehaviors(input.origins.api)), ['/aws-blocks/*', '/hooks/*']);
    assert.deepEqual(cf.apiBehaviors(undefined), {});
  });
});

describe('cf.invalidate', () => {
  it('declares an invalidation that depends on every upload it is given', () => {
    const { stack, input } = setup();
    const dist = new Distribution(stack, 'Cdn', { defaultBehavior: { origin: cf.origin(input.origins.assets) } });
    const uploads = [
      new BucketDeployment(stack, 'Up1', { sources: [Source.data('a.txt', 'a')], destinationBucket: input.origins.assets.bucket }),
      new BucketDeployment(stack, 'Up2', { sources: [Source.data('b.txt', 'b')], destinationBucket: input.origins.assets.bucket }),
    ];
    registerUploads(uploads, 'b42');
    const invalidation = cf.invalidate(dist, { after: uploads });
    const deps = invalidation.node.dependencies;
    for (const up of uploads) assert.ok(deps.includes(up), `invalidation must depend on ${up.node.id}`);
    const t = Template.fromStack(stack);
    const [cr] = Object.values(t.findResources('Custom::AWS'));
    assert.match(JSON.stringify(cr?.Properties.Create ?? cr?.Properties.Update), /blocks-b42/);
  });

  it('scopes the CreateInvalidation grant to the distribution, and a second invalidation gets its own caller reference', () => {
    const { stack, input } = setup();
    const dist = new Distribution(stack, 'Cdn', { defaultBehavior: { origin: cf.origin(input.origins.assets) } });
    cf.invalidate(dist, { after: [], buildId: 'b42' });
    cf.invalidate(dist, { after: [], buildId: 'b42', paths: ['/docs/*'] });
    const t = Template.fromStack(stack);
    const refs = Object.values(t.findResources('Custom::AWS')).map((r) =>
      JSON.stringify(r.Properties.Create ?? r.Properties.Update).match(/blocks-b42(-\d+)?/)?.[0],
    );
    assert.deepEqual(refs.sort(), ['blocks-b42', 'blocks-b42-2']);
    const statements = Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Array<{ Action: string; Resource: unknown }>,
    );
    const grant = statements.filter((st) => st.Action === 'cloudfront:CreateInvalidation');
    assert.ok(grant.length > 0);
    for (const st of grant) {
      assert.notEqual(st.Resource, '*');
      assert.match(JSON.stringify(st.Resource), /distribution\//);
    }
  });

  it('throws when the build id cannot be determined', () => {
    const { stack, input } = setup();
    const dist = new Distribution(stack, 'Cdn', { defaultBehavior: { origin: cf.origin(input.origins.assets) } });
    assert.throws(() => cf.invalidate(dist, { after: [] }), (err: Error) => err.name === 'InvalidPropsError');
  });
});

describe('trimSlashes', () => {
  it('strips leading and trailing slashes and keeps inner ones', () => {
    assert.equal(trimSlashes('//builds/abc//'), 'builds/abc');
    assert.equal(trimSlashes('builds/abc'), 'builds/abc');
    assert.equal(trimSlashes('///'), '');
    assert.equal(trimSlashes(''), '');
  });

  it('runs in linear time on a long run of slashes', () => {
    const input = `${'/'.repeat(200_000)}x`;
    const started = performance.now();
    assert.equal(trimSlashes(input), 'x');
    assert.ok(performance.now() - started < 100, 'trimSlashes must not backtrack');
  });
});
