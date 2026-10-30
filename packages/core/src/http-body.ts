// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { types } from 'node:util';
import type { BlocksContext } from './api.js';

/** The request accessors built by {@link requestBodyAccessors}. @internal */
export type RequestBodyAccessors = Pick<BlocksContext['request'], 'body' | 'json' | 'text'>;

/**
 * Build the `body`/`text()`/`json()` request accessors from the raw request
 * bytes, shared by the Lambda handler and the dev server so both hand a
 * handler exactly the bytes the client sent.
 *
 * `text()` and `json()` decode the bytes as UTF-8 on first use; pass `text`
 * when the caller already has the decoded string. They keep working after
 * `body` has been read.
 *
 * @internal
 */
export function requestBodyAccessors(bytes: Buffer, text?: string): RequestBodyAccessors {
	let decoded = text;
	const getText = () => (decoded ??= bytes.toString('utf-8'));
	return {
		body: bytes.byteLength === 0 ? null : bytesToStream(bytes),
		text: async () => getText(),
		json: async () => JSON.parse(getText()),
	};
}

function bytesToStream(bytes: Buffer): ReadableStream<Uint8Array> {
	// A small Buffer can be a view into Node's shared allocation pool; copy it so
	// `chunk.buffer` exposes only this body. A Buffer that owns its whole
	// ArrayBuffer is passed through without copying.
	const chunk =
		bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});
}

/**
 * The bytes of a binary `ctx.response.send()` body — an `ArrayBuffer` or any
 * `ArrayBufferView` (`Buffer`, `Uint8Array`, other typed arrays, `DataView`) —
 * or `undefined` for a text/JSON body.
 *
 * @internal
 */
export function binaryResponseBody(body: unknown): Buffer | undefined {
	// `types.isArrayBuffer`, not `instanceof`: an ArrayBuffer from another realm
	// (a `vm` context) must still be sent as bytes.
	if (types.isArrayBuffer(body)) return Buffer.from(body);
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	return undefined;
}

/**
 * Serialize a non-binary `ctx.response.send()` body: strings as-is, anything
 * else as JSON, nothing as the empty string.
 *
 * @internal
 */
export function textResponseBody(body: unknown): string {
	if (body === undefined) return '';
	return typeof body === 'string' ? body : JSON.stringify(body);
}
