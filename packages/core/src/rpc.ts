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
  const code = error instanceof ApiError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  const data: Record<string, unknown> = {};
  if (error instanceof Error && error.name && error.name !== 'Error') data.name = error.name;
  if (error instanceof ApiError && error.retriable) data.retriable = true;
  return errorResponse(code, message, id, Object.keys(data).length > 0 ? data : undefined);
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
