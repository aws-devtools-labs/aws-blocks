// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Annotations, type RemovalPolicy } from 'aws-cdk-lib';
import { type ITable, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import type { BlocksDefaults } from './blocks-defaults.js';
import { type KmsBlockIdentity, type KmsEncryptionOption, resolveKmsEncryption } from './kms-encryption.js';

export type { ExternalKmsKeyRef } from './kms-encryption.js';

/** The per-block durability/encryption options every Blocks DynamoDB table reads. */
export interface DynamoDbProtectionOptions {
	readonly encryption?: KmsEncryptionOption;
	readonly pointInTimeRecovery?: boolean | { retentionDays: number };
}

/**
 * The block's own identity, used only to word its synth warnings. The two
 * fields travel together so a caller cannot pair one block's prefix with
 * another's factory hint.
 */
export type DynamoDbBlockIdentity = KmsBlockIdentity;

/** The resolved DynamoDB protection, ready to spread into `new Table(...)`. */
export interface ResolvedDynamoDbProtection {
	/** Pass straight to the `Table` prop of the same name; `undefined` when PITR is off. */
	readonly pointInTimeRecoverySpecification:
		| { pointInTimeRecoveryEnabled: true; recoveryPeriodInDays?: number }
		| undefined;
	/** The `TableEncryption` mode for the `Table`. */
	readonly encryption: TableEncryption;
	/** The imported key when `fromKmsKey(arn)` was passed; `undefined` otherwise. */
	readonly encryptionKey: IKey | undefined;
	/**
	 * Call AFTER the table is created to align an auto-created CMK's removal
	 * policy with the table's. A no-op unless the table provisioned its own
	 * dedicated key (`'customer-managed'` with no imported key).
	 */
	readonly applyKeyRemovalPolicy: (table: ITable, removalPolicy: RemovalPolicy) => void;
}

/**
 * Resolve the shared DynamoDB protection knobs — point-in-time recovery and
 * encryption — that `bb-kv-store` and `bb-distributed-table` both expose. These
 * are the only two Blocks-provisioned DynamoDB tables; sharing one resolver
 * keeps their behaviour (and its warnings) from drifting apart.
 *
 * Durability (`removalPolicy` / `deletionProtection`) is intentionally NOT
 * resolved here: the two blocks surface it through different options
 * (a `removalPolicy` string vs. a `protection` three-value knob), so each
 * resolves its own and passes the result to {@link ResolvedDynamoDbProtection.applyKeyRemovalPolicy}.
 *
 * @param scope - the construct the warnings and imported key attach to.
 * @param options - the per-block `encryption` / `pointInTimeRecovery` options.
 * @param defaults - the stack-wide {@link BlocksDefaults} (preset fallbacks).
 * @param identity - the block's {@link DynamoDbBlockIdentity} for wording warnings.
 */
export function resolveDynamoDbProtection(
	scope: Construct,
	options: DynamoDbProtectionOptions | undefined,
	defaults: BlocksDefaults,
	identity: DynamoDbBlockIdentity,
): ResolvedDynamoDbProtection {
	const { warningPrefix } = identity;
	// `encryption` accepts two string literals or an ExternalKmsKeyRef
	// (a `{ __brand: 'ExternalKmsKeyRef', keyArn }` from `fromKmsKey`). The
	// shared resolver warns on anything else and falls back to 'aws-managed'.
	const kms = resolveKmsEncryption(scope, options?.encryption, identity);

	// PITR is one knob (`boolean | { retentionDays }`) resolved from the
	// per-block option, else the stack-wide `defaults.pointInTimeRecovery`
	// — production on, sandbox off. The object form both enables PITR and
	// pins the window, so "days set but PITR off" can't be expressed.
	// `retentionDays` must be 1–35; warn and drop back to the 35-day
	// default on an out-of-range value rather than failing the deploy.
	const pitrSetting = options?.pointInTimeRecovery ?? defaults.pointInTimeRecovery;
	let pitrEnabled: boolean;
	let pitrDays: number | undefined;
	if (typeof pitrSetting === 'object' && pitrSetting !== null) {
		pitrEnabled = true;
		pitrDays = pitrSetting.retentionDays;
		if (!Number.isInteger(pitrDays) || pitrDays < 1 || pitrDays > 35) {
			Annotations.of(scope).addWarningV2(
				`${warningPrefix}:InvalidPitrDays`,
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
	const encryptionKey: IKey | undefined = kms.kind === 'imported' ? kms.key : undefined;
	const encryption = kms.kind === 'aws-managed' ? TableEncryption.AWS_MANAGED : TableEncryption.CUSTOMER_MANAGED;

	return {
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
		encryptionKey,
		// An auto-created CMK (`CUSTOMER_MANAGED` with no imported key) defaults
		// to `RemovalPolicy.RETAIN`, so a table marked DESTROY would tear down
		// but leave its dedicated key behind as an orphaned, billed, rotating
		// key. Align the minted key's removal policy with the table's resolved
		// policy so the key is never less durable than the table — it's only
		// destroyed when the table is (sandbox DESTROY → DESTROY; production
		// RETAIN stays RETAIN). An imported key (`encryptionKey` set via
		// `fromKmsKey`) is owned by the caller and left untouched.
		applyKeyRemovalPolicy: (table: ITable, removalPolicy: RemovalPolicy): void => {
			if (encryption === TableEncryption.CUSTOMER_MANAGED && !encryptionKey) {
				table.encryptionKey?.applyRemovalPolicy(removalPolicy);
			}
		},
	};
}
