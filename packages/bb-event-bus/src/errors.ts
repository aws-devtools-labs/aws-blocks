// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Error name constants for EventBus operations.
 */
export const EventBusErrors = {
	/** Thrown when a serialized event detail exceeds 256 KB. */
	PayloadTooLarge: 'PayloadTooLargeException',
	/** Thrown when an event type is empty, not a string, or the reserved `*` wildcard. */
	InvalidEventType: 'InvalidEventTypeException',
	/** Thrown when schema validation fails on publish or delivery. */
	ValidationFailed: 'ValidationFailedException',
	/** Thrown when the event bus name environment variable is missing (AWS only). */
	MissingBusConfig: 'MissingBusConfigException',
	/** Thrown when EventBridge rejects the published event (AWS only). */
	PublishFailed: 'PublishFailedException',
} as const;
