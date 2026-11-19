// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/check-license-headers.mjs: header detection, header
// insertion and the path exclusions.
//
// Run: node --test scripts/check-license-headers.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXCLUSIONS, excludedBy, hasHeader, withHeader } from './check-license-headers.mjs';

const COPYRIGHT = 'Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.';
const SPDX = 'SPDX-License-Identifier: Apache-2.0';
const SLASH = [`// ${COPYRIGHT}`, `// ${SPDX}`];
const HASH = [`# ${COPYRIGHT}`, `# ${SPDX}`];
const SWIFT = [
	'//',
	'// Copyright Amazon.com Inc. or its affiliates.',
	'// All Rights Reserved.',
	'//',
	`// ${SPDX}`,
	'//',
];

/** The long-form notice kept in native/kotlin/plugin/build.gradle.kts. */
const LONG_FORM = [
	'/*',
	' * Copyright 2024 Amazon.com, Inc. or its affiliates. All Rights Reserved.',
	' *',
	' * Licensed under the Apache License, Version 2.0 (the "License").',
	' * You may not use this file except in compliance with the License.',
	' * A copy of the License is located at',
	' *',
	' *  http://aws.amazon.com/apache2.0',
	' */',
	'',
	'plugins {}',
	'',
].join('\n');

function countOf(text, needle) {
	return text.split(needle).length - 1;
}

describe('withHeader', () => {
	it('adds a `//` header with one blank line before the code', () => {
		assert.equal(withHeader('const a = 1;\n', 'a.ts'), [...SLASH, '', 'const a = 1;', ''].join('\n'));
	});

	it('keeps a shebang above the header', () => {
		const out = withHeader('#!/usr/bin/env node\nconsole.log(1);\n', 'x.mjs');
		assert.equal(out, ['#!/usr/bin/env node', ...SLASH, '', 'console.log(1);', ''].join('\n'));
		assert.ok(hasHeader(out));
	});

	it('keeps a Swift swift-tools-version line above the Swift header', () => {
		const out = withHeader('// swift-tools-version: 5.9\nimport PackageDescription\n', 'Package.swift');
		assert.equal(out, ['// swift-tools-version: 5.9', ...SWIFT, '', 'import PackageDescription', ''].join('\n'));
		assert.ok(hasHeader(out));
	});

	it('keeps a byte-order mark at the front and CRLF line endings', () => {
		const out = withHeader('\uFEFFconst a = 1;\r\nconst b = 2;\r\n', 'a.ts');
		assert.equal(out, `\uFEFF${[...SLASH, '', 'const a = 1;', 'const b = 2;', ''].join('\r\n')}`);
		assert.equal(countOf(out.replace(/\r\n/g, ''), '\n'), 0);
		assert.ok(hasHeader(out));
	});

	it('gives an empty file just the header', () => {
		const out = withHeader('', 'empty.ts');
		assert.equal(out, `${SLASH.join('\n')}\n`);
		assert.ok(hasHeader(out));
	});

	it('collapses leading blank lines to one', () => {
		assert.equal(withHeader('\n\n\nconst a = 1;\n', 'a.ts'), [...SLASH, '', 'const a = 1;', ''].join('\n'));
	});

	it('is idempotent', () => {
		for (const [text, path] of [
			['const a = 1;\n', 'a.ts'],
			['#!/usr/bin/env bash\nset -e\n', 'run.sh'],
			['// swift-tools-version: 5.9\nimport PackageDescription\n', 'Package.swift'],
			['\uFEFFconst a = 1;\r\n', 'a.ts'],
			['', 'empty.dart'],
		]) {
			const once = withHeader(text, path);
			assert.equal(withHeader(once, path), once, path);
			assert.equal(countOf(withHeader(once, path), SPDX), 1, path);
		}
	});

	it('adds a `#` header to shell and Python files, below a shebang', () => {
		assert.equal(
			withHeader('#!/usr/bin/env bash\nset -euo pipefail\n', 'run.sh'),
			['#!/usr/bin/env bash', ...HASH, '', 'set -euo pipefail', ''].join('\n'),
		);
		assert.equal(withHeader('echo hi\n', 'run.bash'), [...HASH, '', 'echo hi', ''].join('\n'));
		assert.equal(
			withHeader('"""Docstring."""\nimport os\n', 'tool.py'),
			[...HASH, '', '"""Docstring."""', 'import os', ''].join('\n'),
		);
		assert.equal(
			withHeader('#!/usr/bin/env python3\nimport os\n', 'tool.py'),
			['#!/usr/bin/env python3', ...HASH, '', 'import os', ''].join('\n'),
		);
	});
});

describe('hasHeader', () => {
	it('accepts the `//`, `#` and Swift headers', () => {
		assert.ok(hasHeader([...SLASH, '', 'code'].join('\n')));
		assert.ok(hasHeader([...HASH, '', 'code'].join('\n')));
		assert.ok(hasHeader([...SWIFT, '', 'code'].join('\n')));
	});

	it('accepts the long-form Apache-2.0 notice', () => {
		assert.ok(hasHeader(LONG_FORM));
	});

	it('rejects the SPDX text inside a string literal', () => {
		const text = [`// ${COPYRIGHT}`, `export const s = "${SPDX}";`, ''].join('\n');
		assert.equal(hasHeader(text), false);
	});

	it('rejects a different license id', () => {
		assert.equal(hasHeader([`// ${COPYRIGHT}`, `// ${SPDX}-or-later`, ''].join('\n')), false);
	});

	it('rejects an SPDX line without the Amazon copyright line above it', () => {
		assert.equal(hasHeader([`// ${SPDX}`, '', 'code'].join('\n')), false);
		assert.equal(hasHeader([`// ${SPDX}`, `// ${COPYRIGHT}`, ''].join('\n')), false);
		assert.equal(hasHeader(['// Copyright Someone Else.', `// ${SPDX}`, ''].join('\n')), false);
	});

	it('rejects a header below the scan window', () => {
		assert.equal(hasHeader(['a', 'b', 'c', 'd', 'e', 'f', ...SLASH].join('\n')), false);
	});
});

describe('excludedBy', () => {
	const excluded = [
		'packages/create-blocks-app/templates/default/src/index.ts',
		'native/codegen-fixtures/01-primitives/kotlin/Models.kt',
		'packages/admin-ui/next-env.d.ts',
		'native/dart/packages/blocks_runtime/lib/src/version.dart',
		'native/dart/packages/blocks_runtime_flutter/test/flutter_secure_store_test.mocks.dart',
	];

	it('excludes one path per exclusion', () => {
		for (const [pattern, reason] of EXCLUSIONS) {
			const hits = excluded.filter((path) => excludedBy(path)?.[0] === pattern);
			assert.equal(hits.length, 1, `${reason}: ${hits.join(', ')}`);
		}
	});

	it('does not exclude hand-written files next to generated ones', () => {
		for (const path of [
			'native/kotlin/fixture-goldens/build.gradle.kts',
			'native/kotlin/fixture-goldens/round-trips/11-tuples/TuplesRoundTripTest.kt',
			'native/codegen-fixtures/regenerate-all.sh',
			'native/codegen-fixtures/check-live-auth-fixtures.mjs',
			'native/dart/packages/blocks_runtime_flutter/test/flutter_secure_store_test.dart',
			'packages/core/src/build/plan.ts',
		]) {
			assert.equal(excludedBy(path), undefined, path);
		}
	});
});
