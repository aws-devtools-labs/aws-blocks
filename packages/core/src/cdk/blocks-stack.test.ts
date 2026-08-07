// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { BlocksBackend, assertStackNameNotReserved } from './blocks-backend.js';
import { BlocksStack } from './index.js';

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

describe('assertStackNameNotReserved', () => {
  // Validation is centralized in assertStackNameNotReserved() and called from both
  // BlocksStack.create() and BlocksBackend.create(). Test it directly here.

  test('rejects names starting with "aws" (case-insensitive) with actionable message', () => {
    for (const name of ['aws-my-project', 'AWS-MyProject', 'AwsSomething']) {
      assert.throws(
        () => assertStackNameNotReserved(name),
        (err: Error) => {
          assert.ok(err.message.includes(`Invalid stackId "${name}"`), `Should include the name, got: ${err.message}`);
          assert.ok(err.message.includes('.blocks/config.json'), 'Should tell user where to fix');
          assert.ok(err.message.includes('reserved'), 'Should explain why');
          return true;
        },
      );
    }
  });

  test('allows names that merely contain "aws" elsewhere', () => {
    for (const name of ['my-awesome-project', 'drawsome-app', 'not-aws-prefixed']) {
      assert.doesNotThrow(() => assertStackNameNotReserved(name));
    }
  });

  test('BlocksStack.create() wires the check', async () => {
    const app = new cdk.App();
    await assert.rejects(
      BlocksStack.create(app, 'aws-test', {
        backendHandlerPath: handlerPath,
        backendCDKPath: sideEffectBackendPath,
      }),
      (err: Error) => {
        assert.ok(err.message.includes('Invalid stackId'));
        return true;
      },
    );
  });
});
