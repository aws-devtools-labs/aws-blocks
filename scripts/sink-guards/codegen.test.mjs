// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Repo invariant for the native client generators (native/kotlin/codegen,
// native/swift/Sources/BlocksCodegen, native/dart/packages/blocks_codegen): a
// spec value (a field name, an enum value, a URL, a description) reaches a
// string literal in the generated Kotlin, Swift or Dart source only through
// that language's literal emitter, which escapes quotes, backslashes, `$`/`\(`
// interpolation and control characters:
//   Kotlin  kotlinStringLiteral() / kotlinMessageLiteral() (or KotlinPoet %S), neutraliseKdoc() for KDoc
//   Swift   swiftStringLiteral()
//   Dart    _dartStringLiteral()
// Identifiers derived from spec names go through each generator's identifier
// sanitizer. The behaviour itself is covered per language by the codegen
// fixtures (native/codegen-fixtures/28-escaping) in the native CI; this guard
// keeps a new emission site from bypassing the emitters.
//
// There is no Kotlin/Swift/Dart parser in the Node toolchain, so this is a
// line scan: a line that hands text to the generated source and opens a quoted
// literal right before a raw interpolation (`"\"$x"`, `"\"\(x)"`, `"'$x"`).
// Allowlist entries are exact file:line with a reason; an entry that stops
// matching a site fails the test, so the list only shrinks.
//
// Run: node --test scripts/sink-guards/codegen.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareWithAllowlist, findCodegenSinks, listCodegenFiles, report, scan } from './sinks.mjs';

const SWIFT_TYPE_NAME =
	'Decoding error text built from the generated Swift type name, which the same output declares as a type, so it must be an identifier; turning spec names into identifiers is open PR #1417, which owns this file.';
const SWIFT_CONTENT_LOCAL = (v) =>
	`${v} is swiftStringContent() of the spec text, assigned a few lines above, inside a literal this line opens and closes.`;

const ALLOWLIST = [
	{
		at: 'native/dart/packages/blocks_codegen/lib/src/generator.dart:1736',
		reason: "label is the generated class name, a Dart identifier, with its `$` escaped on the line above, so it holds no quote or interpolation.",
	},
	...[540, 628].map((l) => ({ at: `native/swift/Sources/BlocksCodegen/SwiftCodeGenerator.swift:${l}`, reason: SWIFT_TYPE_NAME })),
	{
		at: 'native/swift/Sources/BlocksCodegen/SwiftCodeGenerator.swift:552',
		reason: 'Decoding error text that is a constant apart from the runtime `\\(disc)` interpolation it writes into the generated code.',
	},
	...[1002, 1004, 1023, 1025].map((l) => ({ at: `native/swift/Sources/BlocksCodegen/SwiftCodeGenerator.swift:${l}`, reason: SWIFT_CONTENT_LOCAL('key') })),
	{ at: 'native/swift/Sources/BlocksCodegen/SwiftCodeGenerator.swift:1088', reason: SWIFT_CONTENT_LOCAL('escaped') },
	{ at: 'native/swift/Sources/BlocksCodegen/SwiftCodeGenerator+EntryPoint.swift:112', reason: SWIFT_CONTENT_LOCAL('name and url') },
];

describe('codegen sink detector', () => {
	const find = (file, src) => findCodegenSinks(file, src).map((f) => f.line);

	it('flags a raw interpolation inside an emitted literal, per language', () => {
		assert.deepEqual(find('G.kt', 'builder.addStatement("return \\"${field.name}\\"")'), [1]);
		assert.deepEqual(find('G.swift', 'lines.append("    case x = \\"\\(value)\\"")'), [1]);
		assert.deepEqual(find('g.dart', "buf.writeln(\"      '${f.name}': $expr,\");"), [1]);
		assert.deepEqual(find('g.dart', "buf.writeln('  static const x = \\'$url\\';');"), [1]);
	});

	it('accepts values that went through the emitters', () => {
		assert.deepEqual(find('G.kt', 'builder.addStatement("%L", kotlinStringLiteral(value))'), []);
		assert.deepEqual(find('G.swift', 'lines.append("    case x = \\(swiftStringLiteral(value))")'), []);
		assert.deepEqual(find('g.dart', "buf.writeln('      ${_dartStringLiteral(f.name)}: $expr,');"), []);
	});

	it('ignores diagnostics for the person running the generator', () => {
		assert.deepEqual(find('g.dart', 'throw FormatException("Expected \'$path\' to be an object");'), []);
		assert.deepEqual(find('G.kt', 'warnings.add(\n    "The \\"${namespace.name}\\" namespace collides"'), []);
		assert.deepEqual(find('parser.dart', "buf.writeln(\"'$x'\");"), []);
	});
});

describe('repo: generated literals go through the per-language emitters', () => {
	it('every emission site escapes, or is allowlisted with a reason', () => {
		const files = listCodegenFiles();
		assert.ok(files.length > 0, 'no generator sources found');
		const result = compareWithAllowlist(scan(files, findCodegenSinks), ALLOWLIST);
		assert.ok(result.unexpected.length === 0 && result.stale.length === 0, report('codegen', result));
	});
});
