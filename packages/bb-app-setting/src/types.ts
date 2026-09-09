// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for AppSetting Building Block.
 *
 * @remarks
 * This file is the canonical source for all public types and interfaces.
 * Both `index.mock.ts` and `index.aws.ts` re-export from here.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ChildLogger } from '@aws-blocks/bb-logger';

/**
 * Configuration options for creating an AppSetting.
 */
export interface AppSettingOptions<T = string> {
	/**
	 * SSM parameter path. Optional — when omitted, derived from the scope tree
	 * as `/${fullId}`, guaranteeing uniqueness within the stack.
	 *
	 * When providing an explicit name, ensure it is unique across all stacks
	 * deployed to the same AWS account to avoid collisions.
	 */
	name?: string;
	/** The value of the SSM parameter. Set during CDK deployment and can be updated at runtime via `put()`. Required for non-secret parameters. Must not be provided for secrets. */
	value?: T;
	/** Runtime validation schema. Accepts any StandardSchemaV1 implementation (Zod, Valibot, ArkType). When provided, T is inferred from the schema. */
	schema?: StandardSchemaV1<T>;
	/** When true, creates an SSM SecureString parameter. Encrypted with the default `aws/ssm` KMS key unless `kmsKeyArn` is set. */
	secret?: boolean;
	/**
	 * ARN of a **customer-managed KMS key** used to encrypt this secret's
	 * SecureString value. When omitted, SSM uses the default `aws/ssm`
	 * AWS-managed key. Use a CMK when you need to control the decrypt/grant scope
	 * (e.g. cross-account access, key rotation, or a dedicated key policy).
	 *
	 * Only valid together with `secret: true`. The CDK layer grants the shared
	 * handler `kms:Decrypt` (plus `kms:Encrypt` for stack-managed secrets it
	 * writes) on this key, and the runtime `put()` passes the key so an overwrite
	 * does not silently fall back to the default key. Changing this on an existing
	 * secret re-encrypts its current value under the new key at deploy time.
	 *
	 * @example
	 * new AppSetting(scope, 'apiKey', { secret: true, kmsKeyArn: myKey.keyArn });
	 */
	kmsKeyArn?: string;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

/**
 * Package-internal options. Not exported from the package's public entry points,
 * so `external` is never part of the public API — it is set ONLY by
 * {@link AppSetting.fromExisting} and read by the constructors. (Mirrors how
 * `KVStore`/`DistributedTable` model "existing" via a branded ref rather than a
 * public boolean.)
 */
export interface InternalAppSettingOptions<T = string> extends AppSettingOptions<T> {
	/**
	 * Marks the SSM parameter as **owned and created externally** — the construct
	 * will NOT create, seed, tag, or delete it; it only grants the app read-only
	 * access (`ssm:GetParameter`, plus `kms:Decrypt` for secrets) and registers the
	 * name for config resolution. Requires `name`, forbids `value`.
	 *
	 * Precondition: the parameter MUST already exist at deploy time — this construct
	 * does not create it, so if the external provisioner did not run (e.g. a raw
	 * `cdk deploy` that skipped `ensureSecrets`) the deploy succeeds but the app
	 * fails at runtime with `ParameterNotFound`.
	 */
	external?: boolean;
}
