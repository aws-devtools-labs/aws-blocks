// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * How a `validateUser` rejection raised inside the Cognito PreSignUp trigger
 * (`presignup-trigger.ts`) travels back to the client as the same `ApiError`
 * the in-process check would have thrown.
 *
 * The trigger can only reject by throwing; Cognito then answers the caller with
 * `UserLambdaValidationException` and the message `PreSignUp failed with error
 * <thrown message>.` (managed login: a redirect with that text in
 * `error_description`). The thrown message therefore carries the already-mapped
 * error — name, status, message, `retriable` — as a tagged base64url JSON
 * payload, which survives Cognito's wrapping and URL encoding unchanged. The
 * app Lambda decodes it in the error policy (`error-mapping.ts`) and in the
 * managed-login callback (`engines/federation-hosted-ui.ts`).
 *
 * The payload is produced from `toAuthApiError`'s output, so it holds nothing
 * the in-process path would not show the client (no SDK metadata, no ARN, no
 * account id). Decoding is strict: anything malformed is ignored, and the
 * caller falls back to the ordinary mapping.
 *
 * @internal
 */

import { ApiError } from '@aws-blocks/core';

/** Marks a `validateUser` rejection in a trigger error message. */
const REJECTION_TAG = 'bb-auth-rejection:';
const REJECTION_PATTERN = /bb-auth-rejection:([A-Za-z0-9_-]+)/;
/** Cognito bounds the trigger error it echoes; keep the encoded message short. */
const MAX_MESSAGE_LENGTH = 500;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,99}$/;

/**
 * Encode a (client-safe, already mapped) rejection as the message the trigger
 * throws.
 *
 * @internal
 */
export function encodeTriggerRejection(error: ApiError): string {
	const payload: { n: string; s: number; m: string; r?: 1 } = {
		n: error.name,
		s: error.status,
		m: error.message.slice(0, MAX_MESSAGE_LENGTH),
		...(error.retriable ? { r: 1 } : {}),
	};
	return `${REJECTION_TAG}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

/**
 * Recover the rejection from a Cognito error message or `error_description`
 * (`PreSignUp failed with error bb-auth-rejection:<payload>.`). `null` when the
 * text carries no well-formed payload.
 *
 * @internal
 */
export function decodeTriggerRejection(text: string | null | undefined): ApiError | null {
	if (!text) return null;
	const match = REJECTION_PATTERN.exec(text);
	if (!match?.[1]) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const name: unknown = Reflect.get(parsed, 'n');
	const status: unknown = Reflect.get(parsed, 's');
	const message: unknown = Reflect.get(parsed, 'm');
	const retriable: unknown = Reflect.get(parsed, 'r');
	if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return null;
	if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return null;
	if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH) return null;
	return new ApiError(message, status, { name, ...(retriable === 1 ? { retriable: true } : {}) });
}
