// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Realtime } from '../index.cdk.js';

// Instantiate a Realtime block so BlocksBackend.create synthesizes the shared
// WebSocket infrastructure (API + hardened stage) into the stack.
export default function (backend: unknown) {
	new Realtime(backend as never, 'rt', { namespaces: {} });
}
