// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiNamespace, Scope, KVStore } from '@aws-blocks/blocks';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Queue } from '@guide/bb-queue';
import { z } from 'zod';

const scope = new Scope('extending-guide');

// ── Pattern 2a: KVStore.fromExisting ────────────────────────────────────────
// In real use, the customer would know the legacy table name at synth time
// (from another stack's outputs, an env var passed to `cdk synth`, etc.).
// Here we read it from BLOCKS_LEGACY_SESSIONS_TABLE — exported by index.cdk.ts
// before BlocksStack.create runs. A KVStore with no `key` option keys its table
// by the string attribute `_bkv_pk`, so the legacy table declares that key.
const sessions = new KVStore(scope, 'sessions', {
  table: KVStore.fromExisting(process.env.BLOCKS_LEGACY_SESSIONS_TABLE!),
});

// ── Pattern 2b: KVStore.fromExisting with a declared key ────────────────────
// Same as 2a, but the store declares a `schema` and a `key` that match the
// pre-deployed table's key schema. The schema is declared on the wrapper since
// the runtime client validates writes.
const userSchema = z.object({
  userId: z.string(),
  email: z.string(),
  createdAt: z.number(),
});
const users = new KVStore(scope, 'users', {
  schema: userSchema,
  key: { partitionKey: 'userId', sortKey: 'createdAt' },
  table: KVStore.fromExisting(process.env.BLOCKS_LEGACY_USERS_TABLE!),
});

// ── Pattern 3: custom BB ─────────────────────────────────────────────────────
const work = new Queue(scope, 'work');

// ── Pattern 1: raw CDK in Blocks (env var injected by index.cdk.ts) ─────────
const rawSqs = new SQSClient({});

export const api = new ApiNamespace(scope, 'api', () => ({
  // Pattern 1: raw SDK call
  async pattern1Enqueue(payload: Record<string, unknown>) {
    await rawSqs.send(new SendMessageCommand({
      QueueUrl: process.env.EXTERNAL_QUEUE_URL!,
      MessageBody: JSON.stringify(payload),
    }));
    return { ok: true };
  },

  // Pattern 2a: fromExisting KVStore
  async pattern2Put(token: string, value: string) {
    await sessions.put(token, value);
    return { ok: true };
  },
  async pattern2Get(token: string) {
    return { value: await sessions.get(token) };
  },

  // Pattern 2b: fromExisting KVStore with a declared key
  async pattern2bPutUser(user: { userId: string; email: string; createdAt: number }) {
    await users.put({ userId: user.userId, createdAt: user.createdAt }, user);
    return { ok: true };
  },
  async pattern2bGetUser(key: { userId: string; createdAt: number }) {
    return { user: await users.get(key) };
  },

  // Pattern 3: custom BB call
  async pattern3Enqueue(payload: Record<string, unknown>) {
    await work.send(payload);
    return { ok: true };
  },
}));
