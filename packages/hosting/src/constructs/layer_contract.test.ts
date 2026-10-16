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
import { buildFrontDoor } from './custom_door.js';
import { buildDoorInput } from './door_input.js';
import { originHandleFromUrl } from './layer.js';
import { s3WebsiteDoor } from './s3_website_door.js';

const staticPlan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'b1' },
};

const staticDir = mkdtempSync(join(tmpdir(), 'layer-'));
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>x</title>');

const freshStack = (id: string) => new Stack(new App(), id, { env: { account: '111111111111', region: 'us-west-2' } });

describe('originHandleFromUrl — derives the attach point from a door url', () => {
  it('a literal url → its host and scheme', () => {
    assert.deepEqual(originHandleFromUrl('https://d123.cloudfront.net/app'), {
      domainName: 'd123.cloudfront.net',
      protocol: 'https',
    });
    assert.deepEqual(originHandleFromUrl('http://site.s3-website-us-west-2.amazonaws.com'), {
      domainName: 'site.s3-website-us-west-2.amazonaws.com',
      protocol: 'http',
    });
  });

  it('a token url → the host is sliced in-template (Fn::Select/Fn::Split), the scheme from the literal prefix', () => {
    const stack = freshStack('Tok');
    const bucket = new Bucket(stack, 'B');
    const handle = originHandleFromUrl(`https://${bucket.bucketRegionalDomainName}/x`);
    assert.equal(handle.protocol, 'https');
    const resolved = stack.resolve(handle.domainName);
    assert.ok(resolved['Fn::Select'], `expected an in-template Fn::Select, got ${JSON.stringify(resolved)}`);
    assert.equal(resolved['Fn::Select'][0], 2);
    assert.ok(resolved['Fn::Select'][1]['Fn::Split'], 'split on "/"');
  });
});

describe('built-in doors — the result carries an attachable originHandle', () => {
  it('s3-website: origin handle is the website host, protocol http', () => {
    const stack = freshStack('S1');
    const input = buildDoorInput(stack, { plan: staticPlan, bucket: new Bucket(stack, 'Assets'), staticDir });
    const { result } = buildFrontDoor(stack, s3WebsiteDoor, { ...input, plan: staticPlan }, { wiringCheck: false });
    assert.ok(result.url, 'has a public url');
    assert.equal(result.originHandle.protocol, 'http');
    assert.ok(result.originHandle.domainName, 'has a domainName an outer door can attach to');
    assert.ok(result.publicBucket, 'exposes the public website bucket');
  });

  it('api-gateway: origin handle protocol https', () => {
    const stack = freshStack('S2');
    const bucket = new Bucket(stack, 'Assets');
    const input = buildDoorInput(stack, { plan: staticPlan, bucket, staticDir });
    const { result } = buildFrontDoor(
      stack,
      apiGatewayDoor,
      { ...input, apiGateway: { plan: staticPlan, bucket } },
      { wiringCheck: false },
    );
    assert.ok(result.url);
    assert.equal(result.originHandle.protocol, 'https');
  });

  it('alb: origin handle is the LB DNS; protocol reflects the certificate (http without one)', () => {
    const stack = freshStack('S3');
    const bucket = new Bucket(stack, 'Assets');
    const input = buildDoorInput(stack, { plan: staticPlan, bucket, staticDir });
    const { result } = buildFrontDoor(stack, albDoor, { ...input, alb: { plan: staticPlan, bucket } }, { wiringCheck: false });
    assert.ok(result.url);
    assert.equal(result.originHandle.protocol, 'http'); // no certificate → HTTP listener
    assert.ok(result.originHandle.domainName);
  });
});
