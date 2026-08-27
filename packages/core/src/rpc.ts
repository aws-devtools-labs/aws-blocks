// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON-RPC 2.0 wire format — single source of truth.
 *
 * All encoding/decoding of the Blocks RPC protocol lives here so that the
 * client, Lambda handler, and dev server never deal with the spec directly.
 *
 * @see https://www.jsonrpc.org/specification
 */

import { ApiError } from './errors.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** The pieces every server-side handler needs after parsing a request. */
export interface RpcParsedRequest {
  apiNamespace: string;
  method: string;
  /** Positional args — from array params directly, or Object.values() of named params. */
  args: unknown[];
  id: string | number | null;
}

/** Discriminated union returned by `parseRpcRequest`. */
export type RpcParseResult =
  | { ok: true; request: RpcParsedRequest }
  | { ok: false; response: string };

// ── Constants ───────────────────────────────────────────────────────────────

const VERSION = '2.0' as const;

/**
 * Maximum accepted request-body size, in bytes (10 MiB).
 *
 * Matches the payload limit API Gateway enforces in production (~10 MB for a
 * REST API). In prod an oversized body is rejected by API Gateway at the edge —
 * before the Lambda is invoked — so this guard's rejection path effectively
 * runs on the dev/mock server, where there is no edge to stop it: an oversized
 * body would otherwise buffer and wedge the local database (e.g. PGlite). By
 * enforcing the *same* limit locally, the dev server rejects the same oversized
 * body prod would 413 at the edge, instead of failing only in one environment.
 * Enforced in `parseRpcRequest`, the single choke point both the Lambda handler
 * and the dev server route through.
 *
 * Note: this value is the Lambda + API Gateway limit. It lives here (in the
 * compute-agnostic parser) because Lambda is the only compute path today. When
 * a non-API-Gateway compute (e.g. container/ALB) is introduced, this should
 * become compute-aware — sourced from / overridden by the compute layer (via
 * the Compute `setEnv` config hook) rather than a fixed constant in `core` —
 * since an ALB has a different payload limit. Tracked with the multi-compute work.
 */
export const MAX_RPC_BODY_BYTES = 10 * 1024 * 1024;

/** Reserved JSON-RPC error codes. */
export const RpcErrorCode = {
  ParseError:     -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams:  -32602,
  InternalError:  -32603,
} as const;

// ── Client helpers (encode request, decode response) ────────────────────────

let _nextId = 1;

/** Build a JSON-RPC 2.0 request body string ready to POST. */
export function encodeRpcRequest(apiNamespace: string, method: string, args: unknown[]): string {
  return JSON.stringify({
    jsonrpc: VERSION,
    method: `${apiNamespace}.${method}`,
    params: args,
    id: _nextId++,
  });
}

/**
 * Decode a JSON-RPC 2.0 response body.
 *
 * Returns the `result` on success, or throws an `ApiError` on error.
 */
export function decodeRpcResponse(body: unknown): unknown {
  const rpc = body as any;
  if (rpc.error) {
    const { code, message, data } = rpc.error;
    // Application error codes use the HTTP status directly (e.g. 409).
    // Reserved JSON-RPC codes (-32xxx) map to 500.
    const status = code > 0 ? code : 500;
    throw new ApiError(
      message,
      status,
      {
        ...(data?.name ? { name: data.name } : {}),
        ...(data?.retriable === true ? { retriable: true } : {}),
      },
    );
  }
  return rpc.result;
}

// ── Server helpers (parse request, encode response) ─────────────────────────

/**
 * Parse a raw body string into a validated `RpcParsedRequest`.
 *
 * Returns `{ ok: false, response }` with a ready-to-send JSON string when
 * the request is malformed, so callers can short-circuit without knowing
 * anything about the JSON-RPC spec.
 */
export function parseRpcRequest(bodyText: string): RpcParseResult {
  // Reject oversized bodies before parsing or dispatch. See MAX_RPC_BODY_BYTES
  // for the limit and its rationale.
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_RPC_BODY_BYTES) {
    // Emit the real HTTP status (413) as the error code, not a reserved -32xxx:
    // `decodeRpcResponse` maps a positive code straight to `ApiError.status`
    // (reserved codes collapse to 500), mirroring the 504 handler-timeout path,
    // so a caller's `e.status === 413` works. `name` (which crosses the wire,
    // not the code) lets callers match with `isBlocksError(e, 'PayloadTooLarge')`.
    return {
      ok: false,
      response: errorResponse(
        413,
        `Request body exceeds the ${MAX_RPC_BODY_BYTES} byte (${MAX_RPC_BODY_BYTES / (1024 * 1024)} MiB) limit`,
        null,
        { name: 'PayloadTooLarge' },
      ),
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(bodyText || '{}');
  } catch {
    return { ok: false, response: errorResponse(RpcErrorCode.ParseError, 'Parse error', null) };
  }

  const id = parsed.id ?? null;

  if (parsed.jsonrpc !== VERSION || typeof parsed.method !== 'string') {
    return {
      ok: false,
      response: errorResponse(
        RpcErrorCode.InvalidRequest,
        'Invalid Request: expected JSON-RPC 2.0 — {"jsonrpc":"2.0","method":"namespace.method","params":[...],"id":1}',
        id,
        { name: 'InvalidRequest' },
      ),
    };
  }

  const dotIndex = parsed.method.indexOf('.');
  if (dotIndex === -1) {
    return {
      ok: false,
      response: errorResponse(RpcErrorCode.InvalidRequest, 'Invalid Request: method must be "namespace.method"', id, { name: 'InvalidRequest' }),
    };
  }

  const hasParams = Object.hasOwn(parsed, 'params');
  if (hasParams && (parsed.params === null || typeof parsed.params !== 'object')) {
    return {
      ok: false,
      response: errorResponse(
        RpcErrorCode.InvalidParams,
        'Invalid params: expected an array or object',
        id,
        { name: 'InvalidParams' },
      ),
    };
  }

  let args: unknown[] = [];
  if (hasParams) {
    args = Array.isArray(parsed.params) ? parsed.params : Object.values(parsed.params);
  }

  return {
    ok: true,
    request: {
      apiNamespace: parsed.method.substring(0, dotIndex),
      method: parsed.method.substring(dotIndex + 1),
      // JSON-RPC 2.0 §4.2: params may be an array (positional) or object (named).
      args,
      id,
    },
  };
}

/** Encode a successful result as a JSON-RPC 2.0 response string. */
export function successResponse(result: unknown, id: string | number | null): string {
  return JSON.stringify({ jsonrpc: VERSION, result, id });
}

/**
 * Encode an error as a JSON-RPC 2.0 response string.
 *
 * For `ApiError` instances the HTTP status becomes the error code (positive
 * integers never collide with the reserved -32xxx range). Generic errors
 * use code 500.
 */
export function errorResponseFromCatch(error: unknown, id: string | number | null): string {
  // Only `ApiError` is a deliberate, client-safe error: its status, message,
  // `name`, and `retriable` flag are part of the public contract (clients match
  // on `name` via `isBlocksError`). Any other throw is an internal failure —
  // typically a driver/SDK exception whose class name and raw message can leak
  // implementation details (table names, SQL, ARNs, `$metadata`). Collapse those
  // to a stable, generic 500 so nothing internal reaches the wire; the caller
  // logs the real error server-side (see lambda-handler.ts / dev-server.ts).
  if (!(error instanceof ApiError)) {
    return errorResponse(500, 'Internal error', id);
  }
  const data: Record<string, unknown> = {};
  if (error.name && error.name !== 'Error') data.name = error.name;
  if (error.retriable) data.retriable = true;
  return errorResponse(error.status, error.message, id, Object.keys(data).length > 0 ? data : undefined);
}

/** Encode a "method not found" error. */
export function methodNotFoundResponse(detail: string, id: string | number | null): string {
  return errorResponse(RpcErrorCode.MethodNotFound, `Method not found: ${detail}`, id);
}

// ── Internal ────────────────────────────────────────────────────────────────

export function errorResponse(
  code: number,
  message: string,
  id: string | number | null,
  data?: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: VERSION,
    error: { code, message, ...(data ? { data } : {}) },
    id,
  });
}
