// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public types + errors ────────────────────────────────────────────────────
export { __BB_CLASS__Errors } from './errors.js';
export type { __BB_CLASS__Options, ExternalTableRef } from './types.js';

import type { __BB_CLASS__Options, ExternalTableRef } from './types.js';

/**
 * See `index.mock.ts` for the authoritative JSDoc — the public behavior is
 * identical; this entry point talks to a real DynamoDB table via the AWS SDK.
 */
export class __BB_CLASS__ extends Scope {
	readonly bbName = BB_NAME;
	private docClient: DynamoDBDocumentClient;

	constructor(scope: ScopeParent, id: string, options?: __BB_CLASS__Options) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		const tableName = options?.table ? options.table.tableName : this.fullId.substring(0, 255);
		registerSdkIdentifiers(this.fullId, { tableName });
		const client = new DynamoDBClient({ customUserAgent: this.buildUserAgentChain() });
		this.docClient = DynamoDBDocumentClient.from(client);
	}

	async get(key: string): Promise<string | null> {
		const { tableName } = getSdkIdentifiers(this);
		const result = await this.docClient.send(new GetCommand({ TableName: tableName, Key: { pk: key } }));
		if (!result.Item) return null;
		return String(result.Item.value);
	}

	async put(key: string, value: string): Promise<void> {
		const { tableName } = getSdkIdentifiers(this);
		await this.docClient.send(new PutCommand({ TableName: tableName, Item: { pk: key, value } }));
	}

	async delete(key: string): Promise<void> {
		const { tableName } = getSdkIdentifiers(this);
		await this.docClient.send(new DeleteCommand({ TableName: tableName, Key: { pk: key } }));
	}

	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}
}
