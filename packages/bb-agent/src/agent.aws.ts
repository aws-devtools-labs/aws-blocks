// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { AgentBase } from './agent.js';
import { S3Storage } from '@strands-agents/sdk/session/s3-storage';
import type { AgentConfig, DefaultToolContext } from './types.js';
import { BedrockModels } from './models.js';

export class Agent<TContext = DefaultToolContext> extends AgentBase<TContext> {
	constructor(scope: ScopeParent, id: string, config: AgentConfig<TContext>) {
		// Pin S3Storage to the Lambda execution region. When `region` is omitted, S3Storage
		// defaults its S3 client to us-east-1, which breaks any deploy outside us-east-1: the
		// session bucket lives in the deploy region, so snapshot reads/writes fail with a
		// cross-region 301 PermanentRedirect. AWS_REGION is always set in the Lambda runtime.
		super(scope, id, config, config.model?.deployed ?? BedrockModels.BALANCED, (bucket) => new S3Storage({ bucket: bucket.fullId, region: process.env.AWS_REGION }));
	}
}
