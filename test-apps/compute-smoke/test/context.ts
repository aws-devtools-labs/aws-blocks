// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// What every scenario module gets from the harness (`compute-smoke.test.ts`).

export const FRONT_DOORS = ['apigateway', 'cloudfront'] as const;
export type FrontDoor = (typeof FRONT_DOORS)[number];

export interface ComputeTestContext {
  /** The front door this leg deployed (`COMPUTE_API_FRONT_DOOR`). */
  readonly frontDoor: FrontDoor;
  /** The client endpoint, the stack's `ApiUrl` output. Set once the harness has deployed. */
  apiUrl(): string;
}

export type RpcReply = { result?: unknown; error?: { code?: number; message?: string; data?: { name?: string } } };

/**
 * POST one JSON-RPC call. `path` is appended to the endpoint (e.g. `'reports'`);
 * without it the call goes to the bare endpoint, which serves every namespace.
 */
export async function rpcCall(apiUrl: string, method: string, params: unknown[] = [], path?: string): Promise<RpcReply> {
  const res = await fetch(path ? `${apiUrl}/${path}` : apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as RpcReply;
}

/** Call an `api` method and return its result; throws on a JSON-RPC error. */
export async function apiRpc(ctx: ComputeTestContext, method: string, ...args: unknown[]): Promise<unknown> {
  const reply = await rpcCall(ctx.apiUrl(), `api.${method}`, args);
  if (reply.error) throw new Error(`RPC ${method} error: ${reply.error.message || JSON.stringify(reply.error)}`);
  return reply.result;
}
