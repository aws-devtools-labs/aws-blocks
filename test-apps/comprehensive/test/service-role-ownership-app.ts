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
 *
 * KMS keys get the same treatment: the `Condition` of every key-policy statement
 * that names a service principal is removed, the key-policy check reports each
 * such key, and the JSON line also carries `keyErrors`, `keyWarnings` and
 * `serviceKeys` (every key whose policy names a service principal). No block in
 * the backend creates such a key today, so the stack also gets a `Hosting` with
 * monitoring on (a static site from a scratch build output): its alarm topic
 * key grants `cloudwatch.amazonaws.com`, which gives the key check a key to see.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlocksPresets, BlocksStack, Hosting } from '@aws-blocks/blocks/cdk';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { IConstruct } from 'constructs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAMBDA_PRINCIPALS = new Set(['lambda.amazonaws.com', 'edgelambda.amazonaws.com']);
const WARNING_ID = '@aws-blocks/core:serviceRoleTrustWithoutSourceCondition';
const KEY_WARNING_ID = '@aws-blocks/core:kmsKeyPolicyWithoutSourceCondition';

interface TrustStatement {
  Principal?: { Service?: string | string[] };
}

const app = new cdk.App({ context: { sandboxMode: 'true' } });
const stack = await BlocksStack.create(app, 'bb-test-role-ownership', {
  backendHandlerPath: join(__dirname, '..', 'aws-blocks', 'index.handler.ts'),
  backendCDKPath: join(__dirname, '..', 'aws-blocks', 'index.ts'),
  defaults: BlocksPresets.sandbox,
});

// A minimal SPA build output for Hosting (never deployed).
const site = mkdtempSync(join(tmpdir(), 'bb-role-ownership-site-'));
mkdirSync(join(site, 'dist'));
writeFileSync(join(site, 'dist', 'index.html'), '<!DOCTYPE html><html><body>ok</body></html>');
writeFileSync(join(site, 'package.json'), JSON.stringify({ name: 'role-ownership-site', dependencies: {} }));
new Hosting(stack, 'Hosting', { root: site, api: stack, monitoring: { enabled: true } });

const serviceRoles: string[] = [];
const serviceKeys: string[] = [];
cdk.Aspects.of(app).add({
  visit(node: IConstruct) {
    if (cdk.CfnResource.isCfnResource(node) && node.cfnResourceType === 'AWS::KMS::Key') {
      const key = node as kms.CfnKey;
      const policy = cdk.Stack.of(key).resolve(key.keyPolicy) as { Statement?: TrustStatement[] };
      let named = false;
      (policy?.Statement ?? []).forEach((s, i) => {
        if (s.Principal?.Service === undefined) return;
        named = true;
        key.addPropertyDeletionOverride(`KeyPolicy.Statement.${i}.Condition`);
      });
      if (named) serviceKeys.push(key.node.path);
      return;
    }
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
let keyErrors: string[] = [];
try {
  app.synth();
} catch (err) {
  if (!(err instanceof Error)) throw err;
  const lines = err.message.split('\n');
  const paths = (kind: RegExp) =>
    lines.map((line) => kind.exec(line)?.[1]).filter((path): path is string => path !== undefined);
  errors = paths(/^\s*\[([^\]]+)\] IAM role /);
  keyErrors = [...new Set(paths(/^\s*\[([^\]]+)\] KMS key /))];
  if (errors.length === 0 && keyErrors.length === 0) throw err;
}

// Synth stops at the validation errors, so read the warnings off the tree.
const warnedWith = (id: string) =>
  stack.node
    .findAll()
    .filter((n) => n.node.metadata.some((m) => m.type === 'aws:cdk:warning' && String(m.data).includes(id)))
    .map((n) => n.node.path);
const warnings = warnedWith(WARNING_ID);
const keyWarnings = warnedWith(KEY_WARNING_ID);

console.log(JSON.stringify({ errors, warnings, serviceRoles, keyErrors, keyWarnings, serviceKeys }));
