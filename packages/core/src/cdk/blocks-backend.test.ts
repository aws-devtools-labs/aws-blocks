// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BlocksBackend } from './blocks-backend.js';

// Simulate the CDK condition being active (tests import CDK files directly)
before(() => {
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? '') + ' --conditions=cdk';
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const sideEffectBackendPath = join(__dirname, '__fixtures__', 'side-effect-backend.js');
const factoryBackendPath = join(__dirname, '__fixtures__', 'factory-backend.js');
const fullIdConstructBackendPath = join(__dirname, '__fixtures__', 'fullid-construct-backend.js');

describe('ESM cache-busting (multi-stage)', () => {
  test('BlocksBackend.create() with same backendCDKPath but different IDs produces constructs in each', async () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const backend1 = await BlocksBackend.create(stack, 'Stage1', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const backend2 = await BlocksBackend.create(stack, 'Stage2', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const findMarker = (scope: cdk.aws_lambda_nodejs.NodejsFunction | any) =>
      scope.node.tryFindChild('SideEffectMarker');

    assert.ok(
      findMarker(backend1),
      'Stage1 backend should have SideEffectMarker construct from module side effect',
    );
    assert.ok(
      findMarker(backend2),
      'Stage2 backend should have SideEffectMarker construct from re-executed module',
    );
  });
});

describe('synth shape (drop into existing stack)', () => {
  test('BlocksBackend lives inside the parent stack and synthesizes Lambda + API Gateway', async () => {
    const app = new cdk.App();
    const parent = new cdk.Stack(app, 'MyExistingStack');

    const backend = await BlocksBackend.create(parent, 'Blocks', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    // Public surface mirrors BlocksStack.
    assert.ok(backend.handler, 'BlocksBackend should expose .handler');
    assert.ok(backend.gateway, 'BlocksBackend should expose .gateway');
    assert.ok(backend.apiUrl, 'BlocksBackend should expose .apiUrl');

    // Synth produces the expected resources inside the parent stack —
    // no separate stack is created.
    const template = Template.fromStack(parent);
    template.hasResourceProperties('AWS::Lambda::Function', {});
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  test('multiple BlocksBackends in the same parent stack do not collide', async () => {
    const app = new cdk.App();
    const parent = new cdk.Stack(app, 'MultiBackendStack');

    await BlocksBackend.create(parent, 'BackendA', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });
    await BlocksBackend.create(parent, 'BackendB', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const template = Template.fromStack(parent);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 2);
  });
});

describe('API Gateway throttling + access logging', () => {
  test('stage enforces throttle limits and writes JSON access logs to a retained log group', async () => {
    const app = new cdk.App();
    const parent = new cdk.Stack(app, 'ThrottleStack');

    await BlocksBackend.create(parent, 'Blocks', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const template = Template.fromStack(parent);

    // Stage carries the stage-wide throttle defaults (100 req/s steady, 200 burst)
    // applied to all methods/resources ('*' / '/*').
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          HttpMethod: '*',
          ResourcePath: '/*',
          ThrottlingRateLimit: 100,
          ThrottlingBurstLimit: 200,
        }),
      ]),
      // Access logging is wired to a destination with a non-empty (JSON) format.
      AccessLogSetting: Match.objectLike({
        DestinationArn: Match.anyValue(),
        Format: Match.anyValue(),
      }),
    });

    // A dedicated access-log group exists with 1-month (30-day) retention.
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });
  });
});

describe('factory function support', () => {
  test('BlocksBackend.create() calls default export function with the backend instance', async () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'FactoryTestStack');

    const backend = await BlocksBackend.create(stack, 'FactoryStage', {
      backendHandlerPath: handlerPath,
      backendCDKPath: factoryBackendPath,
    });

    const marker = backend.node.tryFindChild('FactoryMarker');
    assert.ok(marker, 'Factory function should have created FactoryMarker on the backend');
  });
});

describe('fullId is token-free (construct IDs / env-var keys)', () => {
  test('top-level stack: fullId is {stackName}-{id} and resolvable', async () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TopLevelStack');

    const backend = await BlocksBackend.create(stack, 'blocks', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    assert.strictEqual(backend.fullId, 'TopLevelStack-blocks');
    assert.ok(!cdk.Token.isUnresolved(backend.fullId), 'fullId must not contain a token');
  });

  test('nested stack: fullId stays token-free (regression for #714 / Amplify Gen2)', async () => {
    // Amplify Gen2 wires Blocks into a NestedStack via backend.createStack('blocks').
    // A NestedStack has a tokenized stackName that only resolves at deploy time —
    // embedding it in fullId broke construct IDs with
    // "ID components may not include unresolved tokens".
    const app = new cdk.App();
    const parent = new cdk.Stack(app, 'ParentStack');
    const nested = new cdk.NestedStack(parent, 'blocks');

    // Sanity: the nested stack's own name really is a token.
    assert.ok(
      cdk.Token.isUnresolved(nested.stackName),
      'precondition: NestedStack.stackName should be an unresolved token',
    );

    const backend = await BlocksBackend.create(nested, 'blocks', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    assert.ok(
      !cdk.Token.isUnresolved(backend.fullId),
      `fullId must be token-free inside a nested stack, got: ${backend.fullId}`,
    );
    // Falls back to the top-level (concrete) stack name, keeping uniqueness.
    assert.strictEqual(backend.fullId, 'ParentStack-blocks');
  });

  test('child Scope can use fullId as a construct ID inside a nested stack', async () => {
    // The fixture mirrors bb-distributed-data: it builds a construct whose ID is
    // `${this.fullId}Marker`. If fullId carried a token, synth would throw.
    const app = new cdk.App();
    const parent = new cdk.Stack(app, 'Gen2ParentStack');
    const nested = new cdk.NestedStack(parent, 'blocks');

    const backend = await BlocksBackend.create(nested, 'blocks', {
      backendHandlerPath: handlerPath,
      backendCDKPath: fullIdConstructBackendPath,
    });

    // The construct ID is `${scope.fullId}Marker` → `ParentStack-blocks-blocks-dbMarker`.
    const expectedId = `${backend.fullId}-dbMarker`;
    assert.ok(
      nested.node.tryFindChild(expectedId),
      `expected a child construct with id "${expectedId}"`,
    );

    // Full synth must not throw on unresolved-token-in-construct-id.
    assert.doesNotThrow(() => app.synth());
  });

  test('BLOCKS_STACK_NAME env var equals fullId (CDK-time ↔ runtime invariant)', async () => {
    // Physical resource names (DynamoDB tables, DSQL env-var keys, IAM ARNs) are
    // derived from fullId on BOTH sides: at synth via BlocksBackend.fullId, and at
    // runtime via the root parent `{ id: process.env.BLOCKS_STACK_NAME }`. They MUST
    // be byte-for-byte identical, otherwise the runtime looks up names/grants that
    // were never created. BlocksBackend keeps them in sync by writing fullId into the
    // handler's BLOCKS_STACK_NAME env var — assert that contract holds and is token-free.
    const app = new cdk.App();
    const parent = new cdk.Stack(app, 'InvariantParent');
    const nested = new cdk.NestedStack(parent, 'blocks');

    const backend = await BlocksBackend.create(nested, 'blocks', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const template = Template.fromStack(nested);
    const fns = template.findResources('AWS::Lambda::Function');
    const envValues = Object.values(fns)
      .map((fn: any) => fn.Properties?.Environment?.Variables?.BLOCKS_STACK_NAME)
      .filter((v): v is string => typeof v === 'string');

    assert.ok(envValues.length > 0, 'expected a Lambda with a BLOCKS_STACK_NAME env var');
    for (const value of envValues) {
      assert.strictEqual(
        value,
        backend.fullId,
        'BLOCKS_STACK_NAME must equal BlocksBackend.fullId so runtime names match synth',
      );
      assert.ok(
        !cdk.Token.isUnresolved(value),
        `BLOCKS_STACK_NAME must be token-free, got: ${value}`,
      );
    }
  });
});
