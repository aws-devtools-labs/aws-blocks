// SPDX-License-Identifier: Apache-2.0

// Run: node --test scripts/generate-block-catalog.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DESCRIPTION_WARN_LENGTH,
  attachDescriptions,
  displayColumns,
  normalizeDescription,
  packageDirName,
  renderEntry,
  tsStringLiteral,
} from './generate-block-catalog.mjs';

describe('normalizeDescription', () => {
  const cases = [
    {
      name: 'strips the inline code markers a real blurb contains',
      // bb-data's actual blurb ends this way.
      input: 'Full PostgreSQL database — connects via `fromExisting()`.',
      expected: 'Full PostgreSQL database — connects via fromExisting().',
    },
    { name: 'strips bold', input: 'The **compute** for Blocks.', expected: 'The compute for Blocks.' },
    { name: 'strips emphasis', input: 'A *fast* store.', expected: 'A fast store.' },
    { name: 'reduces a link to its label', input: 'See [the docs](https://x.dev/a_b) first.', expected: 'See the docs first.' },
    { name: 'collapses newlines and runs of spaces', input: 'A store\n  backed   by S3.', expected: 'A store backed by S3.' },
    { name: 'trims', input: '  Storage backed by S3.  ', expected: 'Storage backed by S3.' },
    { name: 'passes plain text through untouched', input: 'File storage backed by Amazon S3.', expected: 'File storage backed by Amazon S3.' },
    { name: 'returns empty for empty input', input: '', expected: '' },
    { name: 'returns empty for undefined', input: undefined, expected: '' },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => assert.equal(normalizeDescription(input), expected));
  }

  it('leaves single-underscore text alone, so an identifier survives', () => {
    // The reason `_em_` is not stripped: this is indistinguishable from emphasis.
    assert.equal(normalizeDescription('Reads the some_field_name column.'), 'Reads the some_field_name column.');
  });
});

describe('attachDescriptions', () => {
  const entry = (type, source) => ({ type, category: 'data', source });

  it('describes a block whose package exports exactly one class', () => {
    const { entries } = attachDescriptions([entry('KVStore', '@aws-blocks/bb-kv-store')], () => 'Simple key-value storage.');
    assert.equal(entries[0].description, 'Simple key-value storage.');
  });

  it('describes NEITHER class when the package exports two, and reports the package', () => {
    // The real case: @aws-blocks/core exports ApiNamespace and RawRoute, and its
    // README describes the package. Two blocks sharing one sentence is the defect
    // being prevented here.
    const { entries, suppressed } = attachDescriptions(
      [entry('ApiNamespace', '@aws-blocks/core'), entry('RawRoute', '@aws-blocks/core')],
      () => 'Core primitives for building full-stack applications.',
    );
    assert.equal(entries[0].description, undefined);
    assert.equal(entries[1].description, undefined);
    assert.deepEqual(suppressed, ['@aws-blocks/core']);
  });

  it('still describes a single-class package alongside a suppressed multi-class one', () => {
    const { entries } = attachDescriptions(
      [
        entry('ApiNamespace', '@aws-blocks/core'),
        entry('RawRoute', '@aws-blocks/core'),
        entry('KVStore', '@aws-blocks/bb-kv-store'),
      ],
      (pkg) => (pkg === '@aws-blocks/core' ? 'Core primitives.' : 'Simple key-value storage.'),
    );
    assert.equal(entries[2].description, 'Simple key-value storage.');
  });

  it('reports a package once, not once per class it exports', () => {
    const { suppressed } = attachDescriptions(
      [entry('A', '@aws-blocks/core'), entry('B', '@aws-blocks/core'), entry('C', '@aws-blocks/core')],
      () => 'Core primitives.',
    );
    assert.deepEqual(suppressed, ['@aws-blocks/core']);
  });

  it('sets no description when the package has no README blurb', () => {
    const { entries } = attachDescriptions([entry('KVStore', '@aws-blocks/bb-kv-store')], () => '');
    assert.equal(entries[0].description, undefined);
    assert.ok(!('description' in entries[0]), 'the key is absent rather than undefined');
  });

  it('normalizes on the way in, so markdown never reaches the catalog', () => {
    const { entries } = attachDescriptions([entry('KVStore', '@aws-blocks/bb-kv-store')], () => 'Backed by `DynamoDB`.');
    assert.equal(entries[0].description, 'Backed by DynamoDB.');
  });

  it('flags an over-long blurb without dropping or truncating it', () => {
    const long = `${'x'.repeat(DESCRIPTION_WARN_LENGTH)}y`;
    const { entries, overlong } = attachDescriptions([entry('KVStore', '@aws-blocks/bb-kv-store')], () => long);
    assert.deepEqual(overlong, ['@aws-blocks/bb-kv-store']);
    assert.equal(entries[0].description, long, 'the full text is kept; clamping is the display layer’s job');
  });

  it('does not flag a blurb exactly at the limit', () => {
    const { overlong } = attachDescriptions([entry('KVStore', '@aws-blocks/bb-kv-store')], () =>
      'x'.repeat(DESCRIPTION_WARN_LENGTH),
    );
    assert.deepEqual(overlong, []);
  });

  it('does not mutate the entries it was given', () => {
    const input = [entry('KVStore', '@aws-blocks/bb-kv-store')];
    attachDescriptions(input, () => 'Simple key-value storage.');
    assert.equal(input[0].description, undefined);
  });
});

describe('packageDirName', () => {
  it('maps a bb-* package to its directory', () => {
    assert.equal(packageDirName('@aws-blocks/bb-kv-store'), 'bb-kv-store');
  });
  it('maps a non-vendorized package to its directory', () => {
    assert.equal(packageDirName('@aws-blocks/core'), 'core');
  });
});

describe('tsStringLiteral', () => {
  it('quotes plain text', () => assert.equal(tsStringLiteral('A store.'), "'A store.'"));
  it('escapes an apostrophe, which single quotes would otherwise terminate', () => {
    assert.equal(tsStringLiteral("The stack's resources."), "'The stack\\'s resources.'");
  });
  it('escapes a backslash before it can escape the quote after it', () => {
    assert.equal(tsStringLiteral('a\\'), "'a\\\\'");
  });
});

describe('displayColumns', () => {
  it('counts a leading tab as an indent width, not one character', () => {
    // The bug this exists to prevent: measuring with `.length` disagreed with
    // biome about the two longest descriptions.
    assert.equal(displayColumns('\tab'), 6);
    assert.equal(displayColumns('\t\t\tab'), 14);
  });
  it('counts a plain line as its length', () => assert.equal(displayColumns('abc'), 3));
  it('counts only LEADING tabs as indentation', () => assert.equal(displayColumns('a\tb'), 3));
});

describe('renderEntry — output is already biome-formatted', () => {
  const MAX = 120;
  const widest = (rendered) => Math.max(...rendered.split('\n').map(displayColumns));

  it('keeps a description-less entry on one line', () => {
    assert.equal(
      renderEntry({ type: 'RawRoute', category: 'core', source: '@aws-blocks/core' }),
      "\t['RawRoute', { category: 'core', source: '@aws-blocks/core' }],",
    );
  });

  it('keeps a short entry on one line', () => {
    const rendered = renderEntry({ type: 'X', category: 'data', source: '@a/b', description: 'Short.' });
    assert.equal(rendered.split('\n').length, 1);
    assert.match(rendered, /description: 'Short\.'/);
  });

  it('wraps the object when one line would overflow', () => {
    const rendered = renderEntry({
      type: 'FileBucket',
      category: 'storage',
      source: '@aws-blocks/bb-file-bucket',
      description: 'File storage backed by Amazon S3.',
    });
    assert.ok(rendered.split('\n').length > 1, 'expected the wrapped form');
    assert.ok(widest(rendered) <= MAX);
    assert.match(rendered, /^\t\[\n\t\t'FileBucket',\n\t\t\{\n/);
  });

  it('puts the string on its own line when even `description: …` would overflow', () => {
    const rendered = renderEntry({
      type: 'AuthBasic',
      category: 'auth',
      source: '@aws-blocks/bb-auth-basic',
      description: 'Simple username/password authentication with JWT sessions, password policy, and optional reset.',
    });
    assert.match(rendered, /\n\t\t\tdescription:\n\t\t\t\t'/);
  });

  it('never breaks a string literal to satisfy the width, because biome cannot either', () => {
    // A description longer than the whole line budget still emits one literal;
    // the line is over 120 columns and biome accepts that, so asserting a width
    // here would be asserting something false.
    const description = 'y'.repeat(200);
    const rendered = renderEntry({ type: 'X', category: 'data', source: '@a/b', description });
    const literalLines = rendered.split('\n').filter((line) => line.includes(description));
    assert.equal(literalLines.length, 1);
  });

  it('emits valid, re-parseable TypeScript for a description containing quotes', () => {
    const rendered = renderEntry({
      type: 'X',
      category: 'data',
      source: '@a/b',
      description: "The app's own store.",
    });
    // Evaluating the rendered entry is the only check that proves it parses.
    const [type, value] = new Function(`return ${rendered.replace(/,$/, '')}`)();
    assert.equal(type, 'X');
    assert.equal(value.description, "The app's own store.");
  });
});
