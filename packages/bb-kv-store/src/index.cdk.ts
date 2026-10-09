// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table, type ITable, AttributeType, BillingMode, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Annotations, RemovalPolicy } from 'aws-cdk-lib';
import { Key, type IKey } from 'aws-cdk-lib/aws-kms';
import { BuildingBlockScope, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { KVStoreOptions, ExternalTableRef, ExternalKmsKeyRef } from './types.js';
import { TTL_ATTRIBUTE } from './ttl.js';

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
		super(id, { parent: scope, vpc: { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] } });

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

			// `encryption` accepts two string literals or an ExternalKmsKeyRef
			// (a `{ __brand: 'ExternalKmsKeyRef', keyArn }` from `fromKmsKey`).
			// Anything else is a typo — warn rather than silently using the default.
			// Captured into a local const so the `isKmsKeyRef` discriminant below
			// narrows it (aliased-condition narrowing doesn't reach through the
			// optional `options?.encryption` access).
			const encryptionOption = options?.encryption;
			const isKmsKeyRef = typeof encryptionOption === 'object'
				&& encryptionOption !== null
				&& encryptionOption.__brand === 'ExternalKmsKeyRef';
			if (
				options?.encryption !== undefined
				&& options.encryption !== 'aws-managed'
				&& options.encryption !== 'customer-managed'
				&& !isKmsKeyRef
			) {
				Annotations.of(this).addWarningV2(
					'@aws-blocks/bb-kv-store:UnknownEncryption',
					`Unrecognized encryption '${String(options.encryption)}' (expected 'aws-managed', ` +
						`'customer-managed', or KVStore.fromKmsKey(arn)) — falling back to 'aws-managed'.`,
				);
			}

			// PITR is one knob (`boolean | { retentionDays }`) resolved from the
			// per-block option, else the stack-wide `defaults.pointInTimeRecovery`
			// — production on, sandbox off. The object form both enables PITR and
			// pins the window, so "days set but PITR off" can't be expressed.
			// `retentionDays` must be 1–35; warn and drop back to the 35-day
			// default on an out-of-range value rather than failing the deploy.
			const pitrSetting = options?.pointInTimeRecovery ?? this.defaults.pointInTimeRecovery;
			let pitrEnabled: boolean;
			let pitrDays: number | undefined;
			if (typeof pitrSetting === 'object' && pitrSetting !== null) {
				pitrEnabled = true;
				pitrDays = pitrSetting.retentionDays;
				if (!Number.isInteger(pitrDays) || pitrDays < 1 || pitrDays > 35) {
					Annotations.of(this).addWarningV2(
						'@aws-blocks/bb-kv-store:InvalidPitrDays',
						`pointInTimeRecovery.retentionDays must be an integer between 1 and 35 (got ${String(pitrDays)}) — ` +
							`falling back to the 35-day default.`,
					);
					pitrDays = undefined;
				}
			} else {
				pitrEnabled = pitrSetting === true;
				pitrDays = undefined;
			}

			// `fromKmsKey(arn)` → encrypt with an existing CMK (shareable across
			// tables). `'customer-managed'` → CDK provisions a fresh dedicated CMK.
			// Otherwise the AWS-managed `aws/dynamodb` key.
			let encryptionKey: IKey | undefined;
			let encryption: TableEncryption;
			if (isKmsKeyRef) {
				encryption = TableEncryption.CUSTOMER_MANAGED;
				encryptionKey = Key.fromKeyArn(this, 'encryption-key', encryptionOption.keyArn);
			} else if (options?.encryption === 'customer-managed') {
				encryption = TableEncryption.CUSTOMER_MANAGED;
			} else {
				encryption = TableEncryption.AWS_MANAGED;
			}

			this.table = new Table(this, 'table', {
				tableName: this.fullId.substring(0, 255),
				partitionKey: { name: 'pk', type: AttributeType.STRING },
				billingMode: BillingMode.PAY_PER_REQUEST,
				removalPolicy,
				deletionProtection: options?.deletionProtection ?? this.defaults.deletionProtection,
				// Opt-in: enabling TTL on an already-deployed table is a live table
				// update, so it must never happen implicitly.
				timeToLiveAttribute: options?.ttl ? TTL_ATTRIBUTE : undefined,
				// PITR spec is only emitted when enabled — leaving it undefined keeps
				// the CloudFormation template clean for sandboxes / opt-outs.
				// recoveryPeriodInDays is only set when the caller narrows it (an
				// omitted value keeps DynamoDB's 35-day default without emitting it).
				pointInTimeRecoverySpecification: pitrEnabled
					? {
						pointInTimeRecoveryEnabled: true,
						...(pitrDays !== undefined ? { recoveryPeriodInDays: pitrDays } : {}),
					}
					: undefined,
				encryption,
				// Only set when bringing an existing CMK; `CUSTOMER_MANAGED` without a
				// key lets CDK provision a dedicated one.
				encryptionKey,
			});

			// An auto-created CMK (`CUSTOMER_MANAGED` with no imported key) defaults
			// to `RemovalPolicy.RETAIN`, so a sandbox table marked DESTROY would
			// tear down but leave its dedicated key behind. Align the minted key's
			// removal policy with the table's resolved policy so the key is never
			// less durable than the table — it's only destroyed when the table is
			// (sandbox DESTROY → DESTROY; production RETAIN stays RETAIN). An
			// imported key (`encryptionKey` set via `fromKmsKey`) is owned by the
			// caller and left untouched.
			if (encryption === TableEncryption.CUSTOMER_MANAGED && !encryptionKey) {
				this.table.encryptionKey?.applyRemovalPolicy(removalPolicy);
			}
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
