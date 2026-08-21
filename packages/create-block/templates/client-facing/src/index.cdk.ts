// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table, type ITable, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Scope, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { __BB_CLASS__Options, ExternalTableRef } from './types.js';

// ── Public types + errors ────────────────────────────────────────────────────
export { __BB_CLASS__Errors } from './errors.js';
export type { __BB_CLASS__Options, ExternalTableRef } from './types.js';

export class __BB_CLASS__ extends Scope {
	private table: ITable;

	/** Reference an existing DynamoDB table instead of provisioning a new one. */
	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	constructor(scope: ScopeParent, id: string, options?: __BB_CLASS__Options) {
		super(id, { parent: scope });

		if (options?.table) {
			// `fromExisting`: bind to a pre-existing table and grant the Lambda access.
			this.table = Table.fromTableName(this, 'table', options.table.tableName);
		} else {
			const removalPolicy =
				options?.removalPolicy === 'destroy'
					? RemovalPolicy.DESTROY
					: options?.removalPolicy === 'retain'
						? RemovalPolicy.RETAIN
						: this.defaults.removalPolicy;

			this.table = new Table(this, 'table', {
				tableName: this.fullId.substring(0, 255),
				partitionKey: { name: 'pk', type: AttributeType.STRING },
				billingMode: BillingMode.PAY_PER_REQUEST,
				removalPolicy,
				deletionProtection: this.defaults.deletionProtection,
			});
		}

		this.table.grantReadWriteData(this.handler);
	}

	// Runtime methods are not available during CDK synth (AGENTS.md rule 4). Under
	// `--conditions=cdk` a __BB_CLASS__ resolves to this construct, which only
	// provisions infrastructure; these stubs turn a top-level call into an
	// actionable error instead of a cryptic "X is not a function".
	get(..._args: unknown[]): never {
		return synthGuard('__BB_CLASS__', 'get');
	}
	put(..._args: unknown[]): never {
		return synthGuard('__BB_CLASS__', 'put');
	}
	delete(..._args: unknown[]): never {
		return synthGuard('__BB_CLASS__', 'delete');
	}
}
