// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { AgentBase } from './agent.js';
import { S3Storage } from '@strands-agents/sdk/session/s3-storage';
import type { AgentConfig, DefaultToolContext } from './types.js';
import { BedrockModels } from './models.js';

export class Agent<TContext = DefaultToolContext> extends AgentBase<TContext> {
	constructor(scope: ScopeParent, id: string, config: AgentConfig<TContext>) {
		super(scope, id, config, config.model?.deployed ?? BedrockModels.BALANCED, (bucket) => new S3Storage({ bucket: bucket.fullId }));
	}
}
