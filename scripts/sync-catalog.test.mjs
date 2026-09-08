// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Run: node --test scripts/sync-catalog.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractBetweenMarkers, extractBlurb, injectCatalog } from './sync-catalog.mjs';

const BEGIN_MARKER = '<!-- BEGIN:block-catalog -->';
const END_MARKER = '<!-- END:block-catalog -->';

describe('extractBlurb', () => {
  const cases = [
    {
      name: 'returns the first sentence after the h1',
      content: '# Block\n\nProvides the first capability. Additional details follow.',
      expected: 'Provides the first capability.',
    },
    {
      name: 'returns the whole line when it has no sentence-ending period',
      content: '# Block\nProvides a capability without punctuation',
      expected: 'Provides a capability without punctuation',
    },
    {
      name: 'skips blank lines after the h1',
      content: '# Block\n\n  \nProvides a capability.',
      expected: 'Provides a capability.',
    },
    {
      name: 'returns empty when the document has no h1',
      content: '## Block\nProvides a capability.',
      expected: '',
    },
    {
      name: 'stops at a heading before descriptive text',
      content: '# Block\n\n## Usage\nProvides a capability.',
      expected: '',
    },
    {
      name: 'stops at an HTML comment before descriptive text',
      content: '# Block\n\n<!-- generated -->\nProvides a capability.',
      expected: '',
    },
  ];

  for (const { name, content, expected } of cases) {
    it(name, () => {
      assert.equal(extractBlurb(content), expected);
    });
  }
});

describe('catalog markers', () => {
  const readme = `Before\n${BEGIN_MARKER}\nOld table\n${END_MARKER}\nAfter`;

  it('extracts the content between valid markers', () => {
    assert.equal(extractBetweenMarkers(readme), '\nOld table\n');
  });

  it('injects a catalog without changing content outside the markers', () => {
    assert.equal(
      injectCatalog(readme, 'New table'),
      `Before\n${BEGIN_MARKER}\nNew table\n${END_MARKER}\nAfter`,
    );
  });

  const invalidCases = [
    { name: 'missing begin marker', readme: `Before\n${END_MARKER}\nAfter` },
    { name: 'missing end marker', readme: `Before\n${BEGIN_MARKER}\nAfter` },
    { name: 'end marker before begin marker', readme: `${END_MARKER}\n${BEGIN_MARKER}` },
  ];

  for (const { name, readme: invalidReadme } of invalidCases) {
    it(`returns null for ${name}`, () => {
      assert.equal(extractBetweenMarkers(invalidReadme), null);
    });

    it(`throws on write for ${name}`, () => {
      assert.throws(() => injectCatalog(invalidReadme, 'New table'), /catalog markers .* not found/);
    });
  }
});
