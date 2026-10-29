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
import type {
  AlbDoorFeatures,
  ApiGatewayDoorFeatures,
  CloudFrontDoorFeatures,
  CustomDoorFeatures,
  FRONT_DOOR_SETTINGS,
  HostingFrontDoor,
  StackedDoorFeatures,
} from './front_door_options.js';
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
  { kind: 'alb', features: { domain } },
  { features: { geoRestriction: { type: 'allowlist', countries: ['US'] } } },
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
  // @ts-expect-error — the ALB has no www redirect.
  { kind: 'alb', features: { domain: { ...domain, wwwRedirect: 'toApex' } } },
  // @ts-expect-error — the backend API is an L3 prop (`backendApi`), not a door option.
  { kind: 'alb', backendApiUrl: 'https://x.example.com/prod/aws-blocks/api' },
  // @ts-expect-error — locking the ALB to CloudFront is the stacked door's router only.
  { kind: 'alb', restrictToCloudFront: true },
  // @ts-expect-error — no backend paths on a door either.
  { kind: 'custom', door, backendApiPaths: ['/hooks/*'] },
  // @ts-expect-error — the stacked door's router is not part of the public union.
  { kind: 'stackedRouter' },
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
  // @ts-expect-error — the router's domain has no www redirect.
  { router: { domain: { ...domain, wwwRedirect: 'toApex' } } },
];
// @ts-expect-error — 'none' takes no settings: there is no object form.
const noneWithFeatures: HostingFrontDoor = { kind: 'none', features: {} };

// ── FRONT_DOOR_SETTINGS lists every setting of each kind's `features` type ──
// (`satisfies` on the constant rejects a name the type lacks; these reject a
// name the type has but the list misses.)
type Settings = typeof FRONT_DOOR_SETTINGS;
type ListsAll<TFeatures, K extends keyof Settings> = [Exclude<keyof TFeatures, Settings[K][number]>] extends [never]
  ? true
  : false;
const exhaustive: [
  ListsAll<CloudFrontDoorFeatures, 'cloudfront'>,
  ListsAll<AlbDoorFeatures, 'alb'>,
  ListsAll<ApiGatewayDoorFeatures, 'apiGateway'>,
  ListsAll<CustomDoorFeatures, 'custom'>,
] = [true, true, true, true];

describe('frontDoor.features — compile-time contract', () => {
  it('compiles the positive cases and rejects the negative ones (checked by tsc)', () => {
    assert.equal(positives.length, 10);
    assert.ok(stackedPositive.edge && stackedPositive.router);
    assert.ok(released.cdn);
    assert.equal(negatives.length, 18);
    assert.equal(stackedNegatives.length, 4);
    assert.ok(noneWithFeatures);
    assert.ok(exhaustive);
  });
});
