import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { CapabilityPlan } from '../plan/types.js';
import { AlbConstruct } from './alb_construct.js';
import { cloudFrontEdgeDoor } from './cloudfront_edge_door.js';
import { buildFrontDoor } from './custom_door.js';
import { buildDoorInput } from './door_input.js';

const plan: CapabilityPlan = {
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [{ pattern: '/assets/*', kind: 'static' }], redirects: [], headers: [] },
  policies: { spaFallback: true, hasServer: false, skewEnabled: false },
  release: { buildId: 'testbuild' },
};

/** The composable path: an `AlbConstruct` locked to CloudFront, fronted by `cloudFrontEdgeDoor`. */
const compose = (id: string, opts: { internal: boolean; https: boolean }) => {
  const stack = new Stack(new App(), id, { env: { account: '111111111111', region: 'us-west-2' } });
  const bucket = new Bucket(stack, 'Assets');
  const vpc = new Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 });
  const certificate = opts.https
    ? Certificate.fromCertificateArn(stack, 'Cert', 'arn:aws:acm:us-west-2:111111111111:certificate/test')
    : undefined;
  const alb = new AlbConstruct(stack, 'Router', {
    plan,
    bucket,
    vpc,
    internal: opts.internal,
    certificate,
    restrictToCloudFront: true,
  });
  // The API is dynamic, so the edge sends it to the router.
  const input = buildDoorInput({
    plan,
    bucket,
    staticDir: '.',
    api: { url: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' },
  });
  buildFrontDoor(
    stack,
    cloudFrontEdgeDoor,
    { ...input, upstream: { service: 'alb', url: alb.url, originHandle: alb.originHandle } },
    { wiringCheck: false },
  );
  return Template.fromStack(stack);
};

const listenerPort = (t: Template) => {
  const listeners = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::Listener'));
  assert.equal(listeners.length, 1);
  return listeners[0].Properties.Port as number;
};

describe('cloudFrontEdgeDoor — edge → router hop follows the router listener', () => {
  for (const https of [false, true]) {
    const scheme = https ? 'HTTPS :443' : 'HTTP :80';

    it(`internal router on ${scheme}: the VPC origin and its ingress use the listener's protocol and port`, () => {
      const t = compose(`Internal${https ? 'Https' : 'Http'}`, { internal: true, https });
      const port = listenerPort(t);
      assert.equal(port, https ? 443 : 80);

      const vpcOrigins = Object.values(t.findResources('AWS::CloudFront::VpcOrigin'));
      assert.equal(vpcOrigins.length, 1);
      const endpoint = vpcOrigins[0].Properties.VpcOriginEndpointConfig;
      assert.equal(endpoint.OriginProtocolPolicy, https ? 'https-only' : 'http-only');
      assert.equal((https ? endpoint.HTTPSPort : endpoint.HTTPPort) ?? (https ? 443 : 80), port);

      const ingress = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).filter(
        (r) => r.Properties.Description === 'CloudFront VPC origin only',
      );
      assert.ok(ingress.length > 0, 'the VPC origin is admitted');
      for (const rule of ingress) {
        assert.equal(rule.Properties.FromPort, port);
        assert.equal(rule.Properties.ToPort, port);
      }
    });

    it(`public router on ${scheme}: the custom origin uses the listener's protocol`, () => {
      const t = compose(`Public${https ? 'Https' : 'Http'}`, { internal: false, https });
      listenerPort(t);
      const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
      const origins = dist.Properties.DistributionConfig.Origins as Array<{
        CustomOriginConfig?: { OriginProtocolPolicy: string };
      }>;
      const router = origins.find((o) => o.CustomOriginConfig);
      assert.ok(router, 'the public ALB is a custom origin');
      assert.equal(router.CustomOriginConfig?.OriginProtocolPolicy, https ? 'https-only' : 'http-only');
    });
  }
});
