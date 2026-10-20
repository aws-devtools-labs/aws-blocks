// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table, type ITable, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Annotations, RemovalPolicy } from 'aws-cdk-lib';
import { BuildingBlockScope, synthGuard } from '@aws-blocks/core/cdk';
import { resolveDynamoDbProtection } from '@aws-blocks/core/cdk/internal';
import type { ScopeParent } from '@aws-blocks/core';
import type { KVStoreOptions, ExternalTableRef, ExternalKmsKeyRef } from './types.js';
import { TTL_ATTRIBUTE } from './ttl.js';
import { BB_NAME } from './version.js';

// Re-export public types and errors (no runtime dependencies)
export { KVStoreErrors } from './errors.js';
export type { ConditionalWriteOptions, ConditionalDeleteOptions, PutOptions, KVStoreOptions, ExternalTableRef, ExternalKmsKeyRef } from './types.js';

export class KVStore extends BuildingBlockScope {
	private table: ITable;

	/**
	 * Reference an existing DynamoDB table instead of provisioning a new one.
	 * Mirrors the same factory exposed by the runtime build so the same code
	 * works in both contexts.
	 */
	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	/**
	 * Reference an existing customer-managed KMS key to encrypt the table,
	 * instead of letting `encryption: 'customer-managed'` provision a dedicated
	 * key per table. Pass the result as the `encryption` option so several
	 * stores can share one key (and one monthly charge).
	 *
	 * @param keyArn - ARN of a KMS key you already own. Because this is an
	 *   imported key, Blocks can only attach IAM-side grants to this stack's
	 *   execution role; it cannot edit the key's own key policy. For the table
	 *   to read and write through the key, that key policy must already allow
	 *   this stack's execution role — either by naming it directly or by
	 *   delegating to account IAM (a statement granting `kms:*` to the account
	 *   root). The key must also live in the same account and region as the
	 *   table. A key policy that does neither surfaces only as an AccessDenied
	 *   when the table is first used at runtime, with no signal at deploy time.
	 */
	static fromKmsKey(keyArn: string): ExternalKmsKeyRef {
		return { __brand: 'ExternalKmsKeyRef' as const, keyArn };
	}

	constructor(scope: ScopeParent, id: string, options?: KVStoreOptions<unknown>) {
		super(id, { parent: scope, bbName: BB_NAME, vpc: { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] } });

		if (options?.table) {
			// `fromExisting`: don't provision; bind to the pre-existing table by name
			// and grant the runtime Lambda read/write access.
			//
			// Durability/encryption options don't apply to an existing table (we
			// never emit a `Table` resource to attach them to). All five of these
			// are read only in the else branch below, so each is a silent no-op
			// here. Surface that at synth so a `pointInTimeRecovery: true` on what
			// looks like a fresh table isn't a silent no-op.
			const ignoredForExisting = (['pointInTimeRecovery', 'encryption', 'removalPolicy', 'deletionProtection', 'ttl'] as const)
				.filter((key) => options[key] !== undefined);
			if (ignoredForExisting.length > 0) {
				Annotations.of(this).addWarningV2(
					'@aws-blocks/bb-kv-store:IgnoredOptionsForExistingTable',
					`Ignoring ${ignoredForExisting.join(', ')} because this table is wrapped via fromExisting() — ` +
						`the existing table owns its own durability/encryption configuration.`,
				);
			}
			this.table = Table.fromTableName(this, 'table', options.table.tableName);
		} else {
			// Resolve durability from the per-block option (a `'destroy'|'retain'`
			// string, normalized to a CDK RemovalPolicy) falling back to the
			// stack-wide `defaults`. The stack `defaults` replace the old
			// `RemovalPolicies.of(stack).destroy()` + `SandboxDisableDeletionProtection`
			// mixin dance — the sandbox posture now flows in through the chosen preset.
			const removalPolicy =
				options?.removalPolicy === 'destroy'
					? RemovalPolicy.DESTROY
					: options?.removalPolicy === 'retain'
						? RemovalPolicy.RETAIN
						: this.defaults.removalPolicy;

			// PITR + encryption are shared with bb-distributed-table; resolve them
			// through the one helper in @aws-blocks/core/cdk/internal so the two
			// blocks (the only Blocks-provisioned DynamoDB tables) can't drift.
			const protection = resolveDynamoDbProtection(this, options, this.defaults, {
				warningPrefix: '@aws-blocks/bb-kv-store',
				fromKmsKeyHint: 'KVStore.fromKmsKey',
			});

			this.table = new Table(this, 'table', {
				tableName: this.fullId.substring(0, 255),
				partitionKey: { name: 'pk', type: AttributeType.STRING },
				billingMode: BillingMode.PAY_PER_REQUEST,
				removalPolicy,
				deletionProtection: options?.deletionProtection ?? this.defaults.deletionProtection,
				// Opt-in: enabling TTL on an already-deployed table is a live table
				// update, so it must never happen implicitly.
				timeToLiveAttribute: options?.ttl ? TTL_ATTRIBUTE : undefined,
				pointInTimeRecoverySpecification: protection.pointInTimeRecoverySpecification,
				encryption: protection.encryption,
				// Only set when bringing an existing CMK; `CUSTOMER_MANAGED` without a
				// key lets CDK provision a dedicated one.
				encryptionKey: protection.encryptionKey,
			});

			// Align an auto-created CMK's removal policy with the table's so the
			// key is never less durable than the table it encrypts.
			protection.applyKeyRemovalPolicy(this.table, removalPolicy);
		}

		this.table.grantReadWriteData(this.executionRole);
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
}
