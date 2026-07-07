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
			this.bucket.grantReadWrite(this.handler);
			return;
		}

		// In sandbox mode, default to DESTROY + autoDeleteObjects so
		// `cdk destroy` can fully clean up without manual bucket emptying.
		// Explicit `removalPolicy` from the customer takes precedence.
		const isSandbox = cdk.Stack.of(this).node.tryGetContext('sandboxMode') === 'true';
		const destroy = options?.removalPolicy === 'destroy' || (isSandbox && options?.removalPolicy === undefined);

		// `autoDeleteObjects` is enabled ONLY in sandbox mode — never in a prod
		// stack, even with an explicit `removalPolicy: 'destroy'`. CDK's L2
		// `s3.Bucket` implements auto-delete via a hidden
		// `Custom::S3AutoDeleteObjects` Lambda with a hardcoded delete behavior
		// that stack-level retention Aspects (`RemovalPolicies.of(stack).retain()`)
		// cannot override. Attaching it to a prod bucket would silently empty the
		// bucket on `cdk destroy` even when the stack intends to retain it. In
		// prod, `'destroy'` sets DESTROY without auto-empty; S3 rejects deleting a
		// non-empty bucket, which is the correct, safe behavior.
		const autoDeleteObjects = isSandbox && destroy;

		// Bucket name is derived from the scope chain. Validate against S3's
		// naming rules at synth so an invalid name fails here rather than at
		// `cdk deploy` (where CloudFormation rejects it with a cryptic error).
		validateBucketName(this.fullId);

		this.bucket = new s3.Bucket(this, 'bucket', {
			bucketName: this.fullId,
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			encryption: s3.BucketEncryption.S3_MANAGED,
			versioned: options?.versioned ?? false,
			removalPolicy: destroy
				? RemovalPolicy.DESTROY
				: options?.removalPolicy === 'retain'
					? RemovalPolicy.RETAIN
					: undefined,
			autoDeleteObjects,
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

		this.bucket.grantReadWrite(this.handler);
	}
}
