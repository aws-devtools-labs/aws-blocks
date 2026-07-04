// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Template } from 'aws-cdk-lib/assertions';
import {
  CloudFrontFrontDoor,
  mirrorHandlerEnvironmentToContainer,
  stageBackendImage,
} from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('stageBackendImage', () => {
  test('bundles the handler with the http-server entrypoint and writes a non-root Dockerfile', () => {
    const staging = stageBackendImage({
      backendHandlerPath: join(__dirname, '__fixtures__', 'handler.js'),
    });

    assert.ok(existsSync(join(staging, 'server.mjs')), 'server.mjs bundled');
    assert.ok(existsSync(join(staging, 'Dockerfile')), 'Dockerfile written');

    const dockerfile = readFileSync(join(staging, 'Dockerfile'), 'utf-8');
    assert.match(dockerfile, /FROM public\.ecr\.aws\/docker\/library\/node:22-slim/);
    assert.match(dockerfile, /USER node/);
    assert.match(dockerfile, /CMD \["node", "server\.mjs"\]/);

    // The bundle is self-contained: the fixture marker and the health path
    // (from @aws-blocks/core/http-server) are both inlined.
    const bundle = readFileSync(join(staging, 'server.mjs'), 'utf-8');
    assert.ok(bundle.includes('BLOCKS_FIXTURE_MARKER'), 'user handler inlined');
    // The health path is assembled from constants across modules, so assert
    // on http-server literals that survive bundling and minification instead.
    assert.ok(bundle.includes('SIGTERM'), 'http-server lifecycle inlined');
    assert.ok(bundle.includes('initializing'), 'http-server health gating inlined');
  });
});

describe('mirrorHandlerEnvironmentToContainer', () => {
  test('copies handler env into the container at synth, container vars win', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'MirrorStack');

    const handler = new lambda.Function(stack, 'Handler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
      environment: { FROM_LAMBDA: 'yes', SHARED_KEY: 'lambda-value' },
    });
    // Late addition, after construct wiring — the Aspect must still see it.
    handler.addEnvironment('LATE_ADDITION', 'late');

    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim'),
    });

    mirrorHandlerEnvironmentToContainer(handler, taskDefinition, {
      SHARED_KEY: 'container-value',
      ONLY_CONTAINER: 'yes',
    });

    const template = Template.fromStack(stack);
    const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    const env: Array<{ Name: string; Value: unknown }> =
      (taskDefs[0] as any).Properties.ContainerDefinitions[0].Environment;
    const byName = new Map(env.map((e) => [e.Name, e.Value]));

    assert.strictEqual(byName.get('FROM_LAMBDA'), 'yes');
    assert.strictEqual(byName.get('LATE_ADDITION'), 'late');
    assert.strictEqual(byName.get('ONLY_CONTAINER'), 'yes');
    assert.strictEqual(byName.get('SHARED_KEY'), 'container-value', 'container vars take precedence');
  });
});

describe('CloudFrontFrontDoor', () => {
  test('serves an API front door with caching disabled and HTTPS redirect', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'FrontDoorStack');

    const frontDoor = new CloudFrontFrontDoor(stack, 'FrontDoor', {
      origin: new origins.HttpOrigin('origin.example.com'),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          CachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
          ViewerProtocolPolicy: 'redirect-to-https',
        },
      },
    });

    assert.ok(frontDoor.apiUrl.endsWith('/aws-blocks/api'));
    assert.ok(frontDoor.publicOrigin.startsWith('https://'));
    assert.strictEqual(frontDoor.apiOrigin.originPath, '');
  });
});
