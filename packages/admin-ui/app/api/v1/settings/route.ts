// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import {
	API_VERSION,
	type ApiError,
	type DataMode,
	type SettingsResponse,
	type SettingWriteResponse,
} from '@/contract/v1';
import { isAuthorized, isAuthorizedToMutate } from '@/server/auth';
import { guardMutation } from '@/server/http-guards';
import { getDataProvider } from '@/server/provider-registry';
import { isUnlocked, UNLOCK_TTL_MS } from '@/server/write-guard';

/**
 * The stage a write to is treated as a production change.
 *
 * Named rather than inferred from "not sandbox": a project with a third stage
 * would otherwise silently get the weaker gate.
 */
const PRODUCTION_STAGE = 'production';

/** Refusals the user has to act on, versus faults. Shapes the HTTP status. */
const REFUSAL_STATUS: Record<string, number> = {
	'not-declared': 404,
	unaddressable: 409,
	'not-present': 409,
	'invalid-json': 400,
	'too-large': 400,
	'empty-secret': 400,
	'version-conflict': 409,
	unreachable: 502,
};

function badRequest(message: string, status = 400): NextResponse<ApiError> {
	return NextResponse.json(
		{ apiVersion: API_VERSION, error: { code: 'BAD_REQUEST' as const, message } },
		{ status },
	);
}

/**
 * Declared settings joined against one stage.
 *
 * A plain read, so the session token is the whole gate here: no mutation guard,
 * for the same reason the unlock-state GET has none, and no decryption, which
 * is a property of `listSettings` rather than a choice made here. The route
 * cannot opt into a decrypted read even by mistake: the provider method that
 * decrypts is a different one, reached only by the reveal route.
 */
export async function GET(request: NextRequest): Promise<NextResponse<SettingsResponse | ApiError>> {
	if (!isAuthorized(request.headers.get('authorization'))) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' },
			},
			{ status: 401 },
		);
	}
	const stage = request.nextUrl.searchParams.get('stage') ?? 'sandbox';
	const mode: DataMode = request.nextUrl.searchParams.get('mode') === 'cloud' ? 'cloud' : 'local';
	const result = await getDataProvider().listSettings({ stage, mode });
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}

/**
 * Store one setting's value.
 *
 * The check order, cheapest and most decisive first, matching the record-write
 * route so the two cannot drift:
 *
 * 1. Session token.
 * 2. The mutation guard, BEFORE the body is read: its whole purpose is to
 *    decide whether this request is trusted enough to parse.
 * 3. JSON parse, then `mode`, rejected and never coerced. A typo'd mode
 *    defaulting to local would write a fixture file while the user believes
 *    they are editing production, report success, and leave production
 *    untouched: the worst outcome available here, because it is silent.
 * 4. The cloud write unlock, which a dashboard setting write needs for the
 *    same reason a direct record write does: it bypasses the app's own
 *    validation, here the Standard Schema the declaration may carry.
 * 5. The production confirmation, which no other write on this surface has.
 *
 * Why production gets a second gate: every other write here lands in a
 * developer's sandbox or a fixture file, while this one changes configuration
 * a live system reads, and one unlock covers every write for fifteen minutes.
 * So production asks the user to name the stage, which is the cheapest check
 * that cannot be satisfied by muscle memory.
 */
export async function PUT(
	request: NextRequest,
): Promise<NextResponse<SettingWriteResponse | ApiError>> {
	if (!isAuthorizedToMutate(request.headers.get('authorization'))) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' },
			},
			{ status: 401 },
		);
	}

	const guard = guardMutation(request);
	if (!guard.ok) return badRequest(guard.message, guard.status);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return badRequest('Request body must be valid JSON.');
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return badRequest('Request body must be a JSON object.');
	}
	const parsed = body as Record<string, unknown>;

	const mode = parsed.mode;
	if (mode !== 'local' && mode !== 'cloud') {
		return badRequest(
			`Unknown mode "${String(mode)}", expected one of: local, cloud. A write mode is never inferred.`,
		);
	}
	const stage = typeof parsed.stage === 'string' && parsed.stage ? parsed.stage : 'sandbox';

	if (mode === 'cloud' && !isUnlocked()) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: {
					code: 'LOCKED' as const,
					message: `Cloud writes are locked. Unlock them with POST /api/v1/writes/unlock; an unlock lasts ${Math.round(UNLOCK_TTL_MS / 60_000)} minutes (${UNLOCK_TTL_MS} ms) from the moment it is granted.`,
				},
			},
			{ status: 403 },
		);
	}

	if (mode === 'cloud' && stage === PRODUCTION_STAGE && parsed.confirmStage !== PRODUCTION_STAGE) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: {
					code: 'LOCKED' as const,
					message: `Writing a production setting needs "confirmStage": "${PRODUCTION_STAGE}" in the body. One unlock covers every write for fifteen minutes; this one changes what a live system reads.`,
				},
			},
			{ status: 403 },
		);
	}

	const fullId = parsed.fullId;
	if (typeof fullId !== 'string' || fullId.length === 0) {
		return badRequest('"fullId" must name a declared setting.');
	}
	const input = parsed.value;
	if (typeof input !== 'string') {
		// A string always, even for a JSON value: the caller sends what the user
		// typed and says how to read it. Accepting a pre-parsed value would lose
		// the difference between the text 5 and the number 5, which is the whole
		// reason `kind` exists.
		return badRequest('"value" must be a string holding exactly what the user typed.');
	}
	const kind = parsed.kind;
	if (kind !== 'text' && kind !== 'json') {
		return badRequest('"kind" must be "text" or "json". How to read a value is never inferred.');
	}
	const expectedVersion = parsed.expectedVersion;
	if (expectedVersion !== undefined && typeof expectedVersion !== 'number') {
		return badRequest('"expectedVersion" must be a number when present.');
	}

	const result = await getDataProvider().writeSetting({
		fullId,
		stage,
		mode,
		input,
		kind,
		...(expectedVersion === undefined ? {} : { expectedVersion }),
	});
	// A refusal comes back in the setting's own shape rather than as an
	// ApiError: each one names something the user must change, and the UI needs
	// to know which row it belongs to.
	const status = result.ok ? 200 : (REFUSAL_STATUS[result.refusalCode ?? ''] ?? 400);
	return NextResponse.json({ apiVersion: API_VERSION, ...result }, { status });
}
