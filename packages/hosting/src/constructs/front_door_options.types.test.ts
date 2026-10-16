/**
 * Compile-time contract of `frontDoor.features`: each door kind accepts exactly
 * the settings its door implements. This file is typechecked by the package
 * build (`tsc --build`), so a `@ts-expect-error` that stops erroring — a kind
 * that starts accepting a setting it doesn't implement — fails the build.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Duration } from 'aws-cdk-lib';
import { PriceClass } from 'aws-cdk-lib/aws-cloudfront';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { defineFrontDoor } from './front_door.js';
import type { HostingFrontDoor, StackedDoorFeatures } from './front_door_options.js';
import type { HostingConstructProps } from './hosting_construct.js';

const door = defineFrontDoor({ service: 'x', build: () => ({ url: 'https://x.example.com' }) });
const domain = { domainName: 'app.example.com', hostedZone: 'example.com' };

// ── positive cases ──
const positives: HostingFrontDoor[] = [
  'cloudfront',
  'none',
  { features: { waf: { enabled: true }, priceClass: PriceClass.PRICE_CLASS_ALL, domain } },
  {
    kind: 'cloudfront',
    features: {
      logging: { enabled: true, retentionDays: 7 },
      monitoring: { subscriptions: [new EmailSubscription('ops@example.com')] },
      skewProtection: { enabled: false },
      contentSecurityPolicy: "default-src 'self'",
      geoRestriction: { type: 'whitelist', countries: ['US'] },
      ssrDefaultTtl: Duration.seconds(5),
      cacheKeyCookies: ['sid'],
      cacheKeyHeaders: ['authorization'],
      quotas: { cacheBehaviors: 50 },
    },
  },
  { kind: 'alb', internal: true, features: { waf: { enabled: true }, logging: { enabled: true }, monitoring: { enabled: true } } },
  { kind: 'apiGateway', api: 'rest', features: { domain } },
  { kind: 'apiGateway', api: 'http', features: { domain: { domainName: ['a.example.com', 'b.example.com'] } } },
  {
    kind: 'custom',
    door,
    features: {
      domain: { ...domain, wwwRedirect: 'toApex' },
      waf: { enabled: true },
      logging: { enabled: true },
      monitoring: { enabled: true },
      geoRestriction: { type: 'blacklist', countries: ['KP'] },
      skewProtection: { enabled: true, maxAge: 60 },
    },
  },
];
const stackedPositive: StackedDoorFeatures = {
  edge: { waf: { webAclArn: 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/e/1' }, contentSecurityPolicy: "default-src 'self'" },
  router: { waf: { enabled: true }, logging: { enabled: true }, monitoring: { enabled: true } },
};
// The released top-level props still compile (deprecated aliases).
const released: Partial<HostingConstructProps> = {
  domain,
  waf: { enabled: true },
  logging: { enabled: true },
  monitoring: { enabled: false },
  skewProtection: { enabled: true },
  cdn: { priceClass: PriceClass.PRICE_CLASS_100, geoRestriction: { type: 'whitelist', countries: ['US'] } },
};

// ── negative cases: a setting the kind doesn't implement is a type error ──
const negatives: HostingFrontDoor[] = [
  // @ts-expect-error — the ALB has no geo restriction.
  { kind: 'alb', features: { geoRestriction: { type: 'whitelist', countries: ['US'] } } },
  // @ts-expect-error — the ALB has no custom-domain records (use its `certificate`).
  { kind: 'alb', features: { domain } },
  // @ts-expect-error — the ALB has no price class.
  { kind: 'alb', features: { priceClass: PriceClass.PRICE_CLASS_ALL } },
  // @ts-expect-error — the ALB has no skew protection.
  { kind: 'alb', features: { skewProtection: { enabled: true } } },
  // @ts-expect-error — the ALB has no CSP header.
  { kind: 'alb', features: { contentSecurityPolicy: "default-src 'self'" } },
  // @ts-expect-error — the ALB's alarms take no subscriptions.
  { kind: 'alb', features: { monitoring: { subscriptions: [new EmailSubscription('ops@example.com')] } } },
  // @ts-expect-error — the HTTP API has no WAF.
  { kind: 'apiGateway', api: 'http', features: { waf: { enabled: true } } },
  // @ts-expect-error — the REST API has no WAF either.
  { kind: 'apiGateway', api: 'rest', features: { waf: { enabled: true } } },
  // @ts-expect-error — API Gateway has no access logs.
  { kind: 'apiGateway', features: { logging: { enabled: true } } },
  // @ts-expect-error — API Gateway has no alarms.
  { kind: 'apiGateway', features: { monitoring: { enabled: true } } },
  // @ts-expect-error — API Gateway has no www redirect.
  { kind: 'apiGateway', features: { domain: { ...domain, wwwRedirect: 'toApex' } } },
  // @ts-expect-error — a BYO door is not handed a price class.
  { kind: 'custom', door, features: { priceClass: PriceClass.PRICE_CLASS_ALL } },
  // @ts-expect-error — a BYO door is not handed SSR cache settings.
  { kind: 'custom', door, features: { ssrDefaultTtl: Duration.seconds(5) } },
  // @ts-expect-error — the default door has no `vpc` setting.
  { features: { vpc: undefined, waf: { enabled: true } } },
];
const stackedNegatives: StackedDoorFeatures[] = [
  // @ts-expect-error — the edge builds no web ACL; it takes yours (`webAclArn`).
  { edge: { waf: { enabled: true } } },
  // @ts-expect-error — the edge has no access logs.
  { edge: { logging: { enabled: true } } },
  // @ts-expect-error — the router has no CSP header.
  { router: { contentSecurityPolicy: "default-src 'self'" } },
];
// @ts-expect-error — 'none' takes no settings: there is no object form.
const noneWithFeatures: HostingFrontDoor = { kind: 'none', features: {} };

describe('frontDoor.features — compile-time contract', () => {
  it('compiles the positive cases and rejects the negative ones (checked by tsc)', () => {
    assert.equal(positives.length, 8);
    assert.ok(stackedPositive.edge && stackedPositive.router);
    assert.ok(released.cdn);
    assert.equal(negatives.length, 14);
    assert.equal(stackedNegatives.length, 3);
    assert.ok(noneWithFeatures);
  });
});
