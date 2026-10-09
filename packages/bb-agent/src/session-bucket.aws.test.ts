// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS-runtime tests for the deployed Agent's session-snapshot bucket name.
 * Run with `--conditions=aws-runtime`, so every Building Block here is its
 * AWS-runtime layer, as in the deployed AgentCore container.
 *
 * Regression (FX58): `FileBucket` shortens a derived name over S3's 63
 * characters (`deriveBucketName`, FX11), but the deployed Agent handed Strands'
 * `S3Storage` the session bucket's raw `fullId`. In a production stack the
 * preset agents' `sn` bucket has a 64-character `fullId`, so every snapshot
 * write addressed a bucket that doesn't exist (`StreamFailedException: Failed
 * to write S3 object …/snapshot_latest.json`).
 *
 * `index.cdk.test.ts` pins that the CDK layer provisions — and grants the
 * shared role on — the bucket named {@link SHORTENED}; this file pins that the
 * runtime addresses the same name.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { Scope, getSdkIdentifiers } from '@aws-blocks/core';
import { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { SnapshotManifest, SnapshotStorage } from '@strands-agents/sdk';
import type { S3StorageConfig } from '@strands-agents/sdk/session/s3-storage';
import { createDeployedSnapshotStorage } from './agent.aws.js';

/** The SB3 production stack, whose `preset-balanced` agent failed. */
const STACK = 'bb-test-prod-sb3prod-devuser1-b1e1a6';
/** The session bucket's `fullId` there: 64 characters, one over S3's limit. */
const FULL_ID = `${STACK}-test-app-preset-balanced-sn`;
/** `deriveBucketName(FULL_ID)`, the bucket CDK provisions (same literal in `index.cdk.test.ts`). */
const SHORTENED = 'bb-test-prod-sb3prod-devuser1-b1e1a6-test-app-preset-b-0c16bd0c';

/** Records every config the deployed factory builds S3Storage with. */
function s3StorageSpy() {
	const configs: S3StorageConfig[] = [];
	class Spy implements SnapshotStorage {
		constructor(config: S3StorageConfig) {
			configs.push(config);
		}
		async saveSnapshot(): Promise<void> {}
		async loadSnapshot(): Promise<null> {
			return null;
		}
		async listSnapshotIds(): Promise<string[]> {
			return [];
		}
		async deleteSession(): Promise<void> {}
		async loadManifest(): Promise<SnapshotManifest> {
			return { schemaVersion: '1.0', updatedAt: new Date().toISOString() };
		}
		async saveManifest(): Promise<void> {}
	}
	return { configs, Spy };
}

/** The session bucket at the same scope chain as the deployed preset agent's (`Agent` creates it as `'sn'`). */
function sessionBucket(stack: string, agentId: string): FileBucket {
	const app = new Scope('test-app', { parent: new Scope(stack) });
	return new FileBucket(new Scope(agentId, { parent: app }), 'sn');
}

test('deployed Agent: S3Storage addresses the shortened session bucket CDK provisions', () => {
	const bucket = sessionBucket(STACK, 'preset-balanced');
	assert.strictEqual(bucket.fullId, FULL_ID);
	assert.strictEqual(FULL_ID.length, 64, 'fixture: one over the limit');

	const { configs, Spy } = s3StorageSpy();
	createDeployedSnapshotStorage(bucket, Spy);
	assert.strictEqual(configs.length, 1);
	assert.strictEqual(configs[0].bucket, SHORTENED, 'S3Storage must use the physical bucket name, not the raw fullId');
	assert.strictEqual(configs[0].bucket, getSdkIdentifiers(bucket).bucketName, 'same name the FileBucket registered');
});

test('deployed Agent: a session bucket name that fits is still the fullId, byte-identical', () => {
	// Every already-deployed agent has a fitting name; it must not move.
	const bucket = sessionBucket(STACK, 'preset-smart');
	assert.ok(bucket.fullId.length <= 63);
	const { configs, Spy } = s3StorageSpy();
	createDeployedSnapshotStorage(bucket, Spy);
	assert.strictEqual(configs[0].bucket, bucket.fullId);
});
