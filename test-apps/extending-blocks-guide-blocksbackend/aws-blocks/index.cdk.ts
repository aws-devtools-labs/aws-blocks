// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BlocksBackend brownfield harness.
 *
 * Demonstrates Pattern 1 via the `BlocksBackend` construct (drop into an
 * existing user-owned stack), as opposed to the standalone-stack flavor
 * exercised by `test-apps/extending-blocks-guide/`.
 */
import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { BlocksBackend, SandboxDisableDeletionProtection, registerConfig } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new cdk.App();

const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();
const id = getSandboxId(projectRoot);
const stackName = `bb-extending-guide-blocksbackend-${id}`;

/**
 * A user-owned stack that already has its own resources. Blocks drops in
 * as a single Construct via BlocksBackend.create — no second CloudFormation
 * stack involved.
 *
 * `blocks` and `externalQueue` are populated by the async `build` factory
 * (BlocksBackend.create is async, so they can't be initialized in the
 * synchronous constructor). The definite-assignment assertions are sound
 * because `build` is the only construction path.
 */
class MyExistingStack extends cdk.Stack {
  public blocks!: BlocksBackend;
  public externalQueue!: sqs.Queue;

  private constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }

  static async build(scope: cdk.App, id: string, props?: cdk.StackProps) {
    const stack = new MyExistingStack(scope, id, props);

    // Pretend this queue belongs to the existing app.
    stack.externalQueue = new sqs.Queue(stack, 'work-queue');

    // Drop Blocks in as a Construct.
    stack.blocks = await BlocksBackend.create(stack, 'BlocksApi', {
      backendHandlerPath: join(__dirname, 'index.handler.ts'),
      backendCDKPath: join(__dirname, 'index.ts'),
    });

    // Wire IAM and runtime configuration on the BlocksBackend — same surface as BlocksStack.
    stack.externalQueue.grantSendMessages(stack.blocks.handler);
    registerConfig(stack.blocks, 'EXTERNAL_QUEUE_URL', stack.externalQueue.queueUrl);

    new cdk.CfnOutput(stack, 'ApiUrl', { value: stack.blocks.apiUrl });
    new cdk.CfnOutput(stack, 'ExternalQueueUrl', { value: stack.externalQueue.queueUrl });
    new cdk.CfnOutput(stack, 'StackNameOut', { value: id });

    cdk.Tags.of(stack).add('blocks:purpose', 'extending-guide-blocksbackend-validation');
    return stack;
  }
}

export const stack = await MyExistingStack.build(app, stackName);

// E2E test stacks must be fully deletable.
RemovalPolicies.of(stack).destroy();
Mixins.of(stack).apply(new SandboxDisableDeletionProtection());
