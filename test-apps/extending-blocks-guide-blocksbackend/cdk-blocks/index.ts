// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiNamespace, Scope } from '@aws-blocks/blocks';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const scope = new Scope('blocksbackend-guide');

const sqsClient = new SQSClient({});

export const api = new ApiNamespace(scope, 'api', () => ({
  // Pattern 1 via BlocksBackend: same shape as via BlocksStack — handler
  // env vars are wired by the user-owned outer stack.
  async pattern1Enqueue(payload: Record<string, unknown>) {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: process.env.EXTERNAL_QUEUE_URL!,
      MessageBody: JSON.stringify(payload),
    }));
    return { ok: true };
  },

  async health() {
    return { ok: true, via: 'BlocksBackend' };
  },
}));
