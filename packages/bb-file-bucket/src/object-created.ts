// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared plumbing for `onObjectCreated`, used by the mock, AWS-runtime and CDK
 * layers. Delivery is an internal `AsyncJob` child whose queue receives S3
 * event notification messages. On AWS, S3 writes them to the queue; the mock
 * submits the same message shape after each matching write, so both layers
 * run the identical parse-and-dispatch path below. No runtime imports.
 */
import type { FileBucketOptions, ObjectCreatedEvent, ObjectCreatedOptions } from './types.js';

/**
 * Child id of the internal AsyncJob that delivers object-created events. Every
 * layer builds the child under this id, so the runtime job derives the same
 * `fullId` (and queue name) the CDK layer provisioned.
 */
export const OBJECT_CREATED_JOB_ID = 'on-object-created';

/**
 * The part of an S3 event notification message this block reads. S3 also sends
 * an `s3:TestEvent` message (no `Records`) when the notification is first
 * configured; it yields no events. For an unversioned bucket, S3 documents
 * `versionId` as null or not present.
 */
export interface S3NotificationMessage {
	Records?: Array<{
		eventName: string;
		s3: { object: { key: string; size: number; versionId?: string | null } };
	}>;
}

/** S3 URL-encodes notification keys, with `+` for a space. Decode back to the key `get()` takes. */
function decodeS3EventKey(key: string): string {
	return decodeURIComponent(key.replace(/\+/g, ' '));
}

/** Encode a key the way S3 does in event notifications (the mock's inverse of {@link decodeS3EventKey}). */
function encodeS3EventKey(path: string): string {
	return encodeURIComponent(path).replace(/%20/g, '+');
}

/** Extract the object-created events from one S3 notification message. */
export function toObjectCreatedEvents(message: S3NotificationMessage): ObjectCreatedEvent[] {
	const events: ObjectCreatedEvent[] = [];
	for (const record of message.Records ?? []) {
		if (!record.eventName.startsWith('ObjectCreated:')) continue;
		const { key, size, versionId } = record.s3.object;
		// Normalize S3's null to an absent property, as `ObjectCreatedEvent` promises.
		events.push({ path: decodeS3EventKey(key), size, ...(typeof versionId === 'string' ? { versionId } : {}) });
	}
	return events;
}

/** Build the S3 notification message the mock submits for one created object. */
export function toS3NotificationMessage(event: ObjectCreatedEvent): S3NotificationMessage {
	const object = {
		key: encodeS3EventKey(event.path),
		size: event.size,
		...(event.versionId !== undefined ? { versionId: event.versionId } : {}),
	};
	return { Records: [{ eventName: 'ObjectCreated:Put', s3: { object } }] };
}

/** The mock's equivalent of the S3 notification filter: both `prefix` and `suffix` must match when set. */
export function matchesObjectCreatedFilter(path: string, options: ObjectCreatedOptions): boolean {
	return (!options.prefix || path.startsWith(options.prefix)) && (!options.suffix || path.endsWith(options.suffix));
}

/** The internal AsyncJob's handler: dispatch each object-created record in a message to the user's handler. */
export function objectCreatedJobHandler(
	options: ObjectCreatedOptions,
): (message: S3NotificationMessage, context: { receiveCount: number }) => Promise<void> {
	return async (message, context) => {
		for (const event of toObjectCreatedEvents(message)) {
			await options.handler(event, { receiveCount: context.receiveCount });
		}
	};
}

/**
 * Reject `onObjectCreated` on a bucket wrapped with `fromExisting`. Runs
 * before the CDK layer's early return for wrapped buckets, and in the mock, so
 * both reject it the same way. Throws a bare `Error`, like the other synth
 * guards in `validation.ts`.
 */
export function validateObjectCreatedOptions(fullId: string, options?: FileBucketOptions): void {
	if (options?.onObjectCreated && options.bucket) {
		throw new Error(
			`FileBucket "${fullId}": onObjectCreated is not supported on a bucket wrapped with FileBucket.fromExisting. ` +
				`S3 keeps one notification configuration per bucket, which the existing bucket's owner may already manage. ` +
				`Configure an event notification on that bucket directly, or use a FileBucket that this app provisions.`,
		);
	}
}
