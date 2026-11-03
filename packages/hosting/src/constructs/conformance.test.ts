import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { cf } from './cf_helpers.js';
import { assertDoorConformance } from './conformance.js';
import { defineFrontDoor, type FrontDoor, type FrontDoorResult } from './front_door.js';

/** A conforming door: serves the assets and proxies the API with the helpers. */
const goodDoor = defineFrontDoor({
  service: 'good-cdn',
  build(scope, { app, origins }) {
    const dist = new Distribution(scope, 'Cdn', {
      defaultBehavior: { origin: cf.origin(origins.server ?? origins.assets) },
      additionalBehaviors: { ...cf.behaviors(app.routes), ...cf.apiBehaviors(origins.api) },
    });
    return { url: `https://${dist.distributionDomainName}` };
  },
});

describe('assertDoorConformance', () => {
  it('passes a door that returns a url and wires the assets + API', () => {
    const { result, wiring } = assertDoorConformance(goodDoor);
    assert.ok(result.url);
    assert.ok(result.originHandle.domainName, 'originHandle derived from url');
    assert.ok(wiring.origins.has('assets'));
    assert.ok(wiring.apiPaths.has('/aws-blocks/*'));
  });

  it('fails a door with no service id / no build function (shape)', () => {
    const broken = { service: '' } as unknown as FrontDoor;
    assert.throws(() => assertDoorConformance(broken), (err: Error) => err.name === 'InvalidPropsError');
  });

  it('fails a door that returns no url', () => {
    const noUrl = defineFrontDoor({ service: 'no-url', build: () => ({}) as FrontDoorResult });
    assert.throws(() => assertDoorConformance(noUrl), (err: Error) => err.name === 'MissingFrontDoorUrlError');
  });

  it('fails a door that serves the assets but does not proxy the API (wiring)', () => {
    const noApi = defineFrontDoor({
      service: 'no-api',
      build(scope, { origins }) {
        const dist = new Distribution(scope, 'Cdn', { defaultBehavior: { origin: cf.origin(origins.assets) } });
        return { url: `https://${dist.distributionDomainName}` };
      },
    });
    assert.throws(() => assertDoorConformance(noApi), /ProxySameOriginApi/);
    assert.doesNotThrow(() => assertDoorConformance(noApi, { wiringCheck: false }));
  });
});
