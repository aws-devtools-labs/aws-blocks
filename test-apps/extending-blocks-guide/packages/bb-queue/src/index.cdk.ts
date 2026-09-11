// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Duration } from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Scope, registerConfig } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';

export interface QueueOptions {
  visibilityTimeoutSeconds?: number;
}

export class Queue extends Scope {
  constructor(scope: ScopeParent, id: string, options?: QueueOptions) {
    super(id, { parent: scope });

    const queue = new sqs.Queue(this, 'queue', {
      visibilityTimeout: options?.visibilityTimeoutSeconds
        ? Duration.seconds(options.visibilityTimeoutSeconds)
        : undefined,
    });

    queue.grantSendMessages(this.handler);
    registerConfig(this, `${envSafe(this.fullId)}_URL`, queue.queueUrl);
  }
}

function envSafe(id: string) {
  return id.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
}
