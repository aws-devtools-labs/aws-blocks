import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { CapabilityPlan } from '../plan/types.js';
import { FunctionUrlConstruct } from './function_url_construct.js';
import { FunctionUrlAdapter } from './function_url_adapter.js';

const spaPlan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [{ pattern: '/assets/*', kind: 'static' }], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'testbuild' },
};

describe('FunctionUrlConstruct — static/SPA', () => {
  const app = new App();
  const stack = new Stack(app, 'S', { env: { account: '111111111111', region: 'us-west-2' } });
  const bucket = new Bucket(stack, 'Assets');
  new FunctionUrlConstruct(stack, 'Fu', { plan: spaPlan, bucket });
  const t = Template.fromStack(stack);

  it('creates a public Function URL (authType NONE)', () => {
    t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
  });
  it('grants the public invoke permission (else the URL 403s)', () => {
    t.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      FunctionUrlAuthType: 'NONE',
      Principal: '*',
    });
  });
  it('provisions the asset-proxy Lambda with the build-id key prefix', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { ASSET_KEY_PREFIX: 'builds/testbuild' } },
    });
  });
});

describe('FunctionUrlAdapter — capability matrix + negotiation', () => {
  const a = new FunctionUrlAdapter();
  it('is the function-url service; SSR/API unsupported', () => {
    assert.equal(a.service, 'function-url');
    assert.equal(a.supports('ServeStaticAsset'), 'extended');
    assert.equal(a.supports('RunServerRender'), 'unsupported');
    assert.equal(a.supports('ProxySameOriginApi'), 'unsupported');
  });
  it('renders a static/SPA plan', () => {
    const app = new App();
    const stack = new Stack(app, 'S2', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    assert.ok(new FunctionUrlAdapter().render(stack, spaPlan, { bucket }).url);
  });
  it('rejects (throws) a plan that requires SSR', () => {
    const app = new App();
    const stack = new Stack(app, 'S3', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    const ssrPlan: CapabilityPlan = {
      ...spaPlan,
      origins: [
        { id: 'blocks-s3', kind: 'static' },
        { id: 'blocks-server', kind: 'server' },
      ],
      policies: { ...spaPlan.policies, hasServer: true },
    };
    assert.throws(() => new FunctionUrlAdapter().render(stack, ssrPlan, { bucket }), /RunServerRender/);
  });
});
