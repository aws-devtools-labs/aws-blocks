// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SnapshotStorage, SnapshotLocation, Snapshot, SnapshotManifest } from '@strands-agents/sdk';
import type { FileBucket } from '@aws-cdk-blocks/bb-file-bucket';

/**
 * SnapshotStorage backed by FileBucket BB.
 * Used locally — on AWS, Strands' native S3Storage talks to the same bucket directly.
 *
 * Mirrors the Strands S3Storage implementation exactly so that local and AWS
 * produce identical key layouts. If S3Storage changes, update this to match.
 *
 * Key layout (same as S3Storage):
 *   <sessionId>/scopes/<scope>/<scopeId>/snapshots/snapshot_latest.json
 *   <sessionId>/scopes/<scope>/<scopeId>/snapshots/immutable_history/snapshot_<uuid>.json
 *   <sessionId>/scopes/<scope>/<scopeId>/snapshots/manifest.json
 *
 *   @see https://strandsagents.com/docs/user-guide/concepts/agents/session-management/#s3sessionmanager--s3storage
 *   @see https://strandsagents.com/docs/user-guide/concepts/agents/session-management
 */
export class FileBucketSnapshotStorage implements SnapshotStorage {
	constructor(private bucket: FileBucket) {}

	/** Base path for a scope's snapshots folder. */
	private basePath(location: SnapshotLocation): string {
		return `${location.sessionId}/scopes/${location.scope}/${location.scopeId}/snapshots`;
	}

	async saveSnapshot(params: { location: SnapshotLocation; snapshotId: string; isLatest: boolean; snapshot: Snapshot }): Promise<void> {
		const data = JSON.stringify(params.snapshot, null, 2);
		if (params.isLatest) {
			// Overwrite the mutable latest snapshot
			await this.bucket.put(`${this.basePath(params.location)}/snapshot_latest.json`, data);
		} else {
			// Append-only immutable checkpoint
			await this.bucket.put(`${this.basePath(params.location)}/immutable_history/snapshot_${params.snapshotId}.json`, data);
		}
	}

	async loadSnapshot(params: { location: SnapshotLocation; snapshotId?: string }): Promise<Snapshot | null> {
		const path = params.snapshotId
			? `${this.basePath(params.location)}/immutable_history/snapshot_${params.snapshotId}.json`
			: `${this.basePath(params.location)}/snapshot_latest.json`;
		const file = await this.bucket.get(path);
		if (!file) return null;
		return JSON.parse(file.body.toString());
	}

	async listSnapshotIds(params: { location: SnapshotLocation; limit?: number; startAfter?: string }): Promise<string[]> {
		const prefix = `${this.basePath(params.location)}/immutable_history/`;
		const ids: string[] = [];
		let pastCursor = !params.startAfter;
		for await (const file of this.bucket.scan({ prefix })) {
			const match = file.path.match(/snapshot_([\w-]+)\.json$/);
			if (!match) continue;
			const id = match[1];
			if (!pastCursor) {
				if (id === params.startAfter) pastCursor = true;
				continue;
			}
			ids.push(id);
			if (params.limit && ids.length >= params.limit) break;
		}
		return ids;
	}

	async deleteSession(params: { sessionId: string }): Promise<void> {
		const paths: string[] = [];
		for await (const file of this.bucket.scan({ prefix: `${params.sessionId}/` })) {
			paths.push(file.path);
		}
		if (paths.length > 0) await this.bucket.deleteBatch(paths);
	}

	async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
		const file = await this.bucket.get(`${this.basePath(params.location)}/manifest.json`);
		if (!file) return { schemaVersion: '1.0', updatedAt: new Date().toISOString() };
		return JSON.parse(file.body.toString());
	}

	async saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void> {
		await this.bucket.put(`${this.basePath(params.location)}/manifest.json`, JSON.stringify(params.manifest, null, 2));
	}
}
