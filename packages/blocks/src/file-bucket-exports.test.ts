// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The FileBucket option types a consumer needs to name are reachable from the
 * umbrella's default and `cdk` entries, not only from `@aws-blocks/bb-file-bucket`.
 * Type-only: this file fails to compile if an export is missing.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import type { FBExternalKmsKeyRef, ObjectLockOptions } from './index.js';
import type {
	FBExternalKmsKeyRef as CdkFBExternalKmsKeyRef,
	ObjectLockOptions as CdkObjectLockOptions,
} from './index.cdk.js';
import { FileBucket } from './index.js';

test('FileBucket encryption and Object Lock types are exported from the umbrella', () => {
	const key: FBExternalKmsKeyRef = FileBucket.fromKmsKey('arn:aws:kms:us-east-1:111122223333:key/abcd-1234');
	const cdkKey: CdkFBExternalKmsKeyRef = key;
	const lock: ObjectLockOptions = { mode: 'governance', retentionDays: 30 };
	const cdkLock: CdkObjectLockOptions = lock;
	assert.strictEqual(cdkKey.__brand, 'ExternalKmsKeyRef');
	assert.strictEqual(cdkLock.mode, 'governance');
});
