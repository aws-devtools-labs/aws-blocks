// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { classifyError } from '../telemetry/trackCommand.js';
import { ensureSecrets, loadProductionEnv } from './ensure-secrets.js';

describe('loadProductionEnv', () => {
  let workDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'load-prod-env-'));
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  // Regression for bug bash item #2: deploy of a non-Supabase template
  // (no .env.production, no SUPABASE_DB_URL) must not throw.
  it('does not throw when .env.production is absent and no connection string is set', () => {
    delete process.env.SUPABASE_DB_URL;
    assert.doesNotThrow(() => loadProductionEnv());
  });

  it('does not throw when .env.production is absent even without any DB env var', () => {
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;
    assert.doesNotThrow(() => loadProductionEnv());
  });

  it('loads variables from .env.production when present', () => {
    const key = 'LOAD_PROD_ENV_TEST_VAR';
    delete process.env[key];
    writeFileSync(join(workDir, '.env.production'), `${key}=hello-prod\n`);
    try {
      loadProductionEnv();
      assert.strictEqual(process.env[key], 'hello-prod');
    } finally {
      delete process.env[key];
    }
  });
});

/** Build an Error with a specific `name`, as the AWS SDK throws. */
function namedError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, extra);
}

// Example identifiers in the format of an AWS authorization error. None of them may reach the output.
const ACCOUNT = '123456789012';
const ORGANIZATION = 'o-exampleorgid';
const POLICY = 'p-examplepolicyid123';
const PRINCIPAL = `arn:aws:sts::${ACCOUNT}:assumed-role/ExampleDeployRole/example-session`;
const IDENTIFIERS = [ACCOUNT, ORGANIZATION, POLICY, 'arn:aws', 'ExampleDeployRole', 'fixture-prod-db-url'];

/** Errors as the SDK throws them for an SSM `action`, with the raw message that must not be printed. */
function failures(action: string): Record<string, Error> {
  const resource = `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/fixture-prod-db-url`;
  return {
    expired: namedError('ExpiredTokenException', 'The security token included in the request is expired', {
      $metadata: { httpStatusCode: 400 },
    }),
    denied: namedError(
      'AccessDeniedException',
      `User: ${PRINCIPAL} is not authorized to perform: ${action} on resource: ${resource} because no identity-based policy allows the ${action} action`,
      { $metadata: { httpStatusCode: 400 } },
    ),
    'organization-policy': namedError(
      'AccessDeniedException',
      `User: ${PRINCIPAL} is not authorized to perform: ${action} on resource: ${resource} with an explicit deny in a service control policy: arn:aws:organizations::${ACCOUNT}:policy/${ORGANIZATION}/service_control_policy/${POLICY}`,
      { $metadata: { httpStatusCode: 400 } },
    ),
    network: namedError('Error', `getaddrinfo ENOTFOUND ssm.us-east-1.amazonaws.com (${PRINCIPAL})`, {
      code: 'ENOTFOUND',
    }),
  };
}

describe('ensureSecrets', () => {
  let directory: string;
  let savedEnv: NodeJS.ProcessEnv;
  /** The names of the SSM commands that were sent. */
  let requests: string[];

  beforeEach(() => {
    savedEnv = { ...process.env };
    directory = mkdtempSync(join(tmpdir(), 'ensure-secrets-'));
    mkdirSync(join(directory, '.blocks'));
    writeFileSync(join(directory, '.blocks', 'config.json'), '{"stackId":"fixture"}');
    writeFileSync(join(directory, 'config'), '');
    writeFileSync(join(directory, 'credentials'), '');
    for (const key of Object.keys(process.env)) {
      if (/^(AWS_|AMAZON_|CDK_)|_(DB_URL|CONNECTION_STRING)$/.test(key)) delete process.env[key];
    }
    Object.assign(process.env, {
      HOME: directory,
      USERPROFILE: directory,
      AWS_CONFIG_FILE: join(directory, 'config'),
      AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIAFIXTUREKEY',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    });
    requests = [];
  });

  afterEach(() => {
    mock.restoreAll();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  });

  /** Replace SSM requests: `respond` gets the command name and returns the response or throws. */
  function mockSsm(respond: (command: string) => unknown): void {
    mock.method(SSMClient.prototype, 'send', async (command: object) => {
      requests.push(command.constructor.name);
      return respond(command.constructor.name);
    });
  }

  it('makes no SSM request without a connection string', async () => {
    mockSsm(() => assert.fail('unexpected SSM request'));
    assert.deepStrictEqual(await ensureSecrets('production', directory), {
      created: [],
      updated: [],
      unchanged: [],
    });
    assert.deepStrictEqual(requests, []);
  });

  it('creates a missing parameter, updates a changed one and keeps an unchanged one', async () => {
    process.env.FIXTURE_DB_URL = 'postgres://fixture';
    const name = '/fixture-prod-db-url';
    mockSsm((command) => {
      if (command === GetParameterCommand.name) throw namedError('ParameterNotFound', 'not found');
      return {};
    });
    assert.deepStrictEqual(await ensureSecrets('production', directory), {
      created: [name],
      updated: [],
      unchanged: [],
    });
    mock.restoreAll();
    mockSsm((command) => (command === GetParameterCommand.name ? { Parameter: { Value: 'postgres://old' } } : {}));
    assert.deepStrictEqual(await ensureSecrets('production', directory), {
      created: [],
      updated: [name],
      unchanged: [],
    });
    mock.restoreAll();
    mockSsm(() => ({ Parameter: { Value: 'postgres://fixture' } }));
    assert.deepStrictEqual(await ensureSecrets('production', directory), {
      created: [],
      updated: [],
      unchanged: [name],
    });
    assert.deepStrictEqual(requests, [
      GetParameterCommand.name,
      PutParameterCommand.name,
      GetParameterCommand.name,
      PutParameterCommand.name,
      GetParameterCommand.name,
    ]);
  });

  for (const [operation, failing, action] of [
    ['reading', GetParameterCommand.name, 'ssm:GetParameter'],
    ['writing', PutParameterCommand.name, 'ssm:PutParameter'],
  ] as const) {
    for (const [kind, raw] of Object.entries(failures(action))) {
      it(`explains a ${kind} failure when ${operation} the parameter, without the error details`, async () => {
        process.env.FIXTURE_DB_URL = 'postgres://fixture';
        mockSsm((command) => {
          if (command === failing) throw raw;
          if (command === GetParameterCommand.name) throw namedError('ParameterNotFound', 'not found');
          return {};
        });
        const error = await ensureSecrets('production', directory).then(
          () => assert.fail('expected ensureSecrets to fail'),
          (caught: unknown) => caught,
        );
        assert.ok(error instanceof Error);
        // Callers that match the SDK error name still can; telemetry classifies it as before.
        assert.strictEqual(error.name, raw.name);
        assert.deepStrictEqual(classifyError(error), classifyError(raw));
        assert.strictEqual(error.cause, undefined);
        assert.deepStrictEqual(Object.keys(error), []);
        const message = error.message;
        const verb = operation === 'reading' ? 'read' : 'write';
        assert.match(message, new RegExp(`^.*${verb} the connection string parameter in SSM Parameter Store`));
        assert.match(message, /npm run deploy/);
        for (const identifier of IDENTIFIERS) assert.ok(!message.includes(identifier), message);
        assert.ok(!message.includes(raw.message), message);
        // Only explicit evidence names an organization policy; nothing names a spending limit,
        // suggests other credentials or policy changes as a workaround, or removes anything.
        assert.strictEqual(/AWS Organizations policy/.test(message), kind === 'organization-policy', message);
        assert.doesNotMatch(message, /spend|limit|budget|destroy|delete|AdministratorAccess|broader/i);
        if (kind === 'expired') {
          assert.match(message, /\(ExpiredTokenException\)/);
          assert.match(
            message,
            /The temporary credentials in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY have expired/,
          );
        } else if (kind === 'denied') {
          assert.match(message, /access denied \(AccessDeniedException\)/);
          assert.match(message, /The credentials do not have the permissions for this request/);
        } else if (kind === 'organization-policy') {
          assert.match(message, /access denied \(AccessDeniedException\)/);
          assert.match(message, /explicitly denies this request/);
          assert.doesNotMatch(message, /re-run/);
        } else {
          assert.match(message, /Could not reach AWS .*\(ENOTFOUND\)/);
          assert.match(message, /network or proxy settings/);
        }
      });
    }
  }

  it('rethrows other SSM errors unchanged', async () => {
    process.env.FIXTURE_DB_URL = 'postgres://fixture';
    const raw = namedError('ThrottlingException', 'Rate exceeded');
    mockSsm(() => {
      throw raw;
    });
    await assert.rejects(ensureSecrets('production', directory), (error) => error === raw);
  });
});
