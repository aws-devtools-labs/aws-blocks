// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-cdk-blocks/core';
import type { ScopeParent } from '@aws-cdk-blocks/core';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

export interface QueueOptions {
  visibilityTimeoutSeconds?: number;
}

export class Queue extends Scope {
  private readonly url: string;
  private readonly client = new SQSClient({});

  constructor(scope: ScopeParent, id: string, _options?: QueueOptions) {
    super(id, { parent: scope });
    this.url = process.env[`${envSafe(this.fullId)}_URL`]!;
  }

  async send(payload: Record<string, unknown>) {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.url,
      MessageBody: JSON.stringify(payload),
    }));
  }
}

function envSafe(id: string) {
  return id.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}
