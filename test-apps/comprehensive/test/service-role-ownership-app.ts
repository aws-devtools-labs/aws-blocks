// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK app for test/service-role-ownership-synth.test.ts (run with
 * `tsx -C cdk`, never deployed).
 *
 * Builds this app's backend (which instantiates every Building Block) in a
 * `BlocksStack`, then removes the `Condition` of every trust statement of every
 * IAM role and synthesizes. The service-principal trust check then reports each
 * role whose trust names a non-Lambda service principal: as a synth error when
 * AWS Blocks owns the role, as a warning when the app does. Prints one JSON
 * line: `{ errors, warnings, serviceRoles }`, each a list of role resource
 * paths (`serviceRoles` = every role with a non-Lambda service principal).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlocksPresets, BlocksStack } from '@aws-blocks/blocks/cdk';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAMBDA_PRINCIPALS = new Set(['lambda.amazonaws.com', 'edgelambda.amazonaws.com']);
const WARNING_ID = '@aws-blocks/core:serviceRoleTrustWithoutSourceCondition';

interface TrustStatement {
  Principal?: { Service?: string | string[] };
}

const app = new cdk.App({ context: { sandboxMode: 'true' } });
const stack = await BlocksStack.create(app, 'bb-test-role-ownership', {
  backendHandlerPath: join(__dirname, '..', 'aws-blocks', 'index.handler.ts'),
  backendCDKPath: join(__dirname, '..', 'aws-blocks', 'index.ts'),
  defaults: BlocksPresets.sandbox,
});

const serviceRoles: string[] = [];
cdk.Aspects.of(app).add({
  visit(node: IConstruct) {
    if (!cdk.CfnResource.isCfnResource(node) || node.cfnResourceType !== 'AWS::IAM::Role') return;
    const role = node as iam.CfnRole;
    const doc = cdk.Stack.of(role).resolve(role.assumeRolePolicyDocument) as { Statement?: TrustStatement[] };
    const statements = doc?.Statement ?? [];
    const services = statements.flatMap((s) => ([] as string[]).concat(s.Principal?.Service ?? []));
    if (services.some((service) => !LAMBDA_PRINCIPALS.has(service))) serviceRoles.push(role.node.path);
    statements.forEach((_, i) => {
      role.addPropertyDeletionOverride(`AssumeRolePolicyDocument.Statement.${i}.Condition`);
    });
  },
});

let errors: string[] = [];
try {
  app.synth();
} catch (err) {
  if (!(err instanceof Error)) throw err;
  errors = err.message
    .split('\n')
    .map((line) => /^\s*\[([^\]]+)\] IAM role /.exec(line)?.[1])
    .filter((path): path is string => path !== undefined);
  if (errors.length === 0) throw err;
}

// Synth stops at the validation errors, so read the warnings off the tree.
const warnings = stack.node
  .findAll()
  .filter((n) => n.node.metadata.some((m) => m.type === 'aws:cdk:warning' && String(m.data).includes(WARNING_ID)))
  .map((n) => n.node.path);

console.log(JSON.stringify({ errors, warnings, serviceRoles }));
