// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalDbSsl } from './external-ssl.js';

const ORIGINAL_CA = process.env.DATABASE_CA_CERT;
const ORIGINAL_CI = process.env.CI;
function restore() {
  if (ORIGINAL_CA === undefined) delete process.env.DATABASE_CA_CERT;
  else process.env.DATABASE_CA_CERT = ORIGINAL_CA;
  if (ORIGINAL_CI === undefined) delete process.env.CI;
  else process.env.CI = ORIGINAL_CI;
}

test('externalDbSsl: no CA, interactive run → encrypted but unverified', () => {
  delete process.env.DATABASE_CA_CERT;
  delete process.env.CI;
  try {
    assert.deepStrictEqual(externalDbSsl(), { rejectUnauthorized: false });
  } finally {
    restore();
  }
});

test('externalDbSsl: no CA in a non-interactive run → fails closed', () => {
  delete process.env.DATABASE_CA_CERT;
  process.env.CI = 'true';
  try {
    assert.throws(() => externalDbSsl(), /no CA certificate available/);
  } finally {
    restore();
  }
});

test('externalDbSsl: no CA in CI but allowUnverifiedInCi → unverified fallback', () => {
  // First-pull introspection runs before a CA is captured, so it opts in.
  delete process.env.DATABASE_CA_CERT;
  process.env.CI = 'true';
  try {
    assert.deepStrictEqual(externalDbSsl({ allowUnverifiedInCi: true }), { rejectUnauthorized: false });
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

test('externalDbSsl: missing CA file → clear TLS error, not a bare ENOENT', () => {
  process.env.DATABASE_CA_CERT = join(tmpdir(), 'does-not-exist-bb-data.crt');
  try {
    assert.throws(() => externalDbSsl(), /could not read the CA certificate/);
  } finally {
    restore();
  }
});

test('externalDbSsl: CA file present but not a certificate → rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-data-ca-'));
  const file = join(dir, 'not-a-cert.txt');
  writeFileSync(file, 'just some text, no PEM here');
  process.env.DATABASE_CA_CERT = file;
  try {
    assert.throws(() => externalDbSsl(), /not a PEM\s+certificate|missing "-----BEGIN CERTIFICATE-----"/);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
