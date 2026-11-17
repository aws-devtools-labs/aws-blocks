// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Match } from 'aws-cdk-lib/assertions';

/**
 * Shared matchers for the API Gateway access-logging audit-gap synth warning,
 * imported by both `blocks-backend.test.ts` and `blocks-stack.test.ts` so the
 * two synth paths assert exactly the same contract from one definition.
 *
 * `addWarningV2(id, message)` records the annotation as `${message} [ack: ${id}]`,
 * so the id a caller passes to `acknowledgeWarning` surfaces as a trailing
 * `[ack: …]` tag. The id string ALSO appears inside the message body (in the
 * acknowledge remedy), so a matcher that only looked for the bare id would match
 * the message text and stay green even after the real `addWarningV2` id was
 * changed. These matchers therefore anchor the id on the trailing tag with `$`.
 */
export const AUDIT_WARNING_ID = 'blocks:apigateway:access-logging-disabled';

/**
 * Positive matcher: freezes the message substring, the `accessLogging: true`
 * opt-in remedy, and the warning id together — the id pinned to the trailing
 * `[ack: …]` tag that `addWarningV2` appends, not the copy inside the message
 * body. `[\s\S]*` lets the three parts appear in order anywhere across the full
 * annotation string.
 */
export const AUDIT_WARNING = Match.stringLikeRegexp(
	`access logging is disabled[\\s\\S]*accessLogging: true[\\s\\S]*\\[ack: ${AUDIT_WARNING_ID}\\]$`,
);

/**
 * Negative matcher: the trailing `[ack: <id>]` tag only. `hasNoWarning` cases
 * assert against this (not the full message) so a reword of the message body
 * can't make them pass vacuously — only an actually-emitted warning carrying
 * this id trips them.
 */
export const AUDIT_WARNING_ACK_TAG = Match.stringLikeRegexp(`\\[ack: ${AUDIT_WARNING_ID}\\]$`);
