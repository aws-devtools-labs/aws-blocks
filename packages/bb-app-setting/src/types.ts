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

// ── copyFrom: deploy-time value source ──────────────────────────────────────

/** @internal Brand for {@link CopyFromSource}. Not part of the public API. */
const COPY_FROM_BRAND = Symbol.for('@aws-blocks/bb-app-setting.copyFrom');

/**
 * A deploy-time **source** for an AppSetting value, produced by {@link copyFrom}.
 *
 * Unlike a literal `value` (which would land in the CloudFormation template and
 * be readable via `GetTemplate`), a `CopyFromSource` carries only a *reference*
 * to a staging SSM parameter. At deploy time an in-stack custom resource reads
 * that staging parameter and copies its value into the final, stack-scoped
 * parameter — inside the CloudFormation transaction, so it rolls back with the
 * stack and the value never enters the template.
 *
 * @see copyFrom
 */
export interface CopyFromSource<T = string> {
	/** @internal */
	readonly [COPY_FROM_BRAND]: true;
	/** Name of the staging SSM parameter to copy the value from at deploy time. */
	readonly stagingParameterName: string;
	/** Phantom marker so the source is typed against the setting's value type. */
	readonly __valueType?: T;
}

/**
 * Seed an AppSetting's value at deploy time by copying it from a **staging SSM
 * parameter**, rather than passing a literal value.
 *
 * The orchestrator (`deploy` / `sandbox`) mints a unique, throwaway staging
 * parameter name, writes the user-provided value to it before synth, and passes
 * the *name* (never the value) into the CDK app. `copyFrom(name)` records that
 * reference on the setting; the CDK construct then provisions a custom resource
 * that copies staging → final during deployment and deletes the staging
 * parameter afterwards.
 *
 * The staging name MUST be minted once and passed explicitly (e.g. via an env
 * var or CDK context) — it must never be derived from the value itself, so the
 * write side and the read side can never diverge.
 *
 * @example
 * // synth path of generated wiring (name comes from the deploy orchestrator):
 * new AppSetting(scope, 'db-url', { secret: true, value: copyFrom(process.env.BLOCKS_DB_STAGING_PARAM!) });
 */
export function copyFrom<T = string>(stagingParameterName: string): CopyFromSource<T> {
	if (!stagingParameterName) {
		throw new Error(
			'copyFrom: a staging SSM parameter name is required. It must be minted once ' +
			'by the deploy orchestrator and passed in explicitly — never derived from the value.',
		);
	}
	return { [COPY_FROM_BRAND]: true, stagingParameterName };
}

/** @internal Type guard for {@link CopyFromSource}. Not part of the public API. */
export function isCopyFromSource(value: unknown): value is CopyFromSource {
	return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[COPY_FROM_BRAND] === true;
}

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
	/**
	 * The value of the SSM parameter.
	 *
	 * - A literal value is set during CDK deployment and can be updated at
	 *   runtime via `put()`. Required for non-secret parameters; must not be
	 *   provided for secrets (a literal secret would land in the template).
	 * - A {@link CopyFromSource} (from {@link copyFrom}) seeds the value at deploy
	 *   time from a staging parameter without exposing it in the template. This
	 *   is the only form of `value` permitted for secrets.
	 */
	value?: T | CopyFromSource<T>;
	/** Runtime validation schema. Accepts any StandardSchemaV1 implementation (Zod, Valibot, ArkType). When provided, T is inferred from the schema. */
	schema?: StandardSchemaV1<T>;
	/** When true, creates an SSM SecureString parameter encrypted with the default aws/ssm KMS key. */
	secret?: boolean;
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
	 * `cdk deploy` that skipped the out-of-band writer) the deploy succeeds but the
	 * app fails at runtime with `ParameterNotFound`.
	 */
	external?: boolean;
}
