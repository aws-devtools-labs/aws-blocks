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
	 * Seed the secret with a random value when it is first created, instead of
	 * leaving it unset.
	 *
	 * By default (`false`) a BB-created secret starts **empty**: `get()` returns
	 * `null` until a value is set via `put()`, the console, or the CLI — matching
	 * the "configure after deploy" model and the local mock. Set `generate: true`
	 * for secrets that only need to *exist* and never have a human-provided value
	 * — e.g. a webhook/HMAC signing key or an app-internal encryption key — so the
	 * app has a usable value immediately on first deploy without a manual step.
	 *
	 * On AWS this uses Secrets Manager's generator (a 32-character random string).
	 * The mock seeds an equivalent random string on first construction so local
	 * and deployed behavior match. Do **not** combine with `schema`: a generated
	 * random string is not valid JSON, so a typed secret must be set explicitly.
	 *
	 * Ignored when wrapping an existing secret via {@link Secret.fromExisting}.
	 */
	generate?: boolean;
	/**
	 * How long, in seconds, the runtime may serve a previously fetched value from
	 * its in-process read cache before re-fetching on the next `get()`.
	 *
	 * The runtime caches each fetched value in memory so steady-state reads don't
	 * bill a fetch on every call (see {@link Secret.get}). A `put()` from within
	 * the app clears the cache immediately, so this TTL only bounds how long an
	 * *out-of-band* change (a rotation via the console/CLI, or another process's
	 * `put()`) can go unnoticed.
	 *
	 * - **Omitted (default)** — **300 seconds (5 minutes)**, matching the AWS
	 *   Secrets Manager agent and the Lambda Parameters and Secrets extension. A
	 *   bounded default keeps a long-running process (one alive for hours or days,
	 *   handling many requests) from serving a rotated value indefinitely.
	 * - **A positive number** — use a larger value to cut `GetSecretValue` calls,
	 *   or a smaller one for fresher reads.
	 * - **`0`** — disable caching: every `get()` re-fetches from the service.
	 *
	 * Ignored by the local mock, which always reads the current value from disk.
	 */
	cacheTtlSeconds?: number;
	/**
	 * Allow the application runtime to **write** this secret via `put()`.
	 *
	 * Defaults to `false`. A `Secret` is **read-only at runtime by default**: the
	 * instantiated object has no `put()` method (it is absent from the object, and
	 * from the type — a call is a compile error), and the CDK layer grants the
	 * execution role **read-only** IAM (no `secretsmanager:PutSecretValue`). This
	 * is the least-privilege default — most apps only read a credential that is
	 * set out-of-band (console / CLI / CI). It applies to every secret, including
	 * one wrapped via {@link Secret.fromExisting}.
	 *
	 * Set `allowRuntimeWrite: true` only when the app genuinely rotates or sets
	 * the value itself at runtime (e.g. a self-rotating token). Then `put()` is
	 * present on the object and the execution role is granted write access.
	 */
	allowRuntimeWrite?: boolean;
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
 * The intended way to obtain one is {@link Secret.listVersions} (its
 * {@link SecretVersionInfo} extends this), then pass it to {@link Secret.get};
 * the `'current'` / `'previous'` shorthands cover the common cases. This is a
 * plain structural handle, so a hand-built `{ versionId }` also type-checks — a
 * `versionId` that does not exist simply reads back as `null`.
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
	 * Staging labels attached to this version. `listVersions()` returns the
	 * labeled versions, so this is `['AWSCURRENT']` for the live value and
	 * `['AWSPREVIOUS']` for the value before the last change.
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

/**
 * Package-internal construction options, used only by the framework key helper
 * in `@aws-blocks/bb-secret/internal`. Not exported from the package entry
 * points, so customer code cannot set them and the public `Secret` defaults
 * never change.
 *
 * @internal
 */
export interface InternalSecretOptions extends SecretOptions<string> {
	/**
	 * Leave `Name` unset so CloudFormation generates a unique secret name. The
	 * runtime finds the secret by the ARN registered in config, so nothing
	 * depends on the name. Takes precedence over {@link SecretOptions.name}.
	 */
	generatedName?: boolean;
	/**
	 * Seed the secret from CloudFormation `GenerateSecretString` with these
	 * settings. Implies {@link SecretOptions.generate}.
	 */
	generatedValue?: {
		/** Length of the generated value, in characters. */
		passwordLength: number;
		/** Exclude punctuation, so the value uses letters and digits only. */
		excludePunctuation: boolean;
	};
}
