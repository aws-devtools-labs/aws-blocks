// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for KnowledgeBase.
 *
 * Teardown: the data `s3.Bucket` paired `RemovalPolicy.DESTROY` with
 * `autoDeleteObjects` on a `destroy`/sandbox teardown, but the S3 Vectors L1
 * resources (`CfnVectorBucket` + `CfnIndex`) relied solely on their default
 * CloudFormation `DeletionPolicy` and leaked. Those tests pin the fix: the
 * vector resources now mirror the data bucket's removal policy.
 *
 * Ingestion sync: the handler role must be able to read ingestion-job
 * status (`bedrock:GetIngestionJob` / `bedrock:ListIngestionJobs`) — scoped to
 * the KB ARN like the existing `bedrock:Retrieve` grant — and the
 * `DATA_SOURCE_ID` config the runtime sync checks rely on must be
 * registered and surface in the synthesized template.
 *
 * Synth guards: the runtime methods (`retrieve` / `isSynced` / `waitUntilSynced`)
 * are stubbed on the CDK construct so an accidental synth-time call throws an
 * actionable error instead of a cryptic `TypeError: not a function`.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Scope, DEFAULT_NODE_RUNTIME, finalizeConfigRegistry } from '@aws-blocks/core/cdk';
import { KnowledgeBase } from './index.cdk.js';

// Real local-folder source so BucketDeployment + sidecar generation synth.
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'knowledge');

// Pull CFN type names off the L1 classes so the assertions don't drift if AWS
// renames the underlying resource types.
const VECTOR_BUCKET_TYPE = s3vectors.CfnVectorBucket.CFN_RESOURCE_TYPE_NAME;
const VECTOR_INDEX_TYPE = s3vectors.CfnIndex.CFN_RESOURCE_TYPE_NAME;

// Minimal BlocksStack-shaped parent — KnowledgeBase calls
// `this.handler.addToRolePolicy(...)` and `cdk.Stack.of(this)`, both of which
// resolve through CURRENT_BLOCKS_STACK (mirrors the production BlocksStack).
class StubBlocksStack extends cdk.Stack {
  public readonly handler: cdk.aws_lambda.Function;
  public readonly id: string;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.id = id;
    (globalThis as any).CURRENT_BLOCKS_STACK = this;
    this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
      runtime: DEFAULT_NODE_RUNTIME,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
    });
  }
}

function buildStack(options: { removalPolicy?: 'destroy' | 'retain'; sandbox?: boolean; source?: string } = {}): {
  stack: StubBlocksStack;
  kb: KnowledgeBase;
} {
  const app = new cdk.App(options.sandbox ? { context: { sandboxMode: 'true' } } : undefined);
  // S3 bucket names must be lowercase; the data bucket derives its name from
  // the scope chain, so keep ids lowercase.
  const stack = new StubBlocksStack(app, 'teststack');
  const parent = new Scope('app');
  const kb = new KnowledgeBase(parent, 'docs', {
    source: options.source ?? FIXTURES,
    ...(options.removalPolicy ? { removalPolicy: options.removalPolicy } : {}),
  });
  return { stack, kb };
}

function synth(options: { removalPolicy?: 'destroy' | 'retain'; sandbox?: boolean } = {}): Template {
  return Template.fromStack(buildStack(options).stack);
}

test("CDK: removalPolicy 'destroy' makes the data bucket + vector store deletable and adds auto-delete", () => {
  const template = synth({ removalPolicy: 'destroy' });

  // Data bucket: force-deletable and auto-empties on teardown.
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);

  // S3 Vectors resources mirror the data bucket — dropped on teardown.
  template.hasResource(VECTOR_BUCKET_TYPE, { DeletionPolicy: 'Delete' });
  template.hasResource(VECTOR_INDEX_TYPE, { DeletionPolicy: 'Delete' });
});

test("CDK: removalPolicy 'retain' keeps the data bucket + vector store and omits auto-delete", () => {
  const template = synth({ removalPolicy: 'retain' });

  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);

  template.hasResource(VECTOR_BUCKET_TYPE, { DeletionPolicy: 'Retain' });
  template.hasResource(VECTOR_INDEX_TYPE, { DeletionPolicy: 'Retain' });
});

test('CDK: sandboxMode context defaults the data bucket + vector store to destroy', () => {
  const template = synth({ sandbox: true });

  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);

  template.hasResource(VECTOR_BUCKET_TYPE, { DeletionPolicy: 'Delete' });
  template.hasResource(VECTOR_INDEX_TYPE, { DeletionPolicy: 'Delete' });
});

test('CDK: handler role can read ingestion-job status (GetIngestionJob/ListIngestionJobs), scoped to the KB ARN like bedrock:Retrieve', () => {
  const template = synth();

  // isSynced()/waitUntilSynced() poll ingestion-job status — the handler role
  // needs both actions, granted as Allow.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: ['bedrock:GetIngestionJob', 'bedrock:ListIngestionJobs'],
          Effect: 'Allow',
        }),
      ]),
    }),
  });

  // ...and that grant is scoped to the SAME knowledge-base ARN as the existing
  // bedrock:Retrieve grant (not a wildcard) — ingestion jobs are sub-resources
  // of the KB ARN.
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
  );
  const retrieveStmt = statements.find((s) => s.Action === 'bedrock:Retrieve');
  const ingestionStmt = statements.find(
    (s) => Array.isArray(s.Action) && (s.Action as string[]).includes('bedrock:GetIngestionJob'),
  );
  assert.ok(retrieveStmt, 'bedrock:Retrieve grant is present');
  assert.ok(ingestionStmt, 'ingestion-status grant is present');
  assert.deepStrictEqual(
    ingestionStmt.Resource,
    retrieveStmt.Resource,
    'ingestion-status grant is scoped to the same KB ARN as bedrock:Retrieve',
  );
});

test('CDK: registers the DATA_SOURCE_ID config (wired to the data source) and surfaces it in the synthesized template', () => {
  const { stack } = buildStack();

  // registerConfig records BLOCKS_{FULLID}_DATA_SOURCE_ID on the stack's config
  // registry, bound to the Bedrock data source's id — the runtime sync
  // checks read it back at cold start. (Mirrors bb-app-setting's CDK test.)
  const registry = (stack as any)[Symbol.for('BLOCKS_CONFIG_REGISTRY')] as
    | { entries: Map<string, unknown> }
    | undefined;
  assert.ok(registry, 'config registry exists on the stack');

  const dataSourceKey = [...registry.entries.keys()].find((k) => k.endsWith('_DATA_SOURCE_ID'));
  assert.ok(dataSourceKey, 'a *_DATA_SOURCE_ID config key is registered');
  assert.match(dataSourceKey, /^BLOCKS_.+_DATA_SOURCE_ID$/);

  const resolvedValue = stack.resolve(registry.entries.get(dataSourceKey)) as {
    'Fn::GetAtt'?: [string, string];
  };
  assert.ok(resolvedValue['Fn::GetAtt'], 'config value is a CDK token (Fn::GetAtt)');
  assert.strictEqual(
    resolvedValue['Fn::GetAtt'][1],
    'DataSourceId',
    'config value is wired to the data source id',
  );

  // finalizeConfigRegistry serializes the registry into blocks-config.json via a
  // BucketDeployment; the rendered config blob in the synthesized template
  // carries the DATA_SOURCE_ID key bound to the data source's DataSourceId, and
  // the handler is wired to read it from S3. (Mirrors bb-auth-cognito's CDK test.)
  finalizeConfigRegistry(stack, stack.handler);
  const template = Template.fromStack(stack);

  const configBlob = JSON.stringify(
    Object.values(template.findResources('Custom::CDKBucketDeployment')),
  );
  assert.match(configBlob, /BLOCKS_[A-Z0-9_]+_DATA_SOURCE_ID/);
  assert.ok(
    configBlob.includes('DataSourceId'),
    'config blob binds the DATA_SOURCE_ID key to the data source id',
  );

  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: Match.objectLike({
      Variables: Match.objectLike({
        BLOCKS_CONFIG_BUCKET: Match.anyValue(),
        BLOCKS_CONFIG_KEY: 'blocks-config.json',
      }),
    }),
  });
});

// ── S3 URI (imported bucket) source ─────────────────────────────────────────
// An imported s3:// source skips the documents BucketDeployment (the objects
// already live in the bucket) but still provisions a BB-managed CfnDataSource
// and fires the ingestion job — so the runtime sync grants and DATA_SOURCE_ID
// wiring must be present exactly as they are for a local-folder source (see
// DESIGN.md, "Source coverage (folder and imported s3://)").
const S3_SOURCE = 's3://my-docs-bucket';

test('CDK (s3:// source): handler still gets bedrock:Retrieve + ingestion-status grants scoped to the KB ARN', () => {
  const { stack } = buildStack({ source: S3_SOURCE });
  const template = Template.fromStack(stack);

  // Imported bucket → no documents BucketDeployment (proves the s3:// branch is
  // taken, not the folder path; finalizeConfigRegistry isn't called here).
  template.resourceCountIs('Custom::CDKBucketDeployment', 0);

  // Same ingestion-status grant as a folder source: both actions, granted Allow.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: ['bedrock:GetIngestionJob', 'bedrock:ListIngestionJobs'],
          Effect: 'Allow',
        }),
      ]),
    }),
  });

  // ...scoped to the SAME knowledge-base ARN as the existing bedrock:Retrieve
  // grant (not a wildcard) — ingestion jobs are sub-resources of the KB ARN.
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
  );
  const retrieveStmt = statements.find((s) => s.Action === 'bedrock:Retrieve');
  const ingestionStmt = statements.find(
    (s) => Array.isArray(s.Action) && (s.Action as string[]).includes('bedrock:GetIngestionJob'),
  );
  assert.ok(retrieveStmt, 'bedrock:Retrieve grant is present for an s3:// source');
  assert.ok(ingestionStmt, 'ingestion-status grant is present for an s3:// source');
  assert.deepStrictEqual(
    ingestionStmt.Resource,
    retrieveStmt.Resource,
    'ingestion-status grant is scoped to the same KB ARN as bedrock:Retrieve',
  );
});

test('CDK (s3:// source): DATA_SOURCE_ID config is wired to the data source id (same as a folder source)', () => {
  const { stack } = buildStack({ source: S3_SOURCE });

  // Even though the bucket is imported, the construct still registers
  // BLOCKS_{FULLID}_DATA_SOURCE_ID bound to the Bedrock data source's id, so the
  // runtime isSynced()/waitUntilSynced() checks track the imported source's
  // ingestion job exactly as they do for a local folder.
  const registry = (stack as any)[Symbol.for('BLOCKS_CONFIG_REGISTRY')] as
    | { entries: Map<string, unknown> }
    | undefined;
  assert.ok(registry, 'config registry exists on the stack');

  const dataSourceKey = [...registry.entries.keys()].find((k) => k.endsWith('_DATA_SOURCE_ID'));
  assert.ok(dataSourceKey, 'a *_DATA_SOURCE_ID config key is registered for an s3:// source');
  assert.match(dataSourceKey, /^BLOCKS_.+_DATA_SOURCE_ID$/);

  const resolvedValue = stack.resolve(registry.entries.get(dataSourceKey)) as {
    'Fn::GetAtt'?: [string, string];
  };
  assert.ok(resolvedValue['Fn::GetAtt'], 'config value is a CDK token (Fn::GetAtt)');
  assert.strictEqual(
    resolvedValue['Fn::GetAtt'][1],
    'DataSourceId',
    'config value is wired to the data source id even when the source is an S3 URI',
  );
});

test('CDK: calling a runtime method throws an actionable synth-time error (not a cryptic TypeError)', () => {
  const { kb } = buildStack();
  const construct = kb as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['retrieve', 'isSynced', 'waitUntilSynced']) {
    assert.throws(
      () => construct[method]('x'),
      /cannot be called during CDK synth/,
      `${method}() should throw the actionable synth-time error`,
    );
  }
});
