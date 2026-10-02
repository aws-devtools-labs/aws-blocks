// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Encrypted key lists for bells. A bell on a table goes to every open shape on
 * it, so the changed keys are sealed with AES-256-GCM under a key derived from
 * the shape-token key: clients forward them to the shape endpoint but cannot
 * read them. The table name is authenticated, so a list cannot be replayed
 * against another table.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/** Bells must fit a WebSocket frame (32 KB); larger key lists are dropped (full reconcile). */
export const MAX_SEALED_KEYS_BYTES = 16 * 1024;

function bellKey(tokenKey: string): Buffer {
  return createHmac('sha256', tokenKey).update('aws-blocks/data/bell-keys/v1').digest();
}

/** Seal `keys` for `table`, or return `undefined` when they don't fit a bell. */
export function sealKeys(keys: string[], tokenKey: string, table: string): string | undefined {
  const plain = Buffer.from(JSON.stringify(keys));
  if (plain.length > MAX_SEALED_KEYS_BYTES) return undefined;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', bellKey(tokenKey), iv);
  cipher.setAAD(Buffer.from(table));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/** Open a sealed key list for `table`. Returns `null` if it was not sealed by this server for this table. */
export function openKeys(sealed: string, tokenKey: string, table: string): string[] | null {
  try {
    const data = Buffer.from(sealed, 'base64url');
    if (data.length < 28) return null;
    const decipher = createDecipheriv('aes-256-gcm', bellKey(tokenKey), data.subarray(0, 12));
    decipher.setAAD(Buffer.from(table));
    decipher.setAuthTag(data.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    const keys: unknown = JSON.parse(plain.toString('utf8'));
    return Array.isArray(keys) && keys.every((key) => typeof key === 'string') ? keys : null;
  } catch {
    return null;
  }
}
