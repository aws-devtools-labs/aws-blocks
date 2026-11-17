// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, synthGuard } from '@aws-blocks/core/cdk';
import { resolveDynamoDbProtection } from '@aws-blocks/core/cdk/internal';
import { Annotations, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, type ITable, Table } from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { LegacyKVStoreOptions } from '../types.js';
import { BB_NAME } from '../version.js';
import { RELEASE_PK, RELEASE_TTL } from './layout.js';

/**
 * The store of a `KVStore` release up to 0.4.0, for an upgrade.
 *
 * This construct declares the table as release 0.4.0 declares it: the same
 * name, key, billing mode, TTL setting, removal policy, deletion protection,
 * backups, and encryption, at the same construct path. The path gives the
 * logical id, so CloudFormation sees the table that it has and does not
 * change it. The app's role gets read and delete access to the table, and no
 * write access.
 */
export class LegacyKVStore extends BuildingBlockScope {
	private table: ITable;

	constructor(scope: ScopeParent, id: string, options?: LegacyKVStoreOptions<unknown>) {
		super(id, {
			parent: scope,
			bbName: BB_NAME,
			vpc: { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] },
		});

		if (options?.table) {
			// The old store wrapped a table that it did not create. The options of
			// a table do not apply to it, as in the release.
			const ignoredForExisting = (
				['pointInTimeRecovery', 'encryption', 'removalPolicy', 'deletionProtection', 'ttl'] as const
			).filter((key) => options[key] !== undefined);
			if (ignoredForExisting.length > 0) {
				Annotations.of(this).addWarningV2(
					'@aws-blocks/bb-kv-store:IgnoredOptionsForExistingTable',
					`Ignoring ${ignoredForExisting.join(', ')} because this table is wrapped via fromExisting() — ` +
						`the existing table owns its own durability/encryption configuration.`,
				);
			}
			this.table = Table.fromTableName(this, 'table', options.table.tableName);
		} else {
			// Every property below is the property that release 0.4.0 gives the
			// table. A difference would make CloudFormation change the table.
			const removalPolicy =
				options?.removalPolicy === 'destroy'
					? RemovalPolicy.DESTROY
					: options?.removalPolicy === 'retain'
						? RemovalPolicy.RETAIN
						: this.defaults.removalPolicy;
			const protection = resolveDynamoDbProtection(this, options, this.defaults, {
				warningPrefix: '@aws-blocks/bb-kv-store',
				fromKmsKeyHint: 'KVStore.fromKmsKey',
			});
			this.table = new Table(this, 'table', {
				tableName: this.fullId.substring(0, 255),
				partitionKey: { name: RELEASE_PK, type: AttributeType.STRING },
				billingMode: BillingMode.PAY_PER_REQUEST,
				removalPolicy,
				deletionProtection: options?.deletionProtection ?? this.defaults.deletionProtection,
				timeToLiveAttribute: options?.ttl ? RELEASE_TTL : undefined,
				pointInTimeRecoverySpecification: protection.pointInTimeRecoverySpecification,
				encryption: protection.encryption,
				encryptionKey: protection.encryptionKey,
			});
			protection.applyKeyRemovalPolicy(this.table, removalPolicy);
		}

		// Read, and delete by key. No put and no update: the app writes the new store.
		this.table.grantReadData(this.executionRole);
		this.table.grant(this.executionRole, 'dynamodb:DeleteItem');
	}

	// ── Runtime methods are not available during CDK synth ────────────────
	get(..._args: unknown[]): never {
		return synthGuard('LegacyKVStore', 'get');
	}
	scan(..._args: unknown[]): never {
		return synthGuard('LegacyKVStore', 'scan');
	}
	delete(..._args: unknown[]): never {
		return synthGuard('LegacyKVStore', 'delete');
	}
}
