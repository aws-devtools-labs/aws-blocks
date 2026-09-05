import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CapabilityId } from '../plan/types.js';
import { CloudFrontAdapter } from './cloudfront_adapter.js';

const ALL_CAPABILITIES: CapabilityId[] = [
  'RouteRequest',
  'ServeStaticAsset',
  'RunServerRender',
  'StreamServerRender',
  'ProxySameOriginApi',
  'CustomDomainTls',
  'InjectResponseHeaders',
  'FilterRequests',
  'CacheResponses',
  'AtomicRelease',
  'PinSession',
  'OptimizeImage',
  'RestrictGeo',
];

describe('CloudFrontAdapter — capability matrix', () => {
  const adapter = new CloudFrontAdapter();

  it('identifies as the cloudfront service', () => {
    assert.equal(adapter.service, 'cloudfront');
  });

  it('supports every capability at the core tier (full-feature default door)', () => {
    for (const cap of ALL_CAPABILITIES) {
      assert.equal(adapter.supports(cap), 'core', `expected ${cap} to be core`);
    }
  });
});
