// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
/**
 * Unit tests for the shared upload-constraint helpers. Both runtimes resolve
 * content types through `resolveUploadContentType`, so its canonical form and
 * wildcard matching are tested here directly; `parity.test.ts` asserts the mock
 * and the AWS runtime agree on them end to end.
 */
import { describe, test } from 'node:test';
import {
	resolvePresignedUpload,
	resolvePutUpload,
	resolveUploadContentType,
	uploadConstraintsFrom,
} from './upload-constraints.js';

describe('resolveUploadContentType renders parameters in canonical form', () => {
	const none = uploadConstraintsFrom();
	const cases: ReadonlyArray<[string, string]> = [
		['application/octet-stream', 'application/octet-stream'],
		['text/plain;charset=utf-8', 'text/plain; charset=utf-8'],
		['text/plain;  charset=UTF-8', 'text/plain; charset=UTF-8'],
		['text/plain ; charset = utf-8', 'text/plain; charset=utf-8'],
		['text/plain\t;\tcharset\t=\tutf-8', 'text/plain; charset=utf-8'],
		['text/plain; charset=utf-8', 'text/plain; charset=utf-8'],
		['text/plain;a=1;b=2 ;  c=3', 'text/plain; a=1; b=2; c=3'],
		['Text/Plain;Charset=UTF-8', 'Text/Plain; Charset=UTF-8'],
		['multipart/form-data;boundary="a ; b = c"', 'multipart/form-data; boundary="a ; b = c"'],
		['text/plain;a="esc\\"aped";b=x', 'text/plain; a="esc\\"aped"; b=x'],
		// A quoted value whose unescaped content is a token is written bare.
		['text/plain; charset="utf-8"', 'text/plain; charset=utf-8'],
		['text/plain;a="x\\yz"', 'text/plain; a=xyz'],
		// Any other quoted value stays quoted, with only `"` and `\` escaped.
		['text/plain; name="a b"', 'text/plain; name="a b"'],
		['text/plain; a=""', 'text/plain; a=""'],
		['text/plain; a="a/b"', 'text/plain; a="a/b"'],
		['text/plain; a="b\\\\c"', 'text/plain; a="b\\\\c"'],
		['text/plain; a="\\a b"', 'text/plain; a="a b"'],
	];
	for (const [input, canonical] of cases) {
		test(`${JSON.stringify(input)} → ${JSON.stringify(canonical)}`, () => {
			assert.strictEqual(resolveUploadContentType(none, input), canonical);
			assert.strictEqual(resolvePresignedUpload(none, { contentType: input }).contentType, canonical);
			assert.strictEqual(resolvePutUpload(none, input, 0), canonical);
		});
	}

	test('a canonical value is returned byte-identical', () => {
		for (const [, canonical] of cases) {
			assert.strictEqual(resolveUploadContentType(none, canonical), canonical);
		}
	});

	test('the default is application/octet-stream', () => {
		assert.strictEqual(resolveUploadContentType(none, undefined), 'application/octet-stream');
	});
});

describe('resolveUploadContentType: type/* wildcards and active document types', () => {
	const ACTIVE = [
		'text/html',
		'image/svg+xml',
		'application/xhtml+xml',
		'text/xml',
		'application/xml',
		'text/javascript',
		'text/xsl',
		'text/ecmascript',
		'application/javascript',
		'application/ecmascript',
		'application/x-javascript',
		'application/atom+xml',
		'application/rss+xml',
		'image/foo+xml',
		'Application/VND.Example+XML',
	];
	const wildcards = uploadConstraintsFrom({ allowedContentTypes: ['text/*', 'image/*', 'application/*'] });

	for (const contentType of [...ACTIVE, 'Text/HTML;charset=utf-8']) {
		test(`a wildcard does not match ${JSON.stringify(contentType)}`, () => {
			assert.throws(
				() => resolveUploadContentType(wildcards, contentType),
				(err: Error) => err.name === 'ValidationFailed' && /not allowed for this bucket/.test(err.message),
			);
		});
	}

	for (const contentType of ['text/plain', 'image/png', 'application/json', 'application/octet-stream', 'application/xml-dtd', 'application/vnd.api+json']) {
		test(`a wildcard still matches ${JSON.stringify(contentType)}`, () => {
			assert.strictEqual(resolveUploadContentType(wildcards, contentType), contentType);
		});
	}

	test('an exact entry accepts an active type, in any case', () => {
		const exact = uploadConstraintsFrom({ allowedContentTypes: ['image/*', 'Image/SVG+XML', 'text/html'] });
		assert.strictEqual(resolveUploadContentType(exact, 'image/svg+xml'), 'image/svg+xml');
		assert.strictEqual(resolveUploadContentType(exact, 'text/html;charset=utf-8'), 'text/html; charset=utf-8');
	});

	test('an exact entry accepts a +xml subtype; a wildcard alongside it does not widen to others', () => {
		const exact = uploadConstraintsFrom({ allowedContentTypes: ['application/*', 'application/atom+xml'] });
		assert.strictEqual(resolveUploadContentType(exact, 'application/atom+xml'), 'application/atom+xml');
		assert.throws(() => resolveUploadContentType(exact, 'application/rss+xml'), /not allowed for this bucket/);
	});
});
