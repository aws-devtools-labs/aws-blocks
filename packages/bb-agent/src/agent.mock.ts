// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { AgentBase } from './agent.js';
import { FileBucketSnapshotStorage } from './file-bucket-snapshot-storage.js';
import type { AgentConfig, DefaultToolContext } from './types.js';

export class Agent<TContext = DefaultToolContext> extends AgentBase<TContext> {
	constructor(scope: ScopeParent, id: string, config: AgentConfig<TContext>) {
		// Canned provider is appended as implicit last fallback for local dev
		const local = config.model?.local;
		const candidates = local ? (Array.isArray(local) ? [...local, { provider: 'canned' as const }] : [local, { provider: 'canned' as const }]) : [{ provider: 'canned' as const }];
		super(scope, id, config, candidates, (bucket) => new FileBucketSnapshotStorage(bucket));
	}
}
