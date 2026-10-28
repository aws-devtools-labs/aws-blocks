// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Annotations } from 'aws-cdk-lib';
import { Key, type IKey } from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

/**
 * A reference to an existing customer-managed KMS key, produced by a block's
 * `fromKmsKey(arn)` factory. Pass it as the `encryption` option to encrypt the
 * resource with a CMK you already own — letting several resources share one key
 * instead of each provisioning its own dedicated key.
 */
export interface ExternalKmsKeyRef {
	readonly __brand: 'ExternalKmsKeyRef';
	readonly keyArn: string;
}

/** The per-block `encryption` option every Blocks-provisioned storage resource accepts. */
export type KmsEncryptionOption = 'aws-managed' | 'customer-managed' | ExternalKmsKeyRef;

/**
 * The block's own identity, used only to word its synth warnings. The two
 * fields travel together so a caller cannot pair one block's prefix with
 * another's factory hint.
 */
export interface KmsBlockIdentity {
	/** The block's npm name, used as the annotation ID prefix (e.g. `@aws-blocks/bb-kv-store`). */
	readonly warningPrefix: string;
	/** The block's factory name shown in the unrecognized-encryption warning (e.g. `KVStore.fromKmsKey`). */
	readonly fromKmsKeyHint: string;
}

/**
 * The resolved encryption choice, independent of the storage service:
 * - `aws-managed` — the service's AWS-managed/owned key (the default).
 * - `customer-managed` — the caller provisions a dedicated CMK for this resource.
 * - `imported` — an existing CMK from `fromKmsKey(arn)`, already imported as `key`.
 */
export type ResolvedKmsEncryption =
	| { readonly kind: 'aws-managed' }
	| { readonly kind: 'customer-managed' }
	| { readonly kind: 'imported'; readonly key: IKey };

/**
 * Resolve a block's `encryption` option into a service-agnostic choice. Shared
 * by every Blocks storage resource that exposes `encryption`
 * (`bb-kv-store`, `bb-distributed-table`, `bb-file-bucket`) so the accepted
 * values and the unrecognized-value warning cannot drift between them. Each
 * caller maps the result onto its own service's encryption props.
 *
 * An unrecognized value (a typo, or a hand-built object without the brand)
 * warns and falls back to `'aws-managed'` rather than failing the synth.
 *
 * @param scope - the construct the warning and imported key attach to.
 * @param option - the per-block `encryption` option.
 * @param identity - the block's {@link KmsBlockIdentity} for wording the warning.
 */
export function resolveKmsEncryption(
	scope: Construct,
	option: KmsEncryptionOption | undefined,
	identity: KmsBlockIdentity,
): ResolvedKmsEncryption {
	const isKmsKeyRef = typeof option === 'object'
		&& option !== null
		&& option.__brand === 'ExternalKmsKeyRef';
	if (isKmsKeyRef) {
		return { kind: 'imported', key: Key.fromKeyArn(scope, 'encryption-key', option.keyArn) };
	}
	if (option === 'customer-managed') return { kind: 'customer-managed' };
	if (option !== undefined && option !== 'aws-managed') {
		Annotations.of(scope).addWarningV2(
			`${identity.warningPrefix}:UnknownEncryption`,
			`Unrecognized encryption '${String(option)}' (expected 'aws-managed', ` +
				`'customer-managed', or ${identity.fromKmsKeyHint}(arn)) — falling back to 'aws-managed'.`,
		);
	}
	return { kind: 'aws-managed' };
}
