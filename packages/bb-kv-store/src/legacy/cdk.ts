// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-cdk-blocks/core';
import { BuildingBlockScope, synthGuard } from '@aws-cdk-blocks/core/cdk';
import { resolveDynamoDbProtection } from '@aws-cdk-blocks/core/cdk/internal';
import { Annotations, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, type ITable, Table } from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { LegacyKVStoreOptions } from '../types.js';
import { BB_NAME } from '../version.js';
import { RELEASE_PK, RELEASE_TTL } from './layout.js';

/**
 * The store of `KVStore` release 0.4.0 or earlier, for an upgrade.
 *
 * This construct declares the table as release 0.4.0 declares it: the same
 * name, key, billing mode, TTL setting, removal policy, deletion protection,
 * backups, and encryption, at the same construct path. The path gives the
 * logical id, so CloudFormation sees the table that it has and does not
 * change it. The app's role gets the grant of that release on the table, read
 * and write, so its policy does not change either.
 *
 * @deprecated Only for the upgrade of a store from release 0.4.0 or earlier. The class is frozen: it has
 *   the methods of release 0.4.0 and gets no new features. Use `KVStore` for new data, and remove the
 *   `LegacyKVStore` when the data is in the new store. The steps are in the README section "Upgrade from release
 *   0.4.0 or earlier":
 *   https://github.com/aws-devtools-labs/aws-blocks/blob/main/packages/bb-kv-store/README.md#upgrade-from-release-040-or-earlier
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
					'@aws-cdk-blocks/bb-kv-store:IgnoredOptionsForExistingTable',
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
				warningPrefix: '@aws-cdk-blocks/bb-kv-store',
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

		// The grant of release 0.4.0, so the policy of the role does not change.
		this.table.grantReadWriteData(this.executionRole);
	}

	// ── Runtime methods are not available during CDK synth ────────────────
	get(..._args: unknown[]): never {
		return synthGuard('LegacyKVStore', 'get');
	}
	put(..._args: unknown[]): never {
		return synthGuard('LegacyKVStore', 'put');
	}
	scan(..._args: unknown[]): never {
		return synthGuard('LegacyKVStore', 'scan');
	}
	delete(..._args: unknown[]): never {
		return synthGuard('LegacyKVStore', 'delete');
	}
}
