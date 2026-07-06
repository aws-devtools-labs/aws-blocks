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
		const candidates = local
			? Array.isArray(local)
				? [...local, { provider: 'canned' as const }]
				: [local, { provider: 'canned' as const }]
			: [{ provider: 'canned' as const }];
		super(scope, id, config, candidates, (bucket) => new FileBucketSnapshotStorage(bucket));

		// Local streaming: register a dev-server attachment that serves this agent's SSE stream
		// (mirrors how bb-realtime registers its WebSocket dev-attachment). The route resolves
		// this instance from the registry and drives streamSSE() as text/event-stream — the same
		// contract AgentCore serves on AWS. No Realtime/AsyncJob involved.
		this.registerDevAttachment('@aws-blocks/bb-agent/dev-stream');
	}
}
