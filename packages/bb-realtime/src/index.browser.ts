// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - Realtime runs server-side only. Frontends subscribe through the
// channel handles the generated client hydrates, and import this package only for
// `RealtimeErrors` (e.g. `isBlocksError(e, RealtimeErrors.ConnectionFailed)`).
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { NamespaceConfig } from './types.js';

export { RealtimeErrors } from './errors.js';
export type {
	NamespaceConfig,
	NamespaceDefs,
	RealtimeChannel,
	RealtimeChannelDescriptor,
	RealtimeSubscription,
	RealtimeServer,
	RealtimeOptions,
	SubscribeOptions,
	DisconnectReason,
} from './types.js';

export class Realtime {
	constructor(..._args: unknown[]) {}
	static namespace<M>(schema: StandardSchemaV1<M>): NamespaceConfig<M> {
		return { schema };
	}
}
