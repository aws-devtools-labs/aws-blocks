// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire format of RPC response hints: small, out-of-band facts a Building Block
 * attaches to an API response for its own client middleware (for example,
 * "this call wrote these rows" so live shapes can sync them before the call
 * resolves). Carried in one response header, so the method's return value and
 * the JSON-RPC envelope are untouched. Shared by server and client: no Node imports.
 */

/** Response header that carries the hints. */
export const RESPONSE_HINTS_HEADER = 'x-blocks-hints';

/** Largest encoded hints header. Larger hint sets are replaced by an overflow marker. */
export const MAX_RESPONSE_HINTS_BYTES = 6 * 1024;

/** Hints by name. `overflow` lists names whose values were dropped for size. */
export interface ResponseHints {
  values: Record<string, unknown[]>;
  overflow: string[];
}

const toBase64Url = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64Url = (data: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

/** Encode hints for the header, or `null` if there are none. */
export function encodeResponseHints(values: Map<string, unknown[]>): string | null {
  if (values.size === 0) return null;
  const encoded = toBase64Url(JSON.stringify({ v: Object.fromEntries(values) }));
  if (encoded.length <= MAX_RESPONSE_HINTS_BYTES) return encoded;
  return toBase64Url(JSON.stringify({ v: {}, o: [...values.keys()] }));
}

/** Decode the header. Malformed or missing headers decode to no hints. */
export function decodeResponseHints(header: string | null | undefined): ResponseHints {
  const empty: ResponseHints = { values: {}, overflow: [] };
  if (!header) return empty;
  try {
    const parsed = JSON.parse(fromBase64Url(header)) as { v?: unknown; o?: unknown };
    const values: Record<string, unknown[]> = {};
    if (parsed.v && typeof parsed.v === 'object') {
      for (const [name, list] of Object.entries(parsed.v as Record<string, unknown>)) {
        if (Array.isArray(list)) values[name] = list;
      }
    }
    const overflow = Array.isArray(parsed.o) ? parsed.o.filter((name): name is string => typeof name === 'string') : [];
    return { values, overflow };
  } catch {
    return empty;
  }
}
