/**
 * Completeness guard for the capability model — demand-anchored, NOT
 * CloudFront-anchored. It enforces the two properties that stopped features
 * (like access logging) from silently slipping past the negotiator:
 *
 *  1. No DEAD capability — every `CapabilityId` is REACHABLE as required by some
 *     app demand. A capability that can never be required would silently drop on
 *     a door switch (the bug class). (The compiler already forces every
 *     capability into `CAPABILITY_DEMAND` and every adapter matrix; this adds the
 *     runtime reachability + direction checks the types can't express.)
 *  2. Demand-gated, both directions — a capability is required IFF the app
 *     demands it. No demand ⇒ not required ⇒ never fails a door that lacks it
 *     (missing ≠ degraded); demand present ⇒ required ⇒ a lacking door fails
 *     loudly instead of silently.
 *
 * Perf/optional CloudFront tuning is consciously excluded via `CF_ONLY_FEATURES`
 * (asserted disjoint from the capability set) so it can never fail a build.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAPABILITY_DEMAND, CF_ONLY_FEATURES, requiredCapabilities } from './negotiate.js';
import type { CapabilityId, CapabilityPlan } from './types.js';

const ALL_CAPS = Object.keys(CAPABILITY_DEMAND) as CapabilityId[];

/** A plan that demands NOTHING beyond the always-on basics. */
const minimalPlan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'b1' },
};

/** A plan that demands EVERY capability at once. */
const maximalPlan: CapabilityPlan = {
  origins: [
    { id: 'blocks-s3', kind: 'static' },
    { id: 'blocks-server', kind: 'server' },
    { id: 'blocks-image', kind: 'image' },
  ],
  routes: { entries: [], redirects: [{ source: '/a', destination: '/b', statusCode: 301 }], headers: [{ pattern: '/*', headers: { X: '1' } }] },
  policies: {
    spaFallback: false,
    hasServer: true,
    skewEnabled: true,
    customDomain: true,
    wafEnabled: true,
    loggingEnabled: true,
    hasCustomErrorPages: true,
    hasRedirects: true,
    needsStreaming: true,
    geoRestricted: true,
    monitoringEnabled: true,
    edgeCacheRequired: true,
  },
  release: { buildId: 'b1' },
  backend: {
    origins: [{ namespace: 'notes', ingress: { kind: 'url', url: 'https://x/aws-blocks/api' } }],
    needsLongRequests: true,
    needsLargePayloads: true,
  },
};

describe('capability model — completeness (demand-anchored)', () => {
  it('no dead capability: EVERY capability is reachable as required by some demand', () => {
    const required = requiredCapabilities(maximalPlan);
    const unreachable = ALL_CAPS.filter((c) => !required.has(c));
    assert.deepEqual(unreachable, [], `these capabilities can never be required (would silently drop): ${unreachable.join(', ')}`);
    assert.equal(required.size, ALL_CAPS.length);
  });

  it('demand-gated: a no-demand plan requires ONLY the always-on basics', () => {
    const required = requiredCapabilities(minimalPlan);
    assert.deepEqual([...required].sort(), ['RouteRequest', 'ServeStaticAsset']);
  });

  it('each demand signal toggles exactly its capability (both directions)', () => {
    const cases: Array<[CapabilityId, (p: CapabilityPlan) => CapabilityPlan]> = [
      ['CustomDomainTls', (p) => ({ ...p, policies: { ...p.policies, customDomain: true } })],
      ['FilterRequests', (p) => ({ ...p, policies: { ...p.policies, wafEnabled: true } })],
      ['AccessLogging', (p) => ({ ...p, policies: { ...p.policies, loggingEnabled: true } })],
      ['ServeErrorPage', (p) => ({ ...p, policies: { ...p.policies, hasCustomErrorPages: true } })],
      ['Redirect', (p) => ({ ...p, policies: { ...p.policies, hasRedirects: true } })],
      ['Alarms', (p) => ({ ...p, policies: { ...p.policies, monitoringEnabled: true } })],
      ['RestrictGeo', (p) => ({ ...p, policies: { ...p.policies, geoRestricted: true } })],
    ];
    for (const [cap, addDemand] of cases) {
      assert.ok(!requiredCapabilities(minimalPlan).has(cap), `${cap} must NOT be required without its demand`);
      assert.ok(requiredCapabilities(addDemand(minimalPlan)).has(cap), `${cap} must be required once demanded`);
    }
  });

  it('perf-only CloudFront tuning is consciously excluded, not a capability', () => {
    for (const f of CF_ONLY_FEATURES) {
      assert.ok(!ALL_CAPS.includes(f as CapabilityId), `${f} must not be a CapabilityId (never fails a build)`);
    }
  });
});
