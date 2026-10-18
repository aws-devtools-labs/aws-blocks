/**
 * `frontDoor.features` on `HostingConstruct`: each door kind's settings reach
 * its door, the deprecated top-level props merge into them, and a setting set
 * twice — or one the kind doesn't implement — fails synth.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Distribution, PriceClass } from 'aws-cdk-lib/aws-cloudfront';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { DeployManifest } from '../manifest/types.js';
import { cf } from './cf_helpers.js';
import { type DoorInput, defineFrontDoor } from './front_door.js';
import { FRONT_DOOR_SETTINGS, resolveFrontDoorFeatures } from './front_door_options.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

const WEB_ACL = 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/byo/1';
const REGIONAL_ACL = 'arn:aws:wafv2:us-west-2:111111111111:regional/webacl/byo/1';

describe('HostingConstruct — frontDoor.features', () => {
  let tmpDir: string;
  let bundleDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-features-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    bundleDir = path.join(tmpDir, 'server');
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\nnode server.js');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const spaManifest = (): DeployManifest => ({
    version: 1,
    buildId: 'feat1',
    compute: {},
    staticAssets: { directory: tmpDir, spaFallback: true },
    routes: [{ pattern: '/*', target: 'static' }],
  });
  const ssrManifest = (): DeployManifest => ({
    version: 1,
    buildId: 'feat2',
    compute: {
      server: { type: 'http-server', bundle: bundleDir, entrypoint: 'run.sh', port: 3000, placement: 'regional', streaming: true },
    },
    staticAssets: { directory: tmpDir },
    routes: [{ pattern: '/*', target: 'server' }],
  });

  const synth = (props: Partial<HostingConstructProps>, manifest = spaManifest()) => {
    const stack = new Stack(new App(), 'Feat', { env: { account: '111111111111', region: 'us-east-1' } });
    const hosting = new HostingConstruct(stack, 'Hosting', { manifest, skipRegionValidation: true, ...props });
    return { stack, hosting, template: Template.fromStack(stack) };
  };

  /** A minimal BYO door that records what it receives. */
  const recordingDoor = (seen: { input?: DoorInput }) =>
    defineFrontDoor({
      service: 'recorder',
      build(scope, input) {
        seen.input = input;
        const dist = new Distribution(scope, 'Cdn', { defaultBehavior: { origin: cf.origin(input.origins.assets) } });
        return { url: `https://${dist.distributionDomainName}` };
      },
    });

  // ── each kind's features reach its door ──

  it('CloudFront: { features } (no kind) reaches the distribution', () => {
    const { template } = synth({
      frontDoor: {
        features: {
          priceClass: PriceClass.PRICE_CLASS_ALL,
          geoRestriction: { type: 'whitelist', countries: ['US', 'CA'] },
          contentSecurityPolicy: "default-src 'self'",
          waf: { enabled: false, webAclArn: WEB_ACL },
        },
      },
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        PriceClass: 'PriceClass_All',
        WebACLId: WEB_ACL,
        Restrictions: { GeoRestriction: { RestrictionType: 'whitelist', Locations: ['US', 'CA'] } },
      }),
    });
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: "default-src 'self'", Override: true },
        }),
      }),
    });
  });

  it("CloudFront: { kind: 'cloudfront', features } with monitoring off creates no alarms", () => {
    const { template } = synth({ frontDoor: { kind: 'cloudfront', features: { monitoring: { enabled: false } } } });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });

  it('ALB: features.waf / logging / monitoring reach the load balancer', () => {
    const { template } = synth({
      frontDoor: {
        kind: 'alb',
        features: { waf: { enabled: true, rateLimit: 300 }, logging: { enabled: true }, monitoring: { enabled: true } },
      },
    });
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([
        Match.objectLike({ Statement: { RateBasedStatement: { Limit: 300, AggregateKeyType: 'IP' } } }),
      ]),
    });
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'access_logs.s3.enabled', Value: 'true' }]),
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });

  it('ALB: a BYO REGIONAL web ACL is associated, not created', () => {
    const { template } = synth({ frontDoor: { kind: 'alb', features: { waf: { enabled: true, webAclArn: REGIONAL_ACL } } } });
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', { WebACLArn: REGIONAL_ACL });
  });

  it('ALB: `enabled: false` turns logging and alarms off (not merely "set")', () => {
    const { template } = synth({
      frontDoor: { kind: 'alb', features: { logging: { enabled: false }, monitoring: { enabled: false } } },
    });
    const lb = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))[0];
    const attrs = (lb?.Properties.LoadBalancerAttributes ?? []) as Array<{ Key: string; Value: string }>;
    assert.ok(!attrs.some((a) => a.Key === 'access_logs.s3.enabled' && a.Value === 'true'), 'no ALB access logs');
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });

  it('API Gateway: features.domain maps the custom domain (and satisfies the REST door)', () => {
    const { template } = synth(
      {
        frontDoor: {
          kind: 'apiGateway',
          api: 'rest',
          features: { domain: { domainName: 'app.example.com', hostedZone: 'example.com', hostedZoneId: 'Z123' } },
        },
      },
      ssrManifest(),
    );
    template.hasResourceProperties('AWS::ApiGateway::DomainName', { DomainName: 'app.example.com' });
  });

  it('custom: the BYO door receives features as DoorInput (one mapping)', () => {
    const seen: { input?: DoorInput } = {};
    const email = new EmailSubscription('ops@example.com');
    synth({
      frontDoor: {
        kind: 'custom',
        door: recordingDoor(seen),
        features: {
          domain: { domainName: ['app.example.com', 'www.example.com'], wwwRedirect: 'toApex' },
          waf: { enabled: true, rateLimit: 700, webAclArn: WEB_ACL },
          logging: { enabled: true, retentionDays: 14 },
          monitoring: { subscriptions: [email] },
          geoRestriction: { type: 'blacklist', countries: ['KP'] },
          skewProtection: { enabled: true, maxAge: 600 },
        },
      },
    });
    const input = seen.input;
    assert.ok(input);
    // The same names and shapes as `frontDoor.features` — no mapping.
    assert.deepEqual(input.features.domain, { domainName: ['app.example.com', 'www.example.com'], wwwRedirect: 'toApex' });
    assert.deepEqual(input.features.waf, { enabled: true, webAclArn: WEB_ACL, rateLimit: 700 });
    assert.deepEqual(input.features.logging, { enabled: true, retentionDays: 14 });
    assert.deepEqual(input.features.monitoring, { subscriptions: [email] });
    assert.deepEqual(input.features.geoRestriction, { type: 'blacklist', countries: ['KP'] });
    assert.deepEqual(input.features.skewProtection, { enabled: true, maxAge: 600 });
  });

  it('custom: `skewProtection: { enabled: false }` removes features.skewProtection', () => {
    const seen: { input?: DoorInput } = {};
    synth({ frontDoor: { kind: 'custom', door: recordingDoor(seen), features: { skewProtection: { enabled: false } } } });
    assert.equal(seen.input?.features.skewProtection, undefined);
  });

  // ── the deprecated top-level aliases ──

  it('an alias is merged: top-level props == the same settings in frontDoor.features (whole template)', () => {
    const aliased = synth(
      {
        domain: { domainName: 'app.example.com', hostedZone: 'example.com', hostedZoneId: 'Z123' },
        waf: { enabled: true, rateLimit: 500 },
        logging: { enabled: true, retentionDays: 30 },
        monitoring: { enabled: true },
        skewProtection: { enabled: true, maxAge: 3600 },
        cdn: {
          priceClass: PriceClass.PRICE_CLASS_200,
          cacheKeyCookies: ['sid'],
          ssrDefaultTtl: Duration.seconds(5),
          geoRestriction: { type: 'whitelist', countries: ['US'] },
        },
      },
      ssrManifest(),
    ).template.toJSON();
    const migrated = synth(
      {
        frontDoor: {
          features: {
            domain: { domainName: 'app.example.com', hostedZone: 'example.com', hostedZoneId: 'Z123' },
            waf: { enabled: true, rateLimit: 500 },
            logging: { enabled: true, retentionDays: 30 },
            monitoring: { enabled: true },
            skewProtection: { enabled: true, maxAge: 3600 },
            priceClass: PriceClass.PRICE_CLASS_200,
            cacheKeyCookies: ['sid'],
            ssrDefaultTtl: Duration.seconds(5),
            geoRestriction: { type: 'whitelist', countries: ['US'] },
          },
        },
      },
      ssrManifest(),
    ).template.toJSON();
    assert.deepEqual(migrated, aliased);
  });

  it('an alias reaches a non-CloudFront door: top-level waf → the ALB web ACL', () => {
    const { template } = synth({ frontDoor: { kind: 'alb' }, waf: { enabled: true } });
    template.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'REGIONAL' });
  });

  it('aliases and features combine when they set different settings', () => {
    const { template } = synth({ frontDoor: { features: { priceClass: PriceClass.PRICE_CLASS_ALL } }, waf: { enabled: false, webAclArn: WEB_ACL } });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ PriceClass: 'PriceClass_All', WebACLId: WEB_ACL }),
    });
  });

  it('a setting set both top-level and in frontDoor.features fails synth, naming both', () => {
    assert.throws(
      () => synth({ waf: { enabled: true }, frontDoor: { features: { waf: { enabled: false } } } }),
      (e: Error) =>
        e.name === 'FrontDoorSettingConflictError' && e.message.includes('`waf`') && e.message.includes('`frontDoor.features.waf`'),
    );
    assert.throws(
      () => synth({ cdn: { priceClass: PriceClass.PRICE_CLASS_100 }, frontDoor: { features: { priceClass: PriceClass.PRICE_CLASS_ALL } } }),
      (e: Error) =>
        e.name === 'FrontDoorSettingConflictError' &&
        e.message.includes('`cdn.priceClass`') &&
        e.message.includes('`frontDoor.features.priceClass`'),
    );
    assert.throws(
      () => synth({ cdn: { webAclArn: WEB_ACL }, frontDoor: { features: { waf: { enabled: false, webAclArn: WEB_ACL } } } }),
      (e: Error) => e.name === 'FrontDoorSettingConflictError' && e.message.includes('`cdn.webAclArn`'),
    );
  });

  it('a top-level prop the kind does not implement fails synth, naming the kind and the prop', () => {
    const cases: Array<[Partial<HostingConstructProps>, string, string]> = [
      [{ frontDoor: { kind: 'alb' }, cdn: { geoRestriction: { type: 'whitelist', countries: ['US'] } } }, 'alb', '`cdn.geoRestriction`'],
      [{ frontDoor: { kind: 'alb' }, domain: { domainName: 'app.example.com' } }, 'alb', '`domain`'],
      [{ frontDoor: { kind: 'alb' }, skewProtection: { enabled: true } }, 'alb', '`skewProtection`'],
      [{ frontDoor: { kind: 'alb' }, monitoring: { subscriptions: [new EmailSubscription('a@example.com')] } }, 'alb', '`monitoring.subscriptions`'],
      [{ frontDoor: { kind: 'apiGateway' }, waf: { enabled: true } }, 'apiGateway', '`waf`'],
      [{ frontDoor: { kind: 'apiGateway' }, logging: { enabled: true } }, 'apiGateway', '`logging`'],
      [{ frontDoor: { kind: 'apiGateway' }, domain: { domainName: 'a.example.com', wwwRedirect: 'toWww' } }, 'apiGateway', '`domain.wwwRedirect`'],
      [{ frontDoor: { kind: 'apiGateway' }, cdn: { webAclArn: WEB_ACL } }, 'apiGateway', '`cdn.webAclArn`'],
      [{ frontDoor: 'none', logging: { enabled: true } }, 'none', '`logging`'],
      [{ frontDoor: { kind: 'custom', door: recordingDoor({}) }, cdn: { priceClass: PriceClass.PRICE_CLASS_ALL } }, 'custom', '`cdn.priceClass`'],
    ];
    for (const [props, kind, prop] of cases) {
      assert.throws(
        () => synth(props),
        (e: Error) => e.name === 'UnsupportedFrontDoorSettingError' && e.message.includes(`'${kind}'`) && e.message.includes(prop),
        `${kind} + ${prop}`,
      );
    }
  });

  it('a supported top-level prop on a non-CloudFront kind is accepted', () => {
    assert.doesNotThrow(() => synth({ frontDoor: { kind: 'alb' }, logging: { enabled: true }, monitoring: { enabled: false } }));
    assert.doesNotThrow(() =>
      synth({ frontDoor: { kind: 'custom', door: recordingDoor({}) }, cdn: { geoRestriction: { type: 'whitelist', countries: ['US'] } } }),
    );
  });

  it('a setting forced into another kind’s features (a cast, or JavaScript) fails synth too', () => {
    const forced = { kind: 'alb', features: { priceClass: PriceClass.PRICE_CLASS_ALL } } as unknown as HostingConstructProps['frontDoor'];
    assert.throws(
      () => synth({ frontDoor: forced }),
      (e: Error) => e.name === 'UnsupportedFrontDoorSettingError' && e.message.includes('`frontDoor.features.priceClass`'),
    );
  });
});

describe('resolveFrontDoorFeatures', () => {
  it('an unset alias is ignored and an undefined feature is not a setting', () => {
    const r = resolveFrontDoorFeatures({ kind: 'apiGateway', features: { domain: undefined } }, { waf: { value: undefined, prop: 'waf' } });
    assert.equal(r.kind, 'apiGateway');
    assert.deepEqual(r.features, { domain: undefined });
  });

  it('every kind lists only settings the CloudFront door also knows (one vocabulary)', () => {
    const all = new Set(FRONT_DOOR_SETTINGS.cloudfront);
    for (const [kind, names] of Object.entries(FRONT_DOOR_SETTINGS)) {
      for (const n of names) assert.ok(all.has(n), `${kind}.${n}`);
    }
    assert.deepEqual(FRONT_DOOR_SETTINGS.none, []);
  });
});
