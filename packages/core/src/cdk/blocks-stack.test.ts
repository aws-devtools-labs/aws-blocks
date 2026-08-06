// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { BlocksBackend } from './blocks-backend.js';
import { BlocksStack, Scope } from './index.js';

// Simulate the CDK condition being active (tests import CDK files directly)
before(() => {
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? '') + ' --conditions=cdk';
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const sideEffectBackendPath = join(__dirname, '__fixtures__', 'side-effect-backend.js');
const factoryBackendPath = join(__dirname, '__fixtures__', 'factory-backend.js');

describe('ESM cache-busting (multi-stage)', () => {
  test('BlocksStack.create() with same backendCDKPath but different IDs produces constructs in each', async () => {
    const app = new cdk.App();

    const stack1 = await BlocksStack.create(app, 'PipelineStage1', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const stack2 = await BlocksStack.create(app, 'PipelineStage2', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const findMarker = (scope: any) => scope.node.tryFindChild('SideEffectMarker');

    assert.ok(
      findMarker(stack1),
      'First stack should have SideEffectMarker from module side effect',
    );
    assert.ok(
      findMarker(stack2),
      'Second stack should have SideEffectMarker from re-executed module (cache busted)',
    );
  });
});

describe('factory function support', () => {
  test('BlocksStack.create() calls default export function with the stack instance', async () => {
    const app = new cdk.App();

    const stack = await BlocksStack.create(app, 'FactoryBlocksStack', {
      backendHandlerPath: handlerPath,
      backendCDKPath: factoryBackendPath,
    });

    const marker = stack.node.tryFindChild('FactoryMarker');
    assert.ok(marker, 'Factory function should have created FactoryMarker on the stack');
  });
});

describe('legacy side-effect mode (no default export)', () => {
  test('module with only side effects still registers constructs via globalThis', async () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'LegacyTestStack');

    const backend = await BlocksBackend.create(stack, 'LegacyStage', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const marker = backend.node.tryFindChild('SideEffectMarker');
    assert.ok(
      marker,
      'Side-effect-only module should register construct via globalThis.CURRENT_BLOCKS_STACK',
    );
  });
});

describe('shared execution role (BlocksStack)', () => {
  const MARKER_ACTION = 'blocks-test:StackMarkerAction';

  test('BlocksStack exposes executionRole and the handler assumes it', async () => {
    const app = new cdk.App();
    const stack = await BlocksStack.create(app, 'StackRoleStack', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    assert.ok(stack.executionRole, 'BlocksStack should expose .executionRole');

    const template = Template.fromStack(stack);
    const roles = template.findResources('AWS::IAM::Role');
    const blocksRoleId = Object.keys(roles).find(k => k.includes('BlocksRole'));
    assert.ok(blocksRoleId, 'expected a role from the BlocksRole construct');
    assert.ok(
      JSON.stringify(roles[blocksRoleId].Properties.ManagedPolicyArns ?? []).includes('AWSLambdaBasicExecutionRole'),
      'BlocksRole should attach AWSLambdaBasicExecutionRole',
    );
    template.hasResourceProperties('AWS::Lambda::Function', {
      Role: { 'Fn::GetAtt': [blocksRoleId, 'Arn'] },
    });
  });

  test('a nested block resolves executionRole to the BlocksStack role', async () => {
    const app = new cdk.App();
    const stack = await BlocksStack.create(app, 'StackRoleResolveStack', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    const outer = new Scope('outer');
    const inner = new Scope('inner', { parent: outer });
    assert.strictEqual(inner.executionRole, stack.executionRole, 'resolves up to the BlocksStack role');

    inner.executionRole.addToPrincipalPolicy(
      new PolicyStatement({ actions: [MARKER_ACTION], resources: ['*'] }),
    );

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: MARKER_ACTION })]),
      },
    });
  });
});

describe('executionRole globalThis fallback', () => {
  test('resolves via globalThis.CURRENT_BLOCKS_STACK when no owner is in the tree', async () => {
    const app = new cdk.App();
    const stack = await BlocksStack.create(app, 'FallbackStack', {
      backendHandlerPath: handlerPath,
      backendCDKPath: sideEffectBackendPath,
    });

    // A Scope whose construct-tree ancestry has no BlocksStack/BlocksBackend
    // (parented under a plain cdk.Stack) exhausts the tree-walk and falls back
    // to globalThis.CURRENT_BLOCKS_STACK. The `as any` is test plumbing — a
    // plain Stack isn't a ScopeParent, but it IS a valid Construct parent.
    const plainStack = new cdk.Stack(app, 'PlainStack');
    (globalThis as any).CURRENT_BLOCKS_STACK = stack;
    const orphan = new Scope('orphan', { parent: plainStack as any });

    assert.strictEqual(
      orphan.executionRole,
      stack.executionRole,
      'fallback resolves to the ambient stack role',
    );
  });
});

describe('assertCdkConditionActive', () => {
  test('BlocksStack.create() throws when --conditions=cdk is missing', async () => {
    const origNodeOptions = process.env.NODE_OPTIONS;
    const origExecArgv = process.execArgv;
    process.env.NODE_OPTIONS = '';
    process.execArgv = [];

    try {
      const app = new cdk.App();

      await assert.rejects(
        BlocksStack.create(app, 'MissingConditionStack', {
          backendHandlerPath: handlerPath,
          backendCDKPath: sideEffectBackendPath,
        }),
        (err: Error) => {
          assert.ok(err.message.includes('Missing --conditions=cdk'), `Expected condition error, got: ${err.message}`);
          return true;
        },
      );
    } finally {
      process.env.NODE_OPTIONS = origNodeOptions;
      process.execArgv = origExecArgv;
    }
  });
});
