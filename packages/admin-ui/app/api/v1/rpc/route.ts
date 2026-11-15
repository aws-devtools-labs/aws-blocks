// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { API_VERSION, type ApiError, type DataMode, type RpcInvokeResponse } from '@/contract/v1';
import { isAuthorizedToMutate } from '@/server/auth';
import { guardMutation } from '@/server/http-guards';
import { getDataProvider } from '@/server/provider-registry';

const MODES: DataMode[] = ['local', 'cloud'];

function isDataMode(value: unknown): value is DataMode {
	return typeof value === 'string' && (MODES as string[]).includes(value);
}

function badRequest(message: string, status = 400): NextResponse<ApiError> {
	return NextResponse.json({ apiVersion: API_VERSION, error: { code: 'BAD_REQUEST' as const, message } }, { status });
}

/**
 * Call one method on the app's own RPC endpoint.
 *
 * Two decisions worth stating, because both look wrong at a glance.
 *
 * FIRST: this route carries the same Content-Type / Origin / Sec-Fetch-Site
 * hardening as the record-write routes. A route named "rpc" reads as a read
 * until you think about it — but an RPC call can mutate the app's data, and an
 * attacker's page needs no more than a form post to trigger one. So it is
 * guarded as a mutation, which is what it is.
 *
 * SECOND, and deliberately: there is NO write-unlock gate here. That is not an
 * oversight, and it is not inconsistency with the write routes — it is the
 * distinction the unlock is *for*. The unlock exists because a direct DynamoDB
 * write BYPASSES the app's own validation, auth and business logic: it is power
 * the app grants nobody, reachable only because the dashboard holds the
 * developer's AWS credentials. An RPC call is the opposite: it goes THROUGH all
 * of that logic, and it is exactly what any client already holding the endpoint
 * can do. Gating it would misrepresent where the risk lives, while charging
 * friction to read-only methods we cannot tell apart from writes — the catalogue
 * exposes a method's name and parameters, never whether it mutates. The right
 * speed bump for an RPC call is the per-call confirmation in the UI, next to the
 * request the user is about to send.
 *
 * Checks run in this order: session token, mutation guard, JSON parse, `mode`,
 * then `method` and `params`.
 */
export async function POST(request: NextRequest): Promise<NextResponse<RpcInvokeResponse | ApiError>> {
	if (!isAuthorizedToMutate(request.headers.get('authorization'))) {
		return NextResponse.json(
			{
				apiVersion: API_VERSION,
				error: { code: 'UNAUTHORIZED' as const, message: 'Missing or invalid session token' },
			},
			{ status: 401 },
		);
	}

	// Ahead of the body, as on the write routes: the guard's whole purpose is to
	// decide whether this request is trusted enough to parse. Its own status
	// travels out (415 or 403); only the message is the guard's to write.
	const guard = guardMutation(request);
	if (!guard.ok) {
		return badRequest(guard.message, guard.status);
	}

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

	// Never coerced. A typo'd mode defaulting to one environment would have the
	// user call production believing they called their sandbox — or the reverse —
	// and the response would look entirely successful either way.
	const mode = parsed.mode;
	if (!isDataMode(mode)) {
		return badRequest(
			`Unknown mode "${String(mode)}" — expected one of: ${MODES.join(', ')}. The target environment is never inferred.`,
		);
	}

	const { method, params } = parsed;
	if (typeof method !== 'string' || method.length === 0) {
		return badRequest('"method" must be a non-empty string naming the call as "namespace.methodName".');
	}
	// An ARRAY, strictly. Parameters are positional on the JSON-RPC wire, so an
	// object would be silently dropped by the app rather than rejected by it: the
	// call would appear to succeed having received no arguments at all.
	if (!Array.isArray(params)) {
		return badRequest(
			'"params" must be an array. Parameters are positional on the wire, so an object cannot be sent in their place.',
		);
	}

	const stage = typeof parsed.stage === 'string' && parsed.stage ? parsed.stage : 'sandbox';

	const result = await getDataProvider().invokeRpc({ stage, mode, method, params });
	// 200, including for an upstream 401, a JSON-RPC error body, a timeout and
	// NO_ENDPOINT. The call was attempted and its outcome is the payload — the
	// upstream status is in `httpStatus`, where a client can inspect it instead of
	// mistaking the app's rejection for ours. Non-2xx stays reserved for our own
	// auth and for a request we could not make sense of.
	return NextResponse.json({ apiVersion: API_VERSION, ...result });
}
