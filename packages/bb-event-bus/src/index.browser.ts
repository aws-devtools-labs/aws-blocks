// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — EventBus runs server-side only. Publishing and subscribing
// happen in your backend; clients receive events via Realtime, not directly.
export class EventBus {
	constructor(...args: any[]) {}
	on(...args: any[]): this {
		return this;
	}
	async publish(...args: any[]): Promise<{ eventId: string }> {
		return { eventId: '' };
	}
}

export const EventBusErrors = {
	PayloadTooLarge: 'PayloadTooLargeException',
	InvalidEventType: 'InvalidEventTypeException',
	ValidationFailed: 'ValidationFailedException',
	MissingBusConfig: 'MissingBusConfigException',
	PublishFailed: 'PublishFailedException',
} as const;
