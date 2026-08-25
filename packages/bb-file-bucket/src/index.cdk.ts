// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { BuildingBlockScope } from '@aws-blocks/core/cdk';
import type { VpcRequirements, ScopeOptions } from '@aws-blocks/core/cdk';
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

export class FileBucket<O extends FileBucketOptions = FileBucketOptions> extends BuildingBlockScope {
	private bucket: s3.IBucket;

	/**
	 * Reference an existing S3 bucket instead of provisioning a new one.
	 * Mirrors the same factory exposed by the runtime build so the same code
	 * works in both contexts.
	 */
	static fromExisting(bucketName: string): ExternalBucketRef {
		return { __brand: 'ExternalBucketRef' as const, bucketName };
	}

	getVpcRequirements(): VpcRequirements {
		return {
			gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.S3],
		};
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
			autoDeleteObjects: destroy,
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
