// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export { trackCommand, classifyError } from './trackCommand.js';
export { buildAndSendEvent, buildEvent } from './client.js';
export type { CommandName, CommandState, BuildAndSendEventOptions } from './types.js';
export { isTelemetryEnabled } from './consent.js';
