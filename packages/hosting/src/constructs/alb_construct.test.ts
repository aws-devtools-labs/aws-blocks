import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { HostingPlan } from '../plan/types.js';
import { AlbConstruct, packRulePaths } from './alb_construct.js';
import { albDoor } from './alb_door.js';
import { buildFrontDoor } from './custom_door.js';
import { buildDoorInput } from './door_input.js';

const staticPlan: HostingPlan = {
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

const synth = (plan: HostingPlan) => {
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

  it('creates a rule for the redirect; routes that go where the default goes need none', () => {
    // The two static routes go to the asset proxy, the default target, so only
    // the redirect source needs a rule.
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 1);
  });

  it('routes the redirect source to the asset proxy, which answers the redirect (wildcard tail spliced, as on CloudFront)', () => {
    const rules = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
    const redirectRule = rules.find((r) =>
      (r.Properties.Conditions as Array<{ PathPatternConfig?: { Values: string[] } }>).some((c) =>
        c.PathPatternConfig?.Values.includes('/old'),
      ),
    );
    assert.ok(redirectRule, 'a rule for the redirect source');
    assert.strictEqual(redirectRule.Properties.Actions[0].Type, 'forward');
    const staticTg = Object.keys(t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup')).find((id) =>
      id.includes('StaticTg'),
    );
    assert.deepStrictEqual(redirectRule.Properties.Actions[0].TargetGroupArn, { Ref: staticTg });
    // The asset proxy carries the rule, with its exact status (a native ALB redirect only has 301/302).
    const proxy = Object.values(t.findResources('AWS::Lambda::Function')).find((f) =>
      String(f.Properties.Code?.ZipFile ?? '').includes('BLOCKS_REDIRECTS'),
    );
    assert.match(String(proxy?.Properties.Code.ZipFile), /\["\/old","\/new",308\]/);
  });
});

describe('AlbConstruct — native cross-cutting features (not CloudFront imitations)', () => {
  it('accessLogging → the ALB\'s own access logs are enabled to an S3 bucket', () => {
    const app = new App();
    const stack = new Stack(app, 'AL', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    new AlbConstruct(stack, 'Alb', { plan: staticPlan, bucket, accessLogging: true });
    const t = Template.fromStack(stack);
    // Native ALB access-logging attribute (not a proxy/format shim).
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'access_logs.s3.enabled', Value: 'true' }]),
    });
  });

  it('waf → a native WAFv2 REGIONAL WebACL associated with the ALB', () => {
    const app = new App();
    const stack = new Stack(app, 'WF', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    new AlbConstruct(stack, 'Alb', { plan: staticPlan, bucket, waf: { enabled: true, rateLimit: 500 } });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'REGIONAL' });
    // The association binds the WebACL to the ALB (the native AWS mechanism).
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it('monitoring → CloudWatch alarms on the ALB\'s own metrics', () => {
    const app = new App();
    const stack = new Stack(app, 'MON', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    new AlbConstruct(stack, 'Alb', { plan: staticPlan, bucket, monitoring: true });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::CloudWatch::Alarm', 2); // 5xx + target response time
  });

  it('none of the above by default → no WebACL, no alarms, no access logging', () => {
    const app = new App();
    const stack = new Stack(app, 'NONE', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    new AlbConstruct(stack, 'Alb', { plan: staticPlan, bucket });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    t.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });
});

describe('AlbConstruct — BYO VPC vs default', () => {
  it('creates a default VPC when none is provided', () => {
    synth(staticPlan).resourceCountIs('AWS::EC2::VPC', 1);
  });

  it('default VPC is public-only — no idle NAT Gateway (public ALB + non-VPC Lambdas need none)', () => {
    const t = synth(staticPlan);
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
    // No PRIVATE_WITH_EGRESS tier, so no default route to a NAT Gateway.
    t.resourceCountIs('AWS::EC2::Route', 2); // one public default route per AZ (maxAzs: 2)
  });
});

describe('AlbConstruct — same-origin backend routing (plan.backend)', () => {
  it('forwards /aws-blocks/* (RPC + sign-in) to one ingress via a forwarder Lambda (single-compute)', () => {
    const plan: HostingPlan = {
      ...staticPlan,
      backend: {
        origins: [{ namespace: '*', ingress: { kind: 'url', url: 'https://abc.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' } }],
      },
    };
    const t = synth(plan);
    // 1 redirect + 1 API rule (/aws-blocks/*, which covers /aws-blocks/auth/*) = 2 rules.
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
    // The forwarder target group runs in multi-value mode: the forwarder reads
    // `multiValueHeaders` (cookies) and relays every Set-Cookie.
    const apiTgs = Object.entries(t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup')).filter(([id]) =>
      id.includes('ApiProxyTg'),
    );
    assert.equal(apiTgs.length, 1);
    assert.deepEqual(apiTgs[0]?.[1].Properties.TargetGroupAttributes, [
      { Key: 'lambda.multi_value_headers.enabled', Value: 'true' },
    ]);
  });

  it('provisions one forwarder Lambda + rule per named namespace (multi-compute)', () => {
    const plan: HostingPlan = {
      ...staticPlan,
      backend: {
        origins: [
          { namespace: 'notes', ingress: { kind: 'url', url: 'https://notes.example.com/aws-blocks/api' } },
          { namespace: 'users', ingress: { kind: 'url', url: 'https://users.example.com/aws-blocks/api' } },
        ],
      },
    };
    const t = synth(plan);
    // 1 redirect + 2 namespace API rules = 3 rules.
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 3);
  });
});

describe('albDoor — free-form build', () => {
  const buildAlb = (id: string, plan: HostingPlan) => {
    const stack = new Stack(new App(), id, { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    const input = buildDoorInput({ plan, bucket, staticDir: '.' });
    return buildFrontDoor(stack, albDoor, { ...input, alb: { plan, bucket } }, { wiringCheck: false }).result;
  };

  it('returns the ALB URL and an http origin handle (no certificate → HTTP listener)', () => {
    const res = buildAlb('R', staticPlan);
    assert.ok(res.url.startsWith('http'));
    assert.equal(res.originHandle.protocol, 'http');
    assert.ok(res.originHandle.domainName);
    assert.ok(res.construct instanceof AlbConstruct);
  });

  it('builds with no feature check: a skew-on plan (an edge feature the ALB lacks) still builds', () => {
    const skewPlan: HostingPlan = {
      ...staticPlan,
      policies: { ...staticPlan.policies, skewEnabled: true },
    };
    assert.ok(buildAlb('S2', skewPlan).url.startsWith('http'));
  });
});

/** Every listener rule's path patterns, in priority order. */
const rulePaths = (t: Template): Array<{ priority: number; paths: string[]; header?: unknown[] }> =>
  Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'))
    .map((r) => {
      const conditions = r.Properties.Conditions as Array<{
        Field: string;
        PathPatternConfig?: { Values: string[] };
        HttpHeaderConfig?: { Values: unknown[] };
      }>;
      return {
        priority: r.Properties.Priority as number,
        paths: conditions.flatMap((c) => c.PathPatternConfig?.Values ?? []),
        header: conditions.find((c) => c.HttpHeaderConfig)?.HttpHeaderConfig?.Values,
      };
    })
    .sort((a, b) => a.priority - b.priority);

describe('AlbConstruct — listener rules are packed and bounded', () => {
  const serverPlan = (entries: HostingPlan['routes']['entries'], redirects: HostingPlan['routes']['redirects'] = []): HostingPlan => ({
    ...staticPlan,
    routes: { entries, redirects, headers: [] },
    policies: { ...staticPlan.policies, hasServer: true },
  });
  const synthWithServer = (plan: HostingPlan, opts: { restrictToCloudFront?: boolean; apiPaths?: string[] } = {}) => {
    const stack = new Stack(new App(), 'P', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    const server = new LambdaFunction(stack, 'Server', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => ({})'),
    });
    new AlbConstruct(stack, 'Alb', {
      plan,
      bucket,
      computeFunctions: new Map([['server', server]]),
      serverComputeName: 'server',
      ...opts,
    });
    return { t: Template.fromStack(stack), stack };
  };

  it('packs redirect sources five to a rule (they all go to the asset proxy)', () => {
    const redirects = Array.from({ length: 12 }, (_, i) => ({ source: `/old-${i}`, destination: `/new-${i}`, statusCode: 301 as const }));
    const { t } = synthWithServer(serverPlan([], redirects));
    const rules = rulePaths(t);
    assert.deepEqual(rules.map((r) => r.paths.length), [5, 5, 2]);
    assert.deepEqual(rules.flatMap((r) => r.paths), redirects.map((r) => r.source));
  });

  it('packs consecutive routes with the same target, keeps the order between targets, and drops trailing default-target routes', () => {
    const { t } = synthWithServer(
      serverPlan([
        { pattern: '/a/*', kind: 'static' },
        { pattern: '/b/*', kind: 'static' },
        { pattern: '/c/*', kind: 'server' },
        { pattern: '/d/*', kind: 'static' },
        { pattern: '/e', kind: 'server' },
        { pattern: '/f', kind: 'server' },
      ]),
    );
    assert.deepEqual(
      rulePaths(t).map((r) => r.paths),
      [['/a/*', '/b/*'], ['/c/*'], ['/d/*']],
    );
  });

  it('a locked router: every rule carries the origin-verify header, with four paths beside it', () => {
    const redirects = [{ source: '/old', destination: '/new', statusCode: 301 as const }];
    const apiPaths = ['/aws-blocks/*', '/a/*', '/b/*', '/c/*', '/d/*', '/e/*'];
    const plan: HostingPlan = {
      ...serverPlan([{ pattern: '/assets/*', kind: 'static' }], redirects),
      backend: { origins: [{ namespace: '*', ingress: { kind: 'url', url: 'https://abc.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' } }] },
    };
    const { t } = synthWithServer(plan, { restrictToCloudFront: true, apiPaths });
    const rules = rulePaths(t);
    for (const rule of rules) {
      assert.equal(rule.header?.length, 1, `rule ${rule.priority} checks the header`);
      assert.match(JSON.stringify(rule.header?.[0]), /resolve:secretsmanager:/);
    }
    // API: 6 paths, 4 per rule → 2 rules; the redirect; the static route; the catch-all.
    assert.deepEqual(rules.map((r) => r.paths), [
      ['/aws-blocks/*', '/a/*', '/b/*', '/c/*'],
      ['/d/*', '/e/*'],
      ['/old'],
      ['/assets/*'],
      [],
    ]);
  });

  it("never routes the backend's catch-all raw route ('/*') to the API, and warns (as the API Gateway door does)", () => {
    const plan: HostingPlan = {
      ...serverPlan([{ pattern: '/assets/*', kind: 'static' }]),
      backend: { origins: [{ namespace: '*', ingress: { kind: 'url', url: 'https://abc.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' } }] },
    };
    const { t, stack } = synthWithServer(plan, { apiPaths: ['/aws-blocks/*', '/*', '/hooks/*'] });
    const rules = rulePaths(t).map((r) => r.paths);
    assert.deepEqual(rules[0], ['/aws-blocks/*', '/hooks/*'], 'the API rule');
    assert.ok(!rules.flat().includes('/*'), 'no rule sends every path to the API');
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('CatchAllApiPathNotRouted'));
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.entry.data), /ALB front door/);
  });

  // Measured with CreateRule: a rule takes 5 condition values (the header's
  // included) and 6 wildcards (`*` and `?` alike) across its conditions.
  it('never packs more than 5 values or 6 wildcards into one rule (redirects, routes and API paths, locked router)', () => {
    const wild = Array.from({ length: 6 }, (_, i) => `/s${i}/*/x/*`); // 2 wildcards each
    const plan: HostingPlan = {
      ...serverPlan(
        wild.map((pattern) => ({ pattern, kind: 'static' as const })),
        wild.map((source, i) => ({ source, destination: `/n${i}/*`, statusCode: 301 as const })),
      ),
      backend: { origins: [{ namespace: '*', ingress: { kind: 'url', url: 'https://abc.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' } }] },
    };
    const { t } = synthWithServer(plan, { restrictToCloudFront: true, apiPaths: ['/aws-blocks/*', ...wild] });
    const rules = rulePaths(t).filter((r) => r.paths.length > 0);
    assert.ok(rules.length > 0);
    for (const rule of rules) {
      const values = rule.paths.length + (rule.header?.length ?? 0);
      const wildcards = rule.paths.join('').replace(/[^*?]/g, '').length;
      assert.ok(values <= 5, `rule ${rule.priority}: ${values} values`);
      assert.ok(wildcards <= 6, `rule ${rule.priority}: ${wildcards} wildcards (${rule.paths.join(' ')})`);
    }
    // Every pattern is still routed, in order.
    assert.deepEqual(rules.filter((r) => r.priority >= 100 && r.priority < 1000).flatMap((r) => r.paths), wild);
  });

  it('packRulePaths: values and wildcards per rule, order kept; a pattern over the wildcard limit fails synth', () => {
    assert.deepEqual(packRulePaths(['/a', '/b', '/c', '/d', '/e', '/f'], 5), [['/a', '/b', '/c', '/d', '/e'], ['/f']]);
    assert.deepEqual(packRulePaths(['/a/*/b/*', '/c/*/d/*', '/e/*/f/*', '/g/*'], 4), [['/a/*/b/*', '/c/*/d/*', '/e/*/f/*'], ['/g/*']]);
    assert.deepEqual(packRulePaths(['/a?/*', '/b/*'], 4), [['/a?/*', '/b/*']]);
    assert.throws(() => packRulePaths(['/*/*/*/*/*/*/*'], 5), (e: Error) => e.name === 'UnsupportedRoutePatternError');
  });

  it('warns when the rules exceed the default quota of 100 per load balancer', () => {
    const entries = Array.from({ length: 202 }, (_, i) => ({ pattern: `/p${i}/*`, kind: i % 2 === 0 ? ('static' as const) : ('server' as const) }));
    const { stack } = synthWithServer(serverPlan(entries));
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AlbRuleLimit'));
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.entry.data), /201 listener rules/);
    // Under the quota: no warning.
    const { stack: small } = synthWithServer(serverPlan(entries.slice(0, 20)));
    assert.equal(Annotations.fromStack(small).findWarning('*', Match.stringLikeRegexp('AlbRuleLimit')).length, 0);
  });
});

describe('AlbConstruct — custom domain', () => {
  const synthDomain = (domain: { names: string[]; hostedZone?: string; hostedZoneId?: string }) => {
    const stack = new Stack(new App(), 'D', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    const certificate = Certificate.fromCertificateArn(stack, 'Cert', 'arn:aws:acm:us-west-2:111111111111:certificate/c');
    const alb = new AlbConstruct(stack, 'Alb', { plan: staticPlan, bucket, certificate, domain });
    return { t: Template.fromStack(stack), alb };
  };

  it('serves HTTPS (TLS 1.2+) at the domain, redirects port 80 to 443, and points the names at the ALB', () => {
    const { t, alb } = synthDomain({ names: ['app.example.com', 'www.example.com'], hostedZone: 'example.com', hostedZoneId: 'Z123' });
    assert.equal(alb.url, 'https://app.example.com');
    assert.equal(alb.originHandle.domainName, 'app.example.com');
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect', RedirectConfig: Match.objectLike({ Port: '443', Protocol: 'HTTPS' }) })],
    });
    t.resourceCountIs('AWS::Route53::RecordSet', 4);
    t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'www.example.com.', Type: 'AAAA' });
  });

  it('without a hosted zone: no DNS records (you point your DNS at the ALB), the URL is still the domain', () => {
    const { t, alb } = synthDomain({ names: ['app.example.com'] });
    assert.equal(alb.url, 'https://app.example.com');
    t.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('internal with the default VPC: the ALB sits in isolated private subnets (no NAT)', () => {
    const stack = new Stack(new App(), 'I', { env: { account: '111111111111', region: 'us-west-2' } });
    const bucket = new Bucket(stack, 'Assets');
    new AlbConstruct(stack, 'Alb', { plan: staticPlan, bucket, internal: true });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
    const subnets = Object.entries(t.findResources('AWS::EC2::Subnet'));
    const privateIds = subnets.filter(([id]) => id.includes('private')).map(([id]) => id);
    assert.equal(privateIds.length, 2);
    const lb = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))[0];
    assert.ok(lb);
    assert.deepEqual(
      (lb.Properties.Subnets as Array<{ Ref: string }>).map((s) => s.Ref).sort(),
      privateIds.sort(),
    );
  });
});

describe('AlbConstruct — the stacked router\'s origin-verify secret', () => {
  const locked = (id: string) => {
    const stack = new Stack(new App(), id, { env: { account: '111111111111', region: 'us-west-2' } });
    const alb = new AlbConstruct(stack, 'Alb', { plan: staticPlan, bucket: new Bucket(stack, 'Assets'), restrictToCloudFront: true });
    return { stack, alb, t: Template.fromStack(stack) };
  };

  it('is a generated Secrets Manager secret, referenced (never written) by the rules and the origin header alike', () => {
    const { stack, alb, t } = locked('Sec1');
    const secrets = t.findResources('AWS::SecretsManager::Secret');
    assert.equal(Object.keys(secrets).length, 1);
    const id = Object.keys(secrets)[0];
    assert.equal(secrets[id]?.Properties.GenerateSecretString.ExcludePunctuation, true, 'no ALB wildcard characters');
    const ref = { 'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: id }, ':SecretString:::}}']] };
    assert.deepEqual(stack.resolve(alb.originHandle.customHeaders?.['x-blocks-origin-verify']), ref);
    for (const rule of rulePaths(t)) assert.deepEqual(rule.header, [ref]);
    // No value is derivable from the template: no 64-character literal anywhere.
    assert.doesNotMatch(JSON.stringify(t.toJSON()), /"[0-9a-f]{64}"/);
  });

  it('two stacks with the same name and path get independent secrets (nothing computed from public inputs)', () => {
    const a = locked('Same').t.findResources('AWS::SecretsManager::Secret');
    const b = locked('Same').t.findResources('AWS::SecretsManager::Secret');
    // The template only asks Secrets Manager to generate a value; each stack's
    // secret is created (and so generated) on its own.
    assert.deepEqual(Object.values(a)[0]?.Properties, Object.values(b)[0]?.Properties);
    assert.equal(Object.values(a)[0]?.Properties.SecretString, undefined, 'no fixed value');
  });

  it('a public ALB door has no secret', () => {
    const stack = new Stack(new App(), 'NoSec', { env: { account: '111111111111', region: 'us-west-2' } });
    new AlbConstruct(stack, 'Alb', { plan: staticPlan, bucket: new Bucket(stack, 'Assets') });
    Template.fromStack(stack).resourceCountIs('AWS::SecretsManager::Secret', 0);
  });
});
