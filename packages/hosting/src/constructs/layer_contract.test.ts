import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { CapabilityPlan } from '../plan/types.js';
import { albDoor } from './alb_door.js';
import { apiGatewayDoor } from './apigw_door.js';
import { runFrontDoor } from './door_hooks.js';
import { s3WebsiteDoor } from './s3_website_door.js';

const staticPlan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'b1' },
};

const staticDir = mkdtempSync(join(tmpdir(), 'layer-'));
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>x</title>');

const freshStack = (id: string) => {
  const app = new App();
  const stack = new Stack(app, id, { env: { account: '111111111111', region: 'us-west-2' } });
  return stack;
};

describe('layer contract — handle() returns an attachable originHandle', () => {
  it('s3-website: origin handle is the website host, protocol http', () => {
    const stack = freshStack('S1');
    const { handle: h } = runFrontDoor(stack, staticPlan, s3WebsiteDoor, { staticDir });
    assert.ok(h.url, 'root layer has a public url');
    assert.equal(h.originHandle.protocol, 'http');
    assert.ok(h.originHandle.domainName, 'has a domainName a parent can attach to');
    assert.ok(h.publicBucket, 'exposes the public website bucket');
  });

  it('api-gateway: origin handle protocol https', () => {
    const stack = freshStack('S2');
    const bucket = new Bucket(stack, 'Assets');
    const { handle: h } = runFrontDoor(stack, staticPlan, apiGatewayDoor, { bucket });
    assert.ok(h.url);
    assert.equal(h.originHandle.protocol, 'https');
  });

  it('alb: origin handle is the LB DNS; protocol reflects the certificate (http without one)', () => {
    const stack = freshStack('S3');
    const bucket = new Bucket(stack, 'Assets');
    const { handle: h } = runFrontDoor(stack, staticPlan, albDoor, { bucket });
    assert.ok(h.url);
    assert.equal(h.originHandle.protocol, 'http'); // no certificate → HTTP listener
    assert.ok(h.originHandle.domainName);
  });
});
