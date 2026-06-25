// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalDbSsl } from './external-ssl.js';

const ORIGINAL = process.env.DATABASE_CA_CERT;
function restore() {
  if (ORIGINAL === undefined) delete process.env.DATABASE_CA_CERT;
  else process.env.DATABASE_CA_CERT = ORIGINAL;
}

test('externalDbSsl: no DATABASE_CA_CERT → encrypted but unverified', () => {
  delete process.env.DATABASE_CA_CERT;
  try {
    assert.deepStrictEqual(externalDbSsl(), { rejectUnauthorized: false });
  } finally {
    restore();
  }
});

test('externalDbSsl: inline PEM → pins CA and verifies', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----';
  process.env.DATABASE_CA_CERT = pem;
  try {
    assert.deepStrictEqual(externalDbSsl(), { ca: pem, rejectUnauthorized: true });
  } finally {
    restore();
  }
});

test('externalDbSsl: file path → reads CA from disk and verifies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-data-ca-'));
  const file = join(dir, 'prod-ca-2021.crt');
  const pem = '-----BEGIN CERTIFICATE-----\nFROMFILE\n-----END CERTIFICATE-----';
  writeFileSync(file, pem);
  process.env.DATABASE_CA_CERT = file;
  try {
    assert.deepStrictEqual(externalDbSsl(), { ca: pem, rejectUnauthorized: true });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
