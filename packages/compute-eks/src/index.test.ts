// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BlocksStack } from '@aws-blocks/core/cdk';
import { EksCompute } from './index.js';

// Simulate the CDK condition being active (tests import CDK files directly)
before(() => {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const backendPath = join(__dirname, '__fixtures__', 'backend.js');

// BYO image URI so unit tests never need Docker.
const TEST_IMAGE = 'public.ecr.aws/docker/library/node:22-slim';

let cached: { stack: any; template: Template; compute: EksCompute } | undefined;

/** Synth once and share — an EKS synth (kubectl provider nested stacks) is expensive. */
async function synthOnce() {
  if (cached) return cached;
  const app = new cdk.App();
  const compute = new EksCompute({ imageUri: TEST_IMAGE });
  const stack = await BlocksStack.create(app, 'EksStack', {
    backendHandlerPath: handlerPath,
    backendCDKPath: backendPath,
    compute,
  });
  cached = { stack, template: Template.fromStack(stack), compute };
  return cached;
}

/** All KubernetesManifest custom resources, JSON-stringified for content checks. */
function manifestText(template: Template): string {
  const resources = template.findResources('Custom::AWSCDK-EKS-KubernetesResource');
  return JSON.stringify(Object.values(resources));
}

describe('EksCompute — synth shape', () => {
  test('provisions the EKS cluster and no API Gateway', async () => {
    const { template } = await synthOnce();

    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    template.resourceCountIs('Custom::AWSCDK-EKS-Cluster', 1);
    template.resourceCountIs('AWS::EKS::PodIdentityAssociation', 1);
  });

  test('Auto Mode settings are applied to the cluster resource', async () => {
    const { template } = await synthOnce();

    // The stable L2 renders the cluster through a custom resource whose Config
    // carries the CfnCluster properties, including our overrides.
    const clusterJson = JSON.stringify(
      Object.values(template.findResources('Custom::AWSCDK-EKS-Cluster')),
    );
    assert.ok(clusterJson.includes('general-purpose'), 'Auto Mode node pools configured');
    assert.ok(clusterJson.includes('bootstrapSelfManagedAddons') || clusterJson.includes('BootstrapSelfManagedAddons'),
      'self-managed addons bootstrap disabled for Auto Mode');
  });

  test('Pod Identity association maps the service account to the shared role', async () => {
    const { template } = await synthOnce();

    const sharedRoleIds = Object.entries(template.findResources('AWS::IAM::Role'))
      .filter(([, role]) =>
        String((role as any).Properties?.Description ?? '').includes('Shared execution role'))
      .map(([logicalId]) => logicalId);
    assert.strictEqual(sharedRoleIds.length, 1);

    template.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
      Namespace: 'aws-blocks',
      ServiceAccount: 'blocks-backend',
      RoleArn: { 'Fn::GetAtt': [sharedRoleIds[0], 'Arn'] },
    });

    // The shared role trusts pods.eks.amazonaws.com with sts:TagSession.
    const trust = (template.findResources('AWS::IAM::Role')[sharedRoleIds[0]] as any)
      .Properties.AssumeRolePolicyDocument.Statement;
    const eksStatement = trust.find((s: any) =>
      [s.Principal?.Service].flat().includes('pods.eks.amazonaws.com'));
    assert.ok(eksStatement, 'pods.eks.amazonaws.com trusted');
    assert.ok([eksStatement.Action].flat().includes('sts:TagSession'));
  });

  test('manifests carry namespace, ingress class, deployment, service, and gated ingress', async () => {
    const { template } = await synthOnce();
    const text = manifestText(template);

    // The manifest JSON is escaped inside the template string, so match on
    // distinctive escape-free substrings.
    for (const marker of [
      'Namespace',
      'ServiceAccount',
      'IngressClassParams',
      'IngressClass',
      'Deployment',
      'Ingress',
      'eks.amazonaws.com/alb',
      TEST_IMAGE,
      '/aws-blocks/health',
      'X-Origin-Verify',
      'topology.kubernetes.io/zone',
    ]) {
      assert.ok(text.includes(marker), `manifest contains ${marker}`);
    }
  });

  test('pod env mirrors the handler env and container-specific vars', async () => {
    const { template } = await synthOnce();
    const text = manifestText(template);

    for (const marker of [
      'BLOCKS_STACK_NAME',
      'NODE_ENV',
      'BLOCKS_CONFIG_BUCKET',
      'PORT',
      'BLOCKS_COMPUTE',
      'BLOCKS_PUBLIC_ORIGIN',
      'BLOCKS_HTTP_TIMEOUT_MS',
    ]) {
      assert.ok(text.includes(marker), `pod env contains ${marker}`);
    }
  });

  test('CloudFront front door sends the origin-verify header to the ingress ALB', async () => {
    const { stack, template } = await synthOnce();

    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const origin = dist.Properties.DistributionConfig.Origins[0];
    const headers = origin.OriginCustomHeaders ?? [];
    assert.ok(
      headers.some((h: any) => h.HeaderName === 'X-Origin-Verify'),
      'origin-verify custom header set',
    );

    assert.ok(stack.apiUrl.endsWith('/aws-blocks/api'));
    assert.ok(stack.apiOrigin);
    assert.throws(() => stack.gateway, /container compute target/);
  });

  test('manifest waits for the config deployment and pod identity', async () => {
    const { template, compute } = await synthOnce();

    const deployments = Object.keys(template.findResources('Custom::CDKBucketDeployment'));
    assert.strictEqual(deployments.length, 1, 'config bucket deployment exists');

    const dependencyIds = compute.manifest.node.dependencies.map((d) => d.node.id);
    assert.ok(
      dependencyIds.includes('BlocksConfigDeployment'),
      `manifest depends on the config deployment, got: ${JSON.stringify(dependencyIds)}`,
    );
    assert.ok(
      dependencyIds.includes('PodIdentity'),
      'manifest depends on the pod identity association',
    );
  });
});

describe('EksCompute — validation', () => {
  test('domainName without certificate throws at construction', () => {
    assert.throws(
      () => new EksCompute({ domainName: 'api.example.com' }),
      /requires `certificate`/,
    );
  });
});
