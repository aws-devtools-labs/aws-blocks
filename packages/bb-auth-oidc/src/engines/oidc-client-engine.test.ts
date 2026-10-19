// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire-sanitization guard for the two OIDC error helpers that carry a raw
 * underlying error (#227 leak class). `idpError` and `providerNotConfigured`
 * build a branded error with a stable, BB-authored message and keep the raw
 * openid-client / SSM-resolver error only on a NON-ENUMERABLE `cause`.
 *
 * Only `name` + `message` cross the RPC wire (core's `errorResponseFromCatch`
 * sends nothing else), so a regression — re-interpolating `cause.message` back
 * into the message (e.g. `IdP error: ${msg}: ${cause.message}`) — would leak IdP
 * endpoints, tokens, SSM ARNs, and account ids to the caller. These tests pin
 * both wire-visible fields: the message must stay BB-authored, and
 * `JSON.stringify` must not expose the cause. Without them, adding the raw text
 * back passes the rest of the suite silently (the gap osama flagged).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { idpError, providerNotConfigured } from './oidc-client-engine.js';

/** A raw IdP error whose message carries detail that must never reach the wire. */
const RAW_IDP_SECRET = 'invalid_grant: code expired for client 1234567890.apps.googleusercontent.com';
/** A raw SSM-resolver error carrying an ARN + account id that must never leak. */
const RAW_SSM_SECRET =
	'AccessDenied: User arn:aws:sts::123456789012:assumed-role/app-fn-role/app-fn is not authorized to perform ssm:GetParameter on /app/google/clientSecret';

/**
 * Assert the branded error only exposes BB-authored text on the two fields that
 * cross the RPC wire (`name`, `message`), and keeps the raw error on a
 * non-enumerable `cause` for server-side diagnostics.
 */
function assertNoLeak(err: Error, expectedName: string, rawSecret: string): void {
	// (1) name is the stable BB constant.
	assert.strictEqual(err.name, expectedName);
	// (2) the wire-visible MESSAGE must not embed the raw error text.
	assert.ok(
		!err.message.includes(rawSecret),
		`wire message must not leak the raw error text, got: ${err.message}`,
	);
	// (3) the raw error is retained on `cause` for debugging...
	const { cause } = err;
	assert.ok(cause instanceof Error, 'raw error should be retained on cause');
	assert.ok(
		cause.message.includes(rawSecret),
		'cause should preserve the raw error text for server-side diagnostics',
	);
	// (4) ...but `cause` must be NON-ENUMERABLE, so JSON.stringify (and therefore
	// anything that serializes the error) can never surface the raw text.
	assert.strictEqual(
		Object.getOwnPropertyDescriptor(err, 'cause')?.enumerable,
		false,
		'`cause` must be non-enumerable',
	);
	assert.ok(
		!JSON.stringify(err).includes(rawSecret),
		'JSON.stringify of the error must not leak the raw text',
	);
}

describe('OIDC error helpers do not leak the raw cause over the wire', () => {
	test('idpError keeps the raw IdP error off the wire message', () => {
		const err = idpError('code exchange failed', new Error(RAW_IDP_SECRET));
		assert.strictEqual(err.message, 'IdP error: code exchange failed');
		assertNoLeak(err, 'IdpErrorException', RAW_IDP_SECRET);
	});

	test('providerNotConfigured keeps the raw resolver error off the wire message', () => {
		const err = providerNotConfigured('google: clientSecret resolver threw', new Error(RAW_SSM_SECRET));
		assert.strictEqual(err.message, 'provider not configured: google: clientSecret resolver threw');
		assertNoLeak(err, 'ProviderNotConfiguredException', RAW_SSM_SECRET);
	});

	test('both helpers are a no-op on cause when none is supplied', () => {
		const idp = idpError('code exchange did not return an ID token');
		assert.strictEqual(idp.cause, undefined);
		assert.strictEqual(idp.message, 'IdP error: code exchange did not return an ID token');

		const prov = providerNotConfigured('google');
		assert.strictEqual(prov.cause, undefined);
		assert.strictEqual(prov.message, 'provider not configured: google');
	});

	// The OAuth2 token/userinfo and refresh-grant failure sites pass the raw IdP
	// HTTP response body as `cause` and keep a BB-authored, STATUS-ONLY message.
	// The numeric HTTP status is safe on the wire; the response body (which can
	// embed account/endpoint detail) must not be interpolated into the message.
	const RAW_HTTP_BODY =
		'{"error":"invalid_client","error_description":"client 1234567890.apps.googleusercontent.com at https://idp.internal/token is not authorized"}';

	test('token-endpoint failure keeps the raw response body off the wire message', () => {
		const err = idpError('token endpoint rejected the code exchange (HTTP 400)', new Error(RAW_HTTP_BODY));
		assert.strictEqual(err.message, 'IdP error: token endpoint rejected the code exchange (HTTP 400)');
		assertNoLeak(err, 'IdpErrorException', RAW_HTTP_BODY);
	});

	test('userinfo failure keeps the raw response body off the wire message', () => {
		const err = idpError('userinfo endpoint request failed (HTTP 401)', new Error(RAW_HTTP_BODY));
		assert.strictEqual(err.message, 'IdP error: userinfo endpoint request failed (HTTP 401)');
		assertNoLeak(err, 'IdpErrorException', RAW_HTTP_BODY);
	});

	test('refresh-grant failure keeps the raw response body off the wire message', () => {
		const err = idpError('refresh_token grant failed (HTTP 400)', new Error(RAW_HTTP_BODY));
		assert.strictEqual(err.message, 'IdP error: refresh_token grant failed (HTTP 400)');
		assertNoLeak(err, 'IdpErrorException', RAW_HTTP_BODY);
	});
});
