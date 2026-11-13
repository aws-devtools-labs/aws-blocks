// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkStorageEncryption,
  createCloudFormationReader,
  findEncryptedClusters,
  isNotFoundError,
  predeploy,
  type CloudFormationSender,
  type DeployedStackReader,
  type PredeployContext,
  type SynthesizedStack,
} from './predeploy.js';

const FLAG = '@aws-blocks/bb-data:encryptStorageByDefault';
const DOC_ANCHOR = '#enabling-storage-encryption-on-an-existing-database';

/** A synthesized Database cluster resource, as the CDK layer emits it. */
function clusterResource(props: Record<string, unknown>, marked = true): Record<string, unknown> {
  return {
    Type: 'AWS::RDS::DBCluster',
    Properties: props,
    Metadata: {
      'aws:cdk:path': 'app-stack/blocks/main/mainCluster/Resource',
      ...(marked ? { '@aws-blocks/bb-data:database': 'main' } : {}),
    },
  };
}

function stackWith(resources: Record<string, unknown>, stackName = 'app-stack'): SynthesizedStack {
  return { stackName, template: { Resources: resources } };
}

const ENCRYPTED_STACK = stackWith({ mainCluster1234: clusterResource({ StorageEncrypted: true }) });

/** A deployed template whose cluster has the given properties. */
function deployedTemplate(props: Record<string, unknown>): Record<string, unknown> {
  return { Resources: { mainCluster1234: { Type: 'AWS::RDS::DBCluster', Properties: props } } };
}

interface StubCalls {
  stackExists: string[];
  describeResource: string[];
  getTemplate: string[];
}

/** A reader stub that records calls; each answer can be a value or an error to throw. */
function stubReader(answers: {
  stackExists?: boolean | Error;
  resource?: { physicalId?: string; status?: string } | undefined | Error;
  template?: Record<string, unknown> | Error;
}): { reader: DeployedStackReader; calls: StubCalls } {
  const calls: StubCalls = { stackExists: [], describeResource: [], getTemplate: [] };
  const answer = <T>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  return {
    calls,
    reader: {
      stackExists(stackName) {
        calls.stackExists.push(stackName);
        return answer(answers.stackExists ?? true);
      },
      describeResource(stackName, logicalId) {
        calls.describeResource.push(`${stackName}/${logicalId}`);
        return answer('resource' in answers ? answers.resource : { physicalId: 'app-main-cluster' });
      },
      getTemplate(stackName) {
        calls.getTemplate.push(stackName);
        return answer(answers.template ?? deployedTemplate({ StorageEncrypted: true }));
      },
    },
  };
}

function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function totalCalls(calls: StubCalls): number {
  return calls.stackExists.length + calls.describeResource.length + calls.getTemplate.length;
}

test('findEncryptedClusters: picks only marked clusters with StorageEncrypted: true', () => {
  const targets = findEncryptedClusters([
    stackWith({
      mainCluster1234: clusterResource({ StorageEncrypted: true, KmsKeyId: 'arn:aws:kms:us-east-1:1:key/k' }),
      optedOut: clusterResource({}, false),
      otherBlockCluster: clusterResource({ StorageEncrypted: true }, false),
      bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    }),
  ]);
  assert.deepEqual(targets, [
    {
      stackName: 'app-stack',
      logicalId: 'mainCluster1234',
      databaseId: 'main',
      constructPath: 'app-stack/blocks/main/mainCluster/Resource',
      usesCustomerKey: true,
    },
  ]);
});

test('check: no cluster in the template makes no calls', async () => {
  const { reader, calls } = stubReader({});
  const result = await checkStorageEncryption([stackWith({ bucket: { Type: 'AWS::S3::Bucket' } })], reader);
  assert.deepEqual(result, {});
  assert.equal(totalCalls(calls), 0);
});

test('check: a flag-false template (no StorageEncrypted, no marker) makes no calls', async () => {
  const { reader, calls } = stubReader({});
  const result = await checkStorageEncryption([stackWith({ mainCluster1234: clusterResource({}, false) })], reader);
  assert.deepEqual(result, {});
  assert.equal(totalCalls(calls), 0);
});

test('check: a stack that does not exist yet passes', async () => {
  const { reader, calls } = stubReader({ stackExists: false });
  const result = await checkStorageEncryption([ENCRYPTED_STACK], reader);
  assert.equal(result.stops, undefined);
  assert.deepEqual(calls.describeResource, []);
  assert.deepEqual(calls.getTemplate, []);
});

test('check: a cluster the deployed stack does not have yet passes', async () => {
  const { reader, calls } = stubReader({ resource: undefined });
  const result = await checkStorageEncryption([ENCRYPTED_STACK], reader);
  assert.equal(result.stops, undefined);
  assert.deepEqual(calls.getTemplate, []);
});

test('check: a deployed encrypted cluster passes', async () => {
  const { reader } = stubReader({ template: deployedTemplate({ StorageEncrypted: 'true' }) });
  const result = await checkStorageEncryption([ENCRYPTED_STACK], reader);
  assert.equal(result.stops, undefined);
  assert.match(result.notes?.[0] ?? '', /passed for 1 Aurora cluster/);
});

for (const props of [{}, { StorageEncrypted: false }, { StorageEncrypted: 'false' }]) {
  test(`check: a deployed unencrypted cluster (${JSON.stringify(props)}) stops with both options`, async () => {
    const { reader } = stubReader({ template: deployedTemplate(props) });
    const result = await checkStorageEncryption([ENCRYPTED_STACK], reader);
    assert.equal(result.stops?.length, 1);
    const stop = result.stops?.[0] ?? '';
    assert.match(stop, /Database "main" \(app-stack\/blocks\/main\/mainCluster\/Resource\)/);
    assert.match(stop, /"app-main-cluster"/);
    assert.match(stop, /replacing the cluster with a new, empty one/);
    assert.ok(stop.includes(`(1) keep the current cluster: set "${FLAG}": false`), stop);
    assert.ok(stop.includes(`(2) move the data to an encrypted cluster`), stop);
    assert.ok(stop.includes(DOC_ANCHOR), stop);
  });
}

test('check: with a customer-managed key, option (1) also says to remove storageEncryptionKeyArn', async () => {
  const { reader } = stubReader({ template: deployedTemplate({}) });
  const stack = stackWith({
    mainCluster1234: clusterResource({ StorageEncrypted: true, KmsKeyId: 'arn:aws:kms:us-east-1:1:key/k' }),
  });
  const result = await checkStorageEncryption([stack], reader);
  assert.match(result.stops?.[0] ?? '', /remove storageEncryptionKeyArn from this Database and set/);
});

for (const step of ['stackExists', 'resource', 'template'] as const) {
  test(`check: an AccessDenied from ${step} stops the deploy (fails closed)`, async () => {
    const denied = namedError('AccessDenied', 'not authorized to perform cloudformation:Describe');
    const { reader } = stubReader({ [step]: denied });
    const result = await checkStorageEncryption([ENCRYPTED_STACK], reader);
    assert.equal(result.stops?.length, 1);
    const stop = result.stops?.[0] ?? '';
    assert.match(stop, /could not check the storage encryption/);
    assert.match(stop, /AccessDenied: not authorized/);
    assert.match(stop, /cloudformation:DescribeStackResource/);
    assert.ok(stop.includes(`"${FLAG}": false`), stop);
    assert.match(stop, /BLOCKS_SKIP_STORAGE_ENCRYPTION_CHECK=1/);
  });
}

test('check: an unreadable deployed StorageEncrypted value stops the deploy', async () => {
  const { reader } = stubReader({ template: deployedTemplate({ StorageEncrypted: { Ref: 'Encrypt' } }) });
  const result = await checkStorageEncryption([ENCRYPTED_STACK], reader);
  assert.match(result.stops?.[0] ?? '', /could not check/);
});

test('check: two Databases in one stack look the stack and its template up once', async () => {
  const { reader, calls } = stubReader({});
  const stack = stackWith({
    mainCluster1234: clusterResource({ StorageEncrypted: true }),
    otherCluster5678: {
      ...clusterResource({ StorageEncrypted: true }),
      Metadata: { '@aws-blocks/bb-data:database': 'other' },
    },
  });
  const result = await checkStorageEncryption([stack], {
    ...reader,
    getTemplate: async (name) => {
      calls.getTemplate.push(name);
      return {
        Resources: {
          mainCluster1234: { Type: 'AWS::RDS::DBCluster', Properties: { StorageEncrypted: true } },
          otherCluster5678: { Type: 'AWS::RDS::DBCluster', Properties: { StorageEncrypted: true } },
        },
      };
    },
  });
  assert.equal(result.stops, undefined);
  assert.equal(calls.stackExists.length, 1);
  assert.equal(calls.describeResource.length, 2);
  assert.equal(calls.getTemplate.length, 1);
});

test('isNotFoundError: only CloudFormation "does not exist" validation errors', () => {
  assert.equal(isNotFoundError(namedError('ValidationError', 'Stack with id app-stack does not exist')), true);
  assert.equal(isNotFoundError(namedError('ValidationError', 'Template format error')), false);
  assert.equal(isNotFoundError(namedError('AccessDenied', 'Stack does not exist or not authorized')), false);
  assert.equal(isNotFoundError(namedError('Throttling', 'Rate exceeded')), false);
});

/** A CloudFormation client stub answering by command name. */
function stubSender(answers: Record<string, unknown>): CloudFormationSender {
  return {
    async send(command) {
      const answer = answers[command.constructor.name];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test('CloudFormation reader: missing stack and missing resource read as not found', async () => {
  const reader = createCloudFormationReader(
    stubSender({
      DescribeStacksCommand: namedError('ValidationError', 'Stack with id app-stack does not exist'),
      DescribeStackResourceCommand: namedError(
        'ValidationError',
        'Resource mainCluster1234 does not exist for stack app-stack',
      ),
    }),
  );
  assert.equal(await reader.stackExists('app-stack'), false);
  assert.equal(await reader.describeResource('app-stack', 'mainCluster1234'), undefined);
});

test('CloudFormation reader: AccessDenied propagates', async () => {
  const reader = createCloudFormationReader(
    stubSender({
      DescribeStacksCommand: namedError('AccessDenied', 'denied'),
      DescribeStackResourceCommand: namedError('AccessDenied', 'denied'),
      GetTemplateCommand: namedError('AccessDenied', 'denied'),
    }),
  );
  await assert.rejects(reader.stackExists('app-stack'), /denied/);
  await assert.rejects(reader.describeResource('app-stack', 'x'), /denied/);
  await assert.rejects(reader.getTemplate('app-stack'), /denied/);
});

test('CloudFormation reader: resource and template are read from the responses', async () => {
  const reader = createCloudFormationReader(
    stubSender({
      DescribeStacksCommand: { Stacks: [{ StackName: 'app-stack' }] },
      DescribeStackResourceCommand: {
        StackResourceDetail: { PhysicalResourceId: 'app-main-cluster', ResourceStatus: 'UPDATE_COMPLETE' },
      },
      GetTemplateCommand: { TemplateBody: JSON.stringify(deployedTemplate({})) },
    }),
  );
  assert.equal(await reader.stackExists('app-stack'), true);
  assert.deepEqual(await reader.describeResource('app-stack', 'mainCluster1234'), {
    physicalId: 'app-main-cluster',
    status: 'UPDATE_COMPLETE',
  });
  assert.deepEqual(await reader.getTemplate('app-stack'), deployedTemplate({}));
});

function contextFor(stacks: SynthesizedStack[]): { context: PredeployContext; synthCalls: () => number } {
  let synthCalls = 0;
  return {
    synthCalls: () => synthCalls,
    context: {
      stage: 'production',
      projectRoot: '/nonexistent',
      async synth() {
        synthCalls++;
        return stacks;
      },
    },
  };
}

test('predeploy: stops the deploy for a deployed unencrypted cluster', async () => {
  const { reader } = stubReader({ template: deployedTemplate({}) });
  const { context } = contextFor([ENCRYPTED_STACK]);
  const result = await predeploy(context, { env: {}, reader });
  assert.equal(result.stops?.length, 1);
});

test('predeploy: no encrypted cluster returns nothing and makes no calls', async () => {
  const { reader, calls } = stubReader({});
  const { context } = contextFor([stackWith({ mainCluster1234: clusterResource({}, false) })]);
  assert.deepEqual(await predeploy(context, { env: {}, reader }), {});
  assert.equal(totalCalls(calls), 0);
});

test('predeploy: BLOCKS_SKIP_STORAGE_ENCRYPTION_CHECK=1 skips synth and every call', async () => {
  const { reader, calls } = stubReader({ template: deployedTemplate({}) });
  const { context, synthCalls } = contextFor([ENCRYPTED_STACK]);
  const result = await predeploy(context, { env: { BLOCKS_SKIP_STORAGE_ENCRYPTION_CHECK: '1' }, reader });
  assert.equal(result.stops, undefined);
  assert.match(result.notes?.[0] ?? '', /skipped/);
  assert.equal(synthCalls(), 0);
  assert.equal(totalCalls(calls), 0);
});

test('package.json declares the pre-deploy hook for production and sandbox', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8')) as {
    files: string[];
    'aws-blocks': { predeploy: { module: string; stages: string[] } };
  };
  assert.deepEqual(pkg['aws-blocks'].predeploy, { module: './dist/predeploy.js', stages: ['production', 'sandbox'] });
  assert.ok(pkg.files.includes('dist'), 'dist (with predeploy.js) is shipped');
});
