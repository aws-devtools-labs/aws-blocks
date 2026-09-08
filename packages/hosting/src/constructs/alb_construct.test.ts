import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { CapabilityPlan } from '../plan/types.js';
import { AlbConstruct } from './alb_construct.js';
import { AlbAdapter } from './alb_adapter.js';

const staticPlan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: {
    entries: [
      { pattern: '/assets/*', kind: 'static' },
      { pattern: '/about', kind: 'static' },
    ],
    redirects: [{ source: '/old', destination: '/new', statusCode: 308 }],
    headers: [],
  },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'testbuild' },
};

const synth = (plan: CapabilityPlan) => {
  const app = new App();
  const stack = new Stack(app, 'S', { env: { account: '111111111111', region: 'us-west-2' } });
  const bucket = new Bucket(stack, 'Assets');
  new AlbConstruct(stack, 'Alb', { plan, bucket });
  return Template.fromStack(stack);
};

describe('AlbConstruct — static plan', () => {
  const t = synth(staticPlan);

  it('creates an internet-facing ALB', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internet-facing' });
  });

  it('creates an HTTP listener (no cert) on port 80', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 80, Protocol: 'HTTP' });
  });

  it('provisions the static asset-proxy Lambda with the build-id key prefix', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { ASSET_KEY_PREFIX: 'builds/testbuild' } },
    });
  });

  it('creates a listener rule per route entry plus one per redirect', () => {
    // 2 routes + 1 redirect = 3 rules.
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 3);
  });

  it('emits a redirect action for the redirect rule', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Actions: [{ Type: 'redirect', RedirectConfig: { Path: '/new', StatusCode: 'HTTP_301' } }],
    });
  });
});

describe('AlbConstruct — BYO VPC vs default', () => {
  it('creates a default VPC when none is provided', () => {
    synth(staticPlan).resourceCountIs('AWS::EC2::VPC', 1);
  });
});

describe('AlbConstruct — same-origin backend routing (plan.backend)', () => {
  it('forwards /aws-blocks/* + /aws-blocks-auth/* to one ingress via a forwarder Lambda (single-compute)', () => {
    const plan: CapabilityPlan = {
      ...staticPlan,
      backend: {
        origins: [{ namespace: '*', ingress: { kind: 'url', url: 'https://abc.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' } }],
      },
    };
    const t = synth(plan);
    // 2 routes + 1 redirect + 2 API paths (/aws-blocks/* + /aws-blocks-auth/*) = 5 rules.
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 5);
    // The forwarder target group preserves multiple Set-Cookie headers.
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'lambda',
    });
  });

  it('provisions one forwarder Lambda + rule per named namespace (multi-compute)', () => {
    const plan: CapabilityPlan = {
      ...staticPlan,
      backend: {
        origins: [
          { namespace: 'notes', ingress: { kind: 'url', url: 'https://notes.example.com/aws-blocks/api' } },
          { namespace: 'users', ingress: { kind: 'url', url: 'https://users.example.com/aws-blocks/api' } },
        ],
      },
    };
    const t = synth(plan);
    // 2 routes + 1 redirect + 2 namespace API rules = 5 rules.
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 5);
  });
});

describe('AlbAdapter — negotiation gating', () => {
  const adapter = new AlbAdapter();

  it('declares ALB support tiers', () => {
    assert.equal(adapter.supports('RunServerRender'), 'core');
    assert.equal(adapter.supports('StreamServerRender'), 'core');
    assert.equal(adapter.supports('RouteRequest'), 'extended');
    assert.equal(adapter.supports('CacheResponses'), 'degraded');
    assert.equal(adapter.supports('PinSession'), 'degraded');
  });

  it('throws when a plan requires a degraded capability without opt-in (skew on)', () => {
    const app = new App();
    const stack = new Stack(app, 'S2', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    const skewPlan: CapabilityPlan = {
      ...staticPlan,
      policies: { ...staticPlan.policies, skewEnabled: true },
    };
    assert.throws(
      () => new AlbAdapter().render(stack, skewPlan, { bucket }),
      /PinSession/,
    );
  });

  it('renders when the degraded capability is explicitly accepted', () => {
    const app = new App();
    const stack = new Stack(app, 'S3', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    const skewPlan: CapabilityPlan = {
      ...staticPlan,
      policies: { ...staticPlan.policies, skewEnabled: true },
    };
    const res = new AlbAdapter().render(stack, skewPlan, { bucket, degrade: ['PinSession'] });
    assert.ok(res.url.startsWith('http'));
  });
});
