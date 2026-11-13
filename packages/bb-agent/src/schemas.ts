// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

/** Schema for conversation metadata stored in a KVStore (Table 1). */
export const conversationSchema = z.object({
	userId: z.string(),
	conversationId: z.string(),
	name: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
});

/** Schema for messages stored in a KVStore (Table 2). */
export const messageSchema = z.object({
	conversationId: z.string(),
	messageId: z.string(),
	role: z.enum(['user', 'assistant', 'tool-call', 'tool-result', 'approval', 'interrupt']),
	content: z.string(),
	contentType: z.enum(['text', 'image', 'audio', 'video', 'document']),
	userId: z.string(),
	createdAt: z.number(),
	metadata: z.string(), // JSON: { toolName?, toolInput?, toolOutput?, usage?, latencyMs?, error?, confirmationStatus? }
});

/** Schema for AgentStreamChunk — used by Realtime namespace validation. */
export const agentStreamChunkSchema = z.object({
	type: z.enum(['text-delta', 'tool-call', 'tool-result', 'done', 'error', 'interrupt']),
	text: z.string().optional(),
	toolName: z.string().optional(),
	input: z.any().optional(),
	error: z.string().optional(),
	errorName: z.string().optional(),
	interrupts: z.array(z.object({ id: z.string(), name: z.string(), reason: z.any().optional() })).optional(),
	usage: z.object({
		inputTokens: z.number(),
		outputTokens: z.number(),
		totalTokens: z.number(),
	}).optional(),
});

/** Options of the conversation metadata store, shared by the runtime and the CDK entry points. */
export const conversationsTableOptions = {
	schema: conversationSchema,
	key: { partitionKey: 'userId', sortKey: 'conversationId' },
} as const;

/** Options of the message history store, shared by the runtime and the CDK entry points. */
export const messagesTableOptions = {
	schema: messageSchema,
	key: { partitionKey: 'conversationId', sortKey: 'messageId' },
} as const;
