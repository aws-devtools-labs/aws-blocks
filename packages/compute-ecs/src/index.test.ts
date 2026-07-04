// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BlocksStack } from '@aws-blocks/core/cdk';
import { EcsFargateCompute } from './index.js';

// Simulate the CDK condition being active (tests import CDK files directly)
before(() => {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const backendPath = join(__dirname, '__fixtures__', 'backend.js');

// BYO image so unit tests need neither Docker nor a network registry pull at
// deploy time (assets are only staged, never pulled, during synth).
const testImage = () => ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim');

async function synthWith(compute: EcsFargateCompute, id: string, context?: Record<string, unknown>) {
  const app = new cdk.App({ context });
  const stack = await BlocksStack.create(app, id, {
    backendHandlerPath: handlerPath,
    backendCDKPath: backendPath,
    compute,
  });
  return { stack, template: Template.fromStack(stack), compute };
}

describe('EcsFargateCompute — synth shape', () => {
  test('provisions the full container stack and no API Gateway', async () => {
    const { template } = await synthWith(new EcsFargateCompute({ image: testImage() }), 'EcsShape');

    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);

    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
      }),
    });

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/aws-blocks/health',
      HealthCheckIntervalSeconds: 15,
    });
  });

  test('task role IS the shared execution role the Lambda uses', async () => {
    const { template } = await synthWith(new EcsFargateCompute({ image: testImage() }), 'EcsRole');

    const sharedRoleIds = Object.entries(template.findResources('AWS::IAM::Role'))
      .filter(([, role]) =>
        String((role as any).Properties?.Description ?? '').includes('Shared execution role'))
      .map(([logicalId]) => logicalId);
    assert.strictEqual(sharedRoleIds.length, 1);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      TaskRoleArn: { 'Fn::GetAtt': [sharedRoleIds[0], 'Arn'] },
    });

    const fns = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (fn: any) => fn.Properties?.Environment?.Variables?.BLOCKS_STACK_NAME,
    );
    assert.deepStrictEqual((fns[0] as any).Properties.Role, {
      'Fn::GetAtt': [sharedRoleIds[0], 'Arn'],
    });
  });

  test('mirrors the handler environment into the container (incl. config bucket)', async () => {
    const { template } = await synthWith(new EcsFargateCompute({ image: testImage() }), 'EcsEnv');

    const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    assert.strictEqual(taskDefs.length, 1);
    const env: Array<{ Name: string; Value: unknown }> =
      (taskDefs[0] as any).Properties.ContainerDefinitions[0].Environment;
    const byName = new Map(env.map((e) => [e.Name, e.Value]));

    // Mirrored from the Lambda:
    assert.strictEqual(byName.get('BLOCKS_STACK_NAME'), 'EcsEnv');
    assert.strictEqual(byName.get('NODE_ENV'), 'production');
    assert.ok(byName.has('BLOCKS_CONFIG_BUCKET'), 'config bucket ref mirrored');
    assert.ok(byName.has('BLOCKS_CONFIG_KEY'), 'config key mirrored');
    // Container-specific:
    assert.strictEqual(byName.get('PORT'), '8080');
    assert.strictEqual(byName.get('BLOCKS_COMPUTE'), 'ecs');
    assert.strictEqual(byName.get('BLOCKS_HTTP_TIMEOUT_MS'), '55000');
    assert.ok(byName.has('BLOCKS_PUBLIC_ORIGIN'), 'public origin injected');
  });

  test('service waits for the config deployment before starting tasks', async () => {
    const { stack, template } = await synthWith(
      new EcsFargateCompute({ image: testImage() }),
      'EcsDeps',
    );

    const deployments = Object.keys(template.findResources('Custom::CDKBucketDeployment'));
    assert.strictEqual(deployments.length, 1, 'config bucket deployment exists');

    const service = Object.values(
      Template.fromStack(stack).findResources('AWS::ECS::Service'),
    )[0] as any;
    assert.ok(
      (service.DependsOn ?? []).includes(deployments[0]),
      `service must depend on ${deployments[0]}, got: ${JSON.stringify(service.DependsOn)}`,
    );
  });

  test('apiUrl and apiOrigin point at the CloudFront front door', async () => {
    const { stack } = await synthWith(new EcsFargateCompute({ image: testImage() }), 'EcsUrl');

    assert.ok(stack.apiUrl.endsWith('/aws-blocks/api'));
    assert.ok(stack.apiOrigin, 'structured apiOrigin set');
    assert.strictEqual(stack.apiOrigin?.originPath, '');
    assert.throws(() => stack.gateway, /container compute target/);
  });
});

describe('EcsFargateCompute — networking modes', () => {
  test('private mode (default outside sandbox): NAT gateway, no public task IPs', async () => {
    const { template } = await synthWith(new EcsFargateCompute({ image: testImage() }), 'EcsPriv');

    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }),
      }),
    });
  });

  test('sandbox context defaults to public mode: no NAT, public task IPs', async () => {
    const { template } = await synthWith(
      new EcsFargateCompute({ image: testImage() }),
      'EcsSand',
      { sandboxMode: 'true' },
    );

    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }),
      }),
    });
  });

  test('explicit networkMode wins over sandbox default', async () => {
    const { template } = await synthWith(
      new EcsFargateCompute({ image: testImage(), networkMode: 'private' }),
      'EcsSandPriv',
      { sandboxMode: 'true' },
    );
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });
});

describe('EcsFargateCompute — validation', () => {
  test('domainName without certificate throws at construction', () => {
    assert.throws(
      () => new EcsFargateCompute({ domainName: 'api.example.com' }),
      /requires `certificate`/,
    );
  });
});
