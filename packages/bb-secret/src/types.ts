// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildLogger } from '@aws-blocks/bb-logger';
/**
 * Shared types for the Secret Building Block.
 *
 * @remarks
 * This file is the canonical source for all public types and interfaces and has
 * zero runtime dependencies — types only (`import type` only; no const/function/
 * class). Both `index.mock.ts` and `index.aws.ts` re-export from here.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Configuration options for creating a {@link Secret}.
 */
export interface SecretOptions<T = string> {
	/**
	 * AWS Secrets Manager secret name. Optional — when omitted, the name is
	 * derived from the scope tree as the instance's `fullId`, guaranteeing
	 * uniqueness within the stack.
	 *
	 * Provide an explicit, well-known name when a team or CI/CD pipeline needs a
	 * stable, predictable target to set/rotate the value out-of-band (e.g.
	 * `aws secretsmanager put-secret-value --secret-id <name>`). When you set an
	 * explicit name, **you** are responsible for ensuring it is unique across all
	 * stacks deployed to the same AWS account and region.
	 *
	 * Ignored when wrapping an existing secret via {@link Secret.fromExisting}
	 * (the referenced secret already has its own name/ARN).
	 */
	name?: string;
	/**
	 * Runtime validation schema for the secret value. Accepts any
	 * StandardSchemaV1 implementation (Zod, Valibot, ArkType). When provided, the
	 * type parameter `T` is inferred from the schema, the stored value is treated
	 * as JSON, and `get()`/`put()` parse/serialize + validate against it.
	 *
	 * When omitted, the secret is an opaque `string`.
	 */
	schema?: StandardSchemaV1<T>;
	/**
	 * Wrap an existing AWS Secrets Manager secret instead of creating one. Obtain
	 * a reference from {@link Secret.fromExisting}. The Building Block will not
	 * create, seed, or delete infrastructure for this secret — it only reads and
	 * writes the value at runtime and (in the CDK layer) grants access to it.
	 */
	secret?: ExternalSecretRef;
	/**
	 * Removal behavior (via CDK/CloudFormation) for the underlying Secrets Manager
	 * secret. When omitted, the stack-wide `defaults` apply (`production` retains
	 * the secret on `cdk destroy`, `sandbox` destroys it). Pass `'destroy'` or
	 * `'retain'` to override for this one secret.
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to retain) and
	 * when wrapping an existing secret via {@link Secret.fromExisting}.
	 */
	removalPolicy?: 'destroy' | 'retain';
	/**
	 * Optional logger for internal Secret operations. Accepts a `Logger` instance
	 * or any `ChildLogger` from `@aws-blocks/bb-logger`.
	 *
	 * When omitted, a default Logger at error level is created (silent during
	 * normal operation, only emits on errors).
	 */
	logger?: ChildLogger;
}

/**
 * A lightweight, branded reference to an AWS Secrets Manager secret that is
 * created and owned **outside** this Building Block. Returned by
 * {@link Secret.fromExisting} and passed to the constructor via
 * {@link SecretOptions.secret}. It is a reference object (a constructor input),
 * not a constructed Building Block.
 */
export interface ExternalSecretRef {
	readonly __brand: 'ExternalSecretRef';
	/** The ARN of the existing Secrets Manager secret. */
	readonly secretArn: string;
}

/**
 * The minimal handle identifying a specific stored version of a secret —
 * everything `get({ version })` needs to fetch it, and nothing more.
 *
 * You never construct one by hand or type a raw version id: obtain a
 * {@link SecretVersionInfo} from {@link Secret.listVersions} and pass it to
 * {@link Secret.get}, or use the `'current'` / `'previous'` shorthands.
 */
export interface SecretVersion {
	/** Opaque version identifier. Meaningful only as a handle back to `get()`. */
	readonly versionId: string;
}

/**
 * A version as returned by {@link Secret.listVersions} — a {@link SecretVersion}
 * handle plus the discovery metadata needed to choose among versions. Because it
 * extends {@link SecretVersion}, a value returned by `listVersions()` can be
 * passed straight to `get({ version })`.
 */
export interface SecretVersionInfo extends SecretVersion {
	/**
	 * Staging labels attached to this version. AWS maintains `['AWSCURRENT']` for
	 * the live value and `['AWSPREVIOUS']` for the value before the last change;
	 * a version with no label (superseded, awaiting pruning) has `[]`.
	 */
	readonly stages: string[];
	/** When this version was created. */
	readonly createdDate: Date;
}

/**
 * Options for {@link Secret.get}.
 */
export interface SecretReadOptions {
	/**
	 * Which version to read:
	 * - `'current'` (default) — the live value.
	 * - `'previous'` — the value before the most recent change. Useful for a
	 *   rotation grace window (e.g. still validate tokens signed by the prior
	 *   signing key). Returns `null` if the secret has never been changed.
	 * - a {@link SecretVersion} from {@link Secret.listVersions} — a specific
	 *   historical version.
	 */
	version?: 'current' | 'previous' | SecretVersion;
}
