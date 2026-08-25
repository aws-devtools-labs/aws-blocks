// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { Realtime } from '@aws-blocks/bb-realtime';
import { AsyncJob } from '@aws-blocks/bb-async-job';
import { FileBucket } from '@aws-blocks/bb-file-bucket';
import { messageSchema, conversationSchema, agentStreamChunkSchema } from './schemas.js';
import { INTERACTIVE_JOB_EVENT_SOURCE } from './job-event-source.js';
import { z } from 'zod';

export { AgentErrors } from './errors.js';
export { BedrockModels, OllamaModels } from './models.js';

const jobPayloadSchema = z.object({
	message: z.string(),
	conversationId: z.string().optional(),
});

export class Agent extends Scope {
	/**
	 * CDK layer for the Agent BB.
	 * Mirrors the runtime's BB creation so CDK discovers and provisions all resources.
	 *
	 * TODO: scope Bedrock IAM grant to specific modelId from config
	 * TODO: guardrails CDK provisioning
	 */
	constructor(scope: ScopeParent, id: string, config?: any) {
		super(id, { parent: scope });

		this.executionRole.addToPrincipalPolicy(new PolicyStatement({
			actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:GetFoundationModel', 'bedrock:ListFoundationModels', 'bedrock:GetInferenceProfile'],
			resources: [
				'arn:aws:bedrock:*::foundation-model/*',
				'arn:aws:bedrock:*:*:inference-profile/*',
			],
		}));

		// Propagate `removalPolicy` to the sessions bucket so customers can
		// opt sandbox stacks into clean teardown. Without it, CDK's RETAIN
		// default applies (production-safe) and `cdk destroy` will fail on
		// a non-empty bucket — same pattern as FileBucket / KnowledgeBase.
		// ID shortened to keep S3 bucket names within the 63-char limit
		new FileBucket(this, 'sn', { removalPolicy: config?.removalPolicy });

		if (!config?.inferenceOnly) {
			new DistributedTable(this, 'convos', {
				schema: conversationSchema,
				key: { partitionKey: 'userId', sortKey: 'conversationId' },
			});
			new DistributedTable(this, 'messages', {
				schema: messageSchema,
				key: { partitionKey: 'conversationId', sortKey: 'messageId' },
			});
		}

		new Realtime(this, 'rt', {
			namespaces: {
				chunks: { schema: agentStreamChunkSchema },
			},
		});

		new AsyncJob(this, 'job', {
			schema: jobPayloadSchema,
			...INTERACTIVE_JOB_EVENT_SOURCE,
			handler: async () => {},
		});
	}
}
