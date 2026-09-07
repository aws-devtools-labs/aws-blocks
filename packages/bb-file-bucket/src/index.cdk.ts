// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as s3 from 'aws-cdk-lib/aws-s3';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { FileBucketOptions, CorsRule, LifecycleRule, ExternalBucketRef } from './types.js';
import { validateBucketName } from './bucket-name.js';

export { FileBucketErrors } from './errors.js';
export type { FileBucketOptions, PutOptions, GetUrlOptions, PutUrlOptions, ScanOptions, FileContent, FileInfo, CorsRule, LifecycleRule, ExternalBucketRef } from './types.js';

const httpMethodMap: Record<string, s3.HttpMethods> = {
	GET: s3.HttpMethods.GET,
	PUT: s3.HttpMethods.PUT,
	POST: s3.HttpMethods.POST,
	DELETE: s3.HttpMethods.DELETE,
	HEAD: s3.HttpMethods.HEAD,
};

/** Default number of days after which noncurrent object versions expire. */
const DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

/** HTTP methods that mutate bucket state; unsafe to expose to wildcard origins. */
const MUTATING_CORS_METHODS: ReadonlyArray<CorsRule['allowedMethods'][number]> = ['PUT', 'POST', 'DELETE'];

export class FileBucket<O extends FileBucketOptions = FileBucketOptions> extends Scope {
	private bucket: s3.IBucket;

	/**
	 * Reference an existing S3 bucket instead of provisioning a new one.
	 * Mirrors the same factory exposed by the runtime build so the same code
	 * works in both contexts.
	 */
	static fromExisting(bucketName: string): ExternalBucketRef {
		return { __brand: 'ExternalBucketRef' as const, bucketName };
	}

	constructor(scope: ScopeParent, id: string, options?: O) {
		super(id, { parent: scope });

		if (options?.bucket) {
			// `fromExisting`: don't provision; bind to the pre-existing bucket and
			// grant read/write to the Blocks runtime Lambda.
			this.bucket = s3.Bucket.fromBucketName(this, 'bucket', options.bucket.bucketName);
			this.bucket.grantReadWrite(this.executionRole);
			return;
		}

		// Resolve durability from the per-block option (a `'destroy'|'retain'`
		// string, normalized to a CDK RemovalPolicy) falling back to the
		// stack-wide `defaults`. This replaces the old `sandboxMode` context
		// read — the sandbox posture now flows in through the chosen preset,
		// exactly like bb-kv-store. Explicit `removalPolicy` from the customer
		// still takes precedence. `autoDeleteObjects: true` is only valid paired
		// with DESTROY (CDK validates this at construct time), so we derive the
		// two from the same resolved policy.
		const removalPolicy =
			options?.removalPolicy === 'destroy'
				? RemovalPolicy.DESTROY
				: options?.removalPolicy === 'retain'
					? RemovalPolicy.RETAIN
					: this.defaults.removalPolicy;
		const destroy = removalPolicy === RemovalPolicy.DESTROY;

		// Bucket name is derived from the scope chain. Validate against S3's
		// naming rules at synth so an invalid name fails here rather than at
		// `cdk deploy` (where CloudFormation rejects it with a cryptic error).
		// Run this first: an unusable bucket name is the most fundamental synth
		// error, so surface it before the option-level guards below.
		validateBucketName(this.fullId);

		// Reject unsafe CORS at synth: a wildcard origin ('*') combined with a
		// mutating method (PUT/POST/DELETE) lets any site issue state-changing
		// cross-origin requests. Fail loud here rather than deploying it.
		for (const rule of options?.corsRules ?? []) {
			if (rule.allowedOrigins.includes('*')) {
				const mutating = rule.allowedMethods.filter(m => MUTATING_CORS_METHODS.includes(m));
				if (mutating.length > 0) {
					throw new Error(
						`FileBucket "${this.fullId}": CORS rule with wildcard origin '*' must not allow mutating method(s) ${mutating.join(', ')}. ` +
						`Specify explicit allowedOrigins (e.g. 'https://app.example.com') for ${mutating.join(', ')} instead of '*'.`,
					);
				}
			}
		}

		// Reject a non-positive or non-integer noncurrent-version expiration at
		// synth whenever the option is provided. A zero, negative, or fractional
		// value would produce a degenerate lifecycle expiration
		// (Duration.days(0) / negative) that only surfaces at deploy. The FORMAT
		// is validated regardless of `versioned` so a malformed value is caught
		// even when versioning is off; the rule itself is only APPLIED when
		// versioning is on (see the main-bucket lifecycle rules below).
		if (options?.noncurrentVersionExpirationDays !== undefined) {
			const days = options.noncurrentVersionExpirationDays;
			if (!Number.isInteger(days) || days <= 0) {
				throw new Error(
					`FileBucket "${this.fullId}": noncurrentVersionExpirationDays must be a positive integer (got ${days}). ` +
					`Omit it to use the default of ${DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS} days.`,
				);
			}
		}

		// Versioning stays on by default (secure default): a posture-driven
		// `versioned` default would require a new `BlocksDefaults` field in
		// core, which is out of scope for this change, so we keep the
		// default-on and bound its cost with a noncurrent-version expiration
		// below.
		const versioned = options?.versioned ?? true;

		// Opt-in server access logging: provision a dedicated, locked-down log
		// bucket and expire its logs after the framework retention. Kept
		// separate from the data bucket so log delivery can't loop back on it.
		// Resolves from the stack `defaults.accessLogging` when no per-block
		// option is given, so a production-postured stack opts every FileBucket
		// in without a per-block flag.
		const accessLogging = options?.accessLogging ?? this.defaults.accessLogging;
		let serverAccessLogsBucket: s3.Bucket | undefined;
		if (accessLogging) {
			// The access-log lifecycle expiry derives from the framework-wide
			// `logRetention` default (a `RetentionDays` enum). `RetentionDays`
			// is a numeric enum whose member value IS the day count
			// (ONE_WEEK === 7, ONE_YEAR === 365), so it maps directly to
			// `Duration.days(...)`. The one non-day member is INFINITE (=== 9999,
			// "retain forever"): for it we omit the lifecycle rule so logs are
			// never expired, rather than expiring them at a spurious 9999 days.
			const logRetention = this.defaults.logRetention;
			const logLifecycleRules =
				logRetention === RetentionDays.INFINITE
					? undefined
					: [{ id: 'expire-access-logs', expiration: Duration.days(logRetention) }];
			serverAccessLogsBucket = new s3.Bucket(this, 'access-logs', {
				blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
				encryption: s3.BucketEncryption.S3_MANAGED,
				enforceSSL: true,
				removalPolicy,
				autoDeleteObjects: destroy,
				lifecycleRules: logLifecycleRules,
			});
		}

		// Main-bucket lifecycle rules: the noncurrent-version expiration (only
		// when versioning is on, to bound version-storage growth) merged with
		// any customer-supplied lifecycle rules into a single array.
		const lifecycleRules: s3.LifecycleRule[] = [];
		if (versioned) {
			lifecycleRules.push({
				id: 'ExpireNoncurrentVersions',
				enabled: true,
				noncurrentVersionExpiration: Duration.days(
					options?.noncurrentVersionExpirationDays ?? DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS,
				),
			});
		}
		for (const rule of options?.lifecycleRules ?? []) {
			lifecycleRules.push({
				prefix: rule.prefix,
				expiration: rule.expirationDays ? Duration.days(rule.expirationDays) : undefined,
				transitions: rule.transitionToIaDays ? [{
					storageClass: s3.StorageClass.INFREQUENT_ACCESS,
					transitionAfter: Duration.days(rule.transitionToIaDays),
				}] : undefined,
			});
		}

		this.bucket = new s3.Bucket(this, 'bucket', {
			bucketName: this.fullId,
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			encryption: s3.BucketEncryption.S3_MANAGED,
			// All FileBucket traffic (SDK calls + presigned URLs) is HTTPS, so
			// enforce TLS to close the in-transit exposure gap unconditionally.
			enforceSSL: true,
			versioned,
			removalPolicy,
			autoDeleteObjects: destroy,
			serverAccessLogsBucket,
			serverAccessLogsPrefix: serverAccessLogsBucket ? 'access-logs/' : undefined,
			cors: options?.corsRules?.map((rule: CorsRule) => ({
				allowedOrigins: rule.allowedOrigins,
				allowedMethods: rule.allowedMethods.map(m => httpMethodMap[m]),
				allowedHeaders: rule.allowedHeaders,
				exposedHeaders: rule.exposedHeaders,
				maxAge: rule.maxAge,
			})),
			lifecycleRules: lifecycleRules.length > 0 ? lifecycleRules : undefined,
		});

		this.bucket.grantReadWrite(this.executionRole);
	}
}
