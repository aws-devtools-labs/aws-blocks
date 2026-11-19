// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-cdk-blocks/core';
import type { ScopeParent } from '@aws-cdk-blocks/core';

export interface QueueOptions {
  visibilityTimeoutSeconds?: number;
}

export class Queue extends Scope {
  public readonly sent: Array<Record<string, unknown>> = [];

  constructor(scope: ScopeParent, id: string, _options?: QueueOptions) {
    super(id, { parent: scope });
  }

  async send(payload: Record<string, unknown>) {
    this.sent.push(payload);
  }
}
