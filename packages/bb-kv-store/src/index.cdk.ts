// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table, type ITable, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Scope, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { KVStoreOptions, ExternalTableRef } from './types.js';

// Re-export public types and errors (no runtime dependencies)
export { KVStoreErrors } from './errors.js';
export type { ConditionalWriteOptions, ConditionalDeleteOptions, KVStoreOptions, ExternalTableRef } from './types.js';

export class KVStore extends Scope {
	private table: ITable;

	/**
	 * Reference an existing DynamoDB table instead of provisioning a new one.
	 * Mirrors the same factory exposed by the runtime build so the same code
	 * works in both contexts.
	 */
	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	constructor(scope: ScopeParent, id: string, options?: KVStoreOptions<unknown>) {
		super(id, { parent: scope });

		if (options?.table) {
			// `fromExisting`: don't provision; bind to the pre-existing table by name
			// and grant the runtime Lambda read/write access.
			this.table = Table.fromTableName(this, 'table', options.table.tableName);
		} else {
			this.table = new Table(this, 'table', {
				tableName: this.fullId.substring(0, 255),
				partitionKey: { name: 'pk', type: AttributeType.STRING },
				billingMode: BillingMode.PAY_PER_REQUEST,
				// Default: CDK's RETAIN (undefined here). Customers opt into teardown
				// via `{ removalPolicy: 'destroy' }`. Templates that apply
				// `RemovalPolicies.of(stack).destroy()` under `sandboxMode` will
				// override this at the stack layer regardless.
				removalPolicy: options?.removalPolicy === 'destroy'
					? RemovalPolicy.DESTROY
					: options?.removalPolicy === 'retain'
						? RemovalPolicy.RETAIN
						: undefined,
			});
		}

		this.table.grantReadWriteData(this.handler);
	}

	// ── Runtime methods are not available during CDK synth ────────────────
	// Under `--conditions=cdk` a KVStore resolves to this construct, which only
	// provisions infrastructure. The data methods (get/put/delete/scan) live in
	// the runtime build. Calling them at module top-level (which runs during
	// synth) would otherwise fail with a cryptic `X is not a function`; these
	// stubs turn that into an actionable message.
	get(..._args: unknown[]): never { return synthGuard('KVStore', 'get'); }
	put(..._args: unknown[]): never { return synthGuard('KVStore', 'put'); }
	delete(..._args: unknown[]): never { return synthGuard('KVStore', 'delete'); }
	scan(..._args: unknown[]): never { return synthGuard('KVStore', 'scan'); }
	toAgentTools(..._args: unknown[]): never { return synthGuard('KVStore', 'toAgentTools'); }
}
