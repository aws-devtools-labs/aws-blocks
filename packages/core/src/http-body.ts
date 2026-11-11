// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Request and response body handling shared by every transport (the Lambda
// handler, the container HTTP server, the local dev server), so a handler sees
// the same bytes and its byte responses go out unchanged on each.

import { types } from 'node:util';
import type { DispatchRequestBody } from './dispatch.js';

/**
 * The {@link DispatchRequestBody} for the raw request bytes: the bytes decoded
 * once as UTF-8 for `text()`/`json()`, and a stream of the exact bytes for
 * `ctx.request.body` (`null` when there are none).
 *
 * @internal
 */
export function requestBodyFromBytes(bytes: Buffer): DispatchRequestBody {
  return { text: bytes.toString('utf-8'), stream: bytes.length > 0 ? bytesStream(bytes) : null };
}

/**
 * The raw body bytes as a stream. Each read gets its own copy, so a handler
 * that mutates the chunk can't change what `text()`/`json()` decode.
 */
function bytesStream(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * The bytes of a binary `ctx.response.send()` body — an `ArrayBuffer`,
 * `SharedArrayBuffer` or any `ArrayBufferView` (`Buffer`, `Uint8Array`, other
 * typed arrays, `DataView`) — or `undefined` for a text/JSON body. The bytes are
 * copied, so a handler that reuses its buffer after `send()` can't change the
 * response.
 *
 * @internal
 */
export function binaryResponseBody(body: unknown): Buffer | undefined {
  // `types.isAnyArrayBuffer`, not `instanceof`: an ArrayBuffer from another realm
  // (a `vm` context) must still be sent as bytes.
  if (types.isAnyArrayBuffer(body)) return Buffer.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return Buffer.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return undefined;
}
