// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
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

/** Default number of days to retain S3 server access logs before expiry. */
const DEFAULT_ACCESS_LOG_RETENTION_DAYS = 90;

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

		// In sandbox mode, default to DESTROY + autoDeleteObjects so
		// `cdk destroy` can fully clean up without manual bucket emptying.
		// Explicit `removalPolicy` from the customer takes precedence.
		// `autoDeleteObjects: true` is only valid paired with DESTROY (CDK
		// validates this at construct time), so we tie the two together.
		const isSandbox = cdk.Stack.of(this).node.tryGetContext('sandboxMode') === 'true';
		const destroy = options?.removalPolicy === 'destroy' || (isSandbox && options?.removalPolicy === undefined);

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

		// Reject a non-positive access-log retention at synth. A zero or
		// negative `logRetentionDays` would produce a degenerate lifecycle
		// expiration (Duration.days(0) / negative) that only surfaces at
		// deploy. Only meaningful when access logging is actually enabled.
		if (options?.accessLogging && options?.logRetentionDays !== undefined) {
			const days = options.logRetentionDays;
			if (!Number.isInteger(days) || days <= 0) {
				throw new Error(
					`FileBucket "${this.fullId}": logRetentionDays must be a positive integer (got ${days}). ` +
					`Omit it to use the default of ${DEFAULT_ACCESS_LOG_RETENTION_DAYS} days.`,
				);
			}
		}

		// Bucket name is derived from the scope chain. Validate against S3's
		// naming rules at synth so an invalid name fails here rather than at
		// `cdk deploy` (where CloudFormation rejects it with a cryptic error).
		validateBucketName(this.fullId);

		// Shared removal behavior for the main bucket and (if enabled) the
		// access-log bucket. `autoDeleteObjects` is only valid with DESTROY.
		const removalPolicy = destroy
			? RemovalPolicy.DESTROY
			: options?.removalPolicy === 'retain'
				? RemovalPolicy.RETAIN
				: undefined;

		// Opt-in server access logging: provision a dedicated, locked-down log
		// bucket and expire its logs after the configured retention. Kept
		// separate from the data bucket so log delivery can't loop back on it.
		let serverAccessLogsBucket: s3.Bucket | undefined;
		if (options?.accessLogging) {
			serverAccessLogsBucket = new s3.Bucket(this, 'access-logs', {
				blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
				encryption: s3.BucketEncryption.S3_MANAGED,
				enforceSSL: true,
				removalPolicy,
				autoDeleteObjects: destroy,
				lifecycleRules: [{
					id: 'expire-access-logs',
					expiration: Duration.days(options?.logRetentionDays ?? DEFAULT_ACCESS_LOG_RETENTION_DAYS),
				}],
			});
		}

		this.bucket = new s3.Bucket(this, 'bucket', {
			bucketName: this.fullId,
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			encryption: s3.BucketEncryption.S3_MANAGED,
			// All FileBucket traffic (SDK calls + presigned URLs) is HTTPS, so
			// enforce TLS to close the in-transit exposure gap unconditionally.
			enforceSSL: true,
			versioned: options?.versioned ?? true,
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
			lifecycleRules: options?.lifecycleRules?.map((rule: LifecycleRule) => ({
				prefix: rule.prefix,
				expiration: rule.expirationDays ? Duration.days(rule.expirationDays) : undefined,
				transitions: rule.transitionToIaDays ? [{
					storageClass: s3.StorageClass.INFREQUENT_ACCESS,
					transitionAfter: Duration.days(rule.transitionToIaDays),
				}] : undefined,
			})),
		});

		this.bucket.grantReadWrite(this.executionRole);
	}
}
