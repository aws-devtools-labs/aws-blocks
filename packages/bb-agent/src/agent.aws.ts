// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import type { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { SnapshotStorage } from '@strands-agents/sdk';
import { S3Storage } from '@strands-agents/sdk/session/s3-storage';
import type { S3StorageConfig } from '@strands-agents/sdk/session/s3-storage';
import { AgentBase } from './agent.js';
import type { AgentConfig, DefaultToolContext } from './types.js';
import { BedrockModels } from './models.js';

/**
 * Builds the deployed Agent's snapshot storage, pinning S3Storage to the Lambda
 * execution region (`AWS_REGION`) so non-us-east-1 deploys use the correct regional
 * endpoint (#120). `S3StorageImpl` is injectable so tests can assert the resulting
 * config without depending on S3Storage/AWS SDK internals; production uses the real one.
 */
export function createDeployedSnapshotStorage(
	bucket: FileBucket,
	S3StorageImpl: new (config: S3StorageConfig) => SnapshotStorage = S3Storage,
): SnapshotStorage {
	return new S3StorageImpl({ bucket: bucket.fullId, region: process.env.AWS_REGION });
}

export class Agent<TContext = DefaultToolContext> extends AgentBase<TContext> {
	constructor(scope: ScopeParent, id: string, config: AgentConfig<TContext>) {
		super(scope, id, config, config.model?.deployed ?? BedrockModels.BALANCED, createDeployedSnapshotStorage);
	}
}
