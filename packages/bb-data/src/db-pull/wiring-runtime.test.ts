// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { WIRING_RESOLVE_SSL_FN } from './templates.js';

/**
 * The generated wiring is emitted as a TypeScript *string* and only ever
 * type-checked (via the db-pull-typecheck app), never executed in our suite. To
 * actually exercise the security-critical branches of the emitted
 * `resolveDbSsl()` — most importantly the deployed-Lambda fail-closed path — we
 * transpile the snippet to JS and run it with injected dependencies.
 */
function buildResolveDbSsl(opts: {
  committedCa: string;
  env: Record<string, string | undefined>;
  files?: Record<string, string>;
}): () => { ca?: string; rejectUnauthorized: boolean } {
  const js = ts.transpileModule(WIRING_RESOLVE_SSL_FN, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

  const readFileSync = (p: string): string => {
    const f = opts.files?.[p];
    if (f === undefined) {
      const err = new Error(`ENOENT: no such file, open '${p}'`);
      throw err;
    }
    return f;
  };
  const fakeProcess = { env: opts.env } as unknown as NodeJS.Process;
  const silentConsole = { log() {}, warn() {} } as unknown as Console;

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'readFileSync',
    'DATABASE_CA_CERT',
    'process',
    'console',
    `${js}\n;return resolveDbSsl;`,
  );
  return factory(readFileSync, opts.committedCa, fakeProcess, silentConsole);
}

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBexample\n-----END CERTIFICATE-----';

describe('generated resolveDbSsl() runtime behavior', () => {
  test('deployed Lambda with no CA → fails closed (throws)', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: '',
      env: { AWS_LAMBDA_FUNCTION_NAME: 'my-fn' },
    });
    assert.throws(() => resolveDbSsl(), /refusing to connect without verifying/);
  });

  test('local dev with no CA → encrypted but unverified (no throw)', () => {
    const resolveDbSsl = buildResolveDbSsl({ committedCa: '', env: {} });
    assert.deepStrictEqual(resolveDbSsl(), { rejectUnauthorized: false });
  });

  test('committed database.ca.ts cert → pins CA and verifies (works in Lambda)', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: PEM,
      env: { AWS_LAMBDA_FUNCTION_NAME: 'my-fn' },
    });
    assert.deepStrictEqual(resolveDbSsl(), { ca: PEM, rejectUnauthorized: true });
  });

  test('DATABASE_CA_CERT inline PEM overrides the committed cert', () => {
    const override = '-----BEGIN CERTIFICATE-----\nOVERRIDE\n-----END CERTIFICATE-----';
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: PEM,
      env: { DATABASE_CA_CERT: override },
    });
    assert.deepStrictEqual(resolveDbSsl(), { ca: override, rejectUnauthorized: true });
  });

  test('DATABASE_CA_CERT as a file path reads and pins the cert', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: '',
      env: { DATABASE_CA_CERT: '/etc/ssl/prod-ca-2021.crt' },
      files: { '/etc/ssl/prod-ca-2021.crt': PEM },
    });
    assert.deepStrictEqual(resolveDbSsl(), { ca: PEM, rejectUnauthorized: true });
  });

  test('DATABASE_CA_CERT pointing at a missing file → clear TLS error', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: '',
      env: { DATABASE_CA_CERT: '/nope/missing.crt' },
    });
    assert.throws(() => resolveDbSsl(), /could not read the CA/);
  });

  test('DATABASE_CA_CERT file that is not a certificate → rejected', () => {
    const resolveDbSsl = buildResolveDbSsl({
      committedCa: '',
      env: { DATABASE_CA_CERT: '/etc/ssl/notacert.txt' },
      files: { '/etc/ssl/notacert.txt': 'not a pem' },
    });
    assert.throws(() => resolveDbSsl(), /not a PEM certificate/);
  });
});
