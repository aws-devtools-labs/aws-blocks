// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlocksBackend } from './blocks-backend.js';
import { BlocksStack } from './index.js';
import { getConfigDeployment } from './config-registry.js';
import type { ComputeBindContext, ComputeBindResult, ComputeTarget } from './compute-target.js';

// Simulate the CDK condition being active (tests import CDK files directly)
before(() => {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const sideEffectBackendPath = join(__dirname, '__fixtures__', 'side-effect-backend.js');

/** Minimal recording compute target for exercising the seam. */
class FakeCompute implements ComputeTarget {
  readonly requiredPrincipals: ComputeTarget['requiredPrincipals'];
  bindCtx?: ComputeBindContext;
  finalizeCtx?: ComputeBindContext;
  finalizeObservations: { configDeployment: boolean; sideEffectMarker: boolean } = {
    configDeployment: false,
    sideEffectMarker: false,
  };

  constructor(principals: ComputeTarget['requiredPrincipals'] = ['ecs-tasks.amazonaws.com']) {
    this.requiredPrincipals = principals;
  }

  bind(ctx: ComputeBindContext): ComputeBindResult {
    this.bindCtx = ctx;
    return {
      apiUrl: 'https://d111111abcdef8.cloudfront.net/aws-blocks/api',
      apiOrigin: { hostname: 'd111111abcdef8.cloudfront.net', originPath: '' },
    };
  }

  finalize(ctx: ComputeBindContext): void {
    this.finalizeCtx = ctx;
    this.finalizeObservations = {
      // finalizeConfigRegistry must have run: the config deployment exists.
      configDeployment: getConfigDeployment(ctx.scope) !== undefined,
      // The app's backendCDKPath module must have been imported already.
      sideEffectMarker: ctx.scope.node.tryFindChild('SideEffectMarker') !== undefined,
    };
  }
}

describe('default mode (no compute target) — template stability', () => {
  test('synthesizes the exact Lambda + API Gateway shape with no shared role', async () => {
    const app = new cdk.App();

    const stack = await BlocksStack.create(app, 'DefaultModeStack', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const template = Template.fromStack(stack);

    // Front door unchanged: one REST API with the RPC route tree.
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);

    // The shared execution role must NOT exist — creating it unconditionally
    // would replace the Lambda role in every existing deployment.
    const roles = template.findResources('AWS::IAM::Role');
    for (const role of Object.values(roles)) {
      assert.notStrictEqual(
        (role as any).Properties?.Description,
        'Shared execution role for the Blocks backend Lambda and container compute',
        'default mode must not create the shared compute role',
      );
    }

    // Public surface unchanged.
    assert.ok(stack.gateway, 'gateway accessor works in default mode');
    assert.ok(stack.apiUrl.includes('/aws-blocks/api'));
    assert.strictEqual(stack.apiOrigin, undefined, 'apiOrigin is compute-mode only');
  });
});

describe('container-compute mode — BlocksStack', () => {
  test('replaces API Gateway with the target front door and shares one role', async () => {
    const app = new cdk.App();
    const compute = new FakeCompute();

    const stack = await BlocksStack.create(app, 'ComputeModeStack', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
      compute,
    });

    const template = Template.fromStack(stack);

    // No REST API in container mode — one front door only.
    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);

    // The Lambda assumes the shared role (not an implicit NodejsFunction role).
    const sharedRoleIds = Object.entries(template.findResources('AWS::IAM::Role'))
      .filter(([, role]) =>
        (role as any).Properties?.Description ===
        'Shared execution role for the Blocks backend Lambda and container compute')
      .map(([logicalId]) => logicalId);
    assert.strictEqual(sharedRoleIds.length, 1, 'exactly one shared role');

    const trust = (template.findResources('AWS::IAM::Role')[sharedRoleIds[0]] as any)
      .Properties.AssumeRolePolicyDocument.Statement;
    const services = trust.flatMap((s: any) => [s.Principal?.Service].flat());
    assert.ok(services.includes('lambda.amazonaws.com'), 'role trusts lambda');
    assert.ok(services.includes('ecs-tasks.amazonaws.com'), 'role trusts ecs-tasks');

    const fns = Object.values(template.findResources('AWS::Lambda::Function'))
      .filter((fn: any) => fn.Properties?.Environment?.Variables?.BLOCKS_STACK_NAME);
    assert.strictEqual(fns.length, 1, 'companion Lambda still exists');
    assert.deepStrictEqual(
      (fns[0] as any).Properties.Role,
      { 'Fn::GetAtt': [sharedRoleIds[0], 'Arn'] },
      'Lambda uses the shared role',
    );

    // Front door comes from the target.
    assert.strictEqual(stack.apiUrl, 'https://d111111abcdef8.cloudfront.net/aws-blocks/api');
    assert.deepStrictEqual(stack.apiOrigin, {
      hostname: 'd111111abcdef8.cloudfront.net',
      originPath: '',
    });
    template.hasOutput('ApiUrl', { Value: 'https://d111111abcdef8.cloudfront.net/aws-blocks/api' });

    // gateway is a hard error, not a silent undefined.
    assert.throws(() => stack.gateway, /container compute target/);
  });

  test('bind() receives the handler, shared role, and token-free id', async () => {
    const app = new cdk.App();
    const compute = new FakeCompute();

    const stack = await BlocksStack.create(app, 'BindCtxStack', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
      compute,
    });

    assert.ok(compute.bindCtx, 'bind was called');
    assert.strictEqual(compute.bindCtx.id, 'BindCtxStack');
    assert.ok(!cdk.Token.isUnresolved(compute.bindCtx.id), 'ctx.id must be token-free');
    assert.strictEqual(compute.bindCtx.handler, stack.handler);
    assert.strictEqual(compute.bindCtx.backendHandlerPath, handlerPath);
    assert.strictEqual(compute.bindCtx.isSandbox, false);
  });

  test('finalize() runs after the app CDK module import and config finalization', async () => {
    const app = new cdk.App();
    const compute = new FakeCompute();

    await BlocksStack.create(app, 'FinalizeOrderStack', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
      compute,
    });

    assert.ok(compute.finalizeCtx, 'finalize was called');
    assert.ok(
      compute.finalizeObservations.sideEffectMarker,
      'finalize must run after the backendCDKPath import (blocks all constructed)',
    );
    assert.ok(
      compute.finalizeObservations.configDeployment,
      'finalize must run after finalizeConfigRegistry (config deployment exists)',
    );
  });

  test('EKS Pod Identity principal gets sts:TagSession on the trust policy', async () => {
    const app = new cdk.App();
    const compute = new FakeCompute(['pods.eks.amazonaws.com']);

    const stack = await BlocksStack.create(app, 'EksTrustStack', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
      compute,
    });

    const template = Template.fromStack(stack);
    const roles = Object.values(template.findResources('AWS::IAM::Role')).filter(
      (role: any) =>
        role.Properties?.Description ===
        'Shared execution role for the Blocks backend Lambda and container compute',
    );
    assert.strictEqual(roles.length, 1);

    const statements = (roles[0] as any).Properties.AssumeRolePolicyDocument.Statement;
    const eksStatement = statements.find(
      (s: any) => [s.Principal?.Service].flat().includes('pods.eks.amazonaws.com'),
    );
    assert.ok(eksStatement, 'trust statement for pods.eks.amazonaws.com exists');
    const actions = [eksStatement.Action].flat();
    assert.ok(actions.includes('sts:AssumeRole'), 'sts:AssumeRole present');
    assert.ok(actions.includes('sts:TagSession'), 'sts:TagSession present for Pod Identity');
  });
});

describe('container-compute mode — BlocksBackend', () => {
  test('works inside an existing stack with the same seam semantics', async () => {
    const app = new cdk.App();
    const parent = new cdk.Stack(app, 'ParentStack');
    const compute = new FakeCompute();

    const backend = await BlocksBackend.create(parent, 'Blocks', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
      compute,
    });

    const template = Template.fromStack(parent);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);

    assert.strictEqual(backend.apiUrl, 'https://d111111abcdef8.cloudfront.net/aws-blocks/api');
    assert.throws(() => backend.gateway, /container compute target/);
    assert.ok(compute.finalizeCtx, 'finalize was called for BlocksBackend');
  });
});
