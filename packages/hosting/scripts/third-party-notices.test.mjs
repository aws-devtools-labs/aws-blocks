// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for third-party-notices.mjs, run against a fake node_modules tree and
// a hand-written esbuild metafile in a temp directory.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildThirdPartyNotices } from './third-party-notices.mjs';

let root;
let apacheFile;

/** Writes a fake package under node_modules and returns its metafile input path. */
function fakePackage(name, pkgJson, files = {}) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgJson));
  writeFileSync(join(dir, 'index.js'), 'module.exports = 1;\n');
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return `node_modules/${name}/index.js`;
}

/** One bundle whose metafile lists `inputs` (path -> bytesInOutput). */
function bundle(inputs, name = 'handler.mjs') {
  const entries = Object.fromEntries(Object.entries(inputs).map(([p, bytes]) => [p, { bytesInOutput: bytes }]));
  return { name, metafile: { inputs: {}, outputs: { [`out/${name}`]: { inputs: entries } } } };
}

const run = (inputs) => buildThirdPartyNotices([bundle(inputs)], root, apacheFile);

before(() => {
  root = mkdtempSync(join(tmpdir(), 'third-party-notices-'));
  apacheFile = join(root, 'APACHE-LICENSE-2.0.txt');
  writeFileSync(apacheFile, 'Apache License\nVersion 2.0, January 2004\n');
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('buildThirdPartyNotices', () => {
  it('fails for a license outside the allowlist', () => {
    const input = fakePackage('gpl-pkg', { name: 'gpl-pkg', version: '1.0.0', license: 'GPL-3.0' }, { LICENSE: 'GPL text' });
    assert.throws(() => run({ [input]: 10 }), /gpl-pkg@1\.0\.0: license "GPL-3\.0" is not in the allowlist/);
  });

  it('fails for an AND expression with a license outside the allowlist', () => {
    const input = fakePackage(
      'gpl-and-pkg',
      { name: 'gpl-and-pkg', version: '1.0.0', license: 'GPL-3.0 AND (MIT OR ISC)' },
      { LICENSE: 'text' },
    );
    assert.throws(() => run({ [input]: 10 }), /gpl-and-pkg@1\.0\.0: license "GPL-3\.0 AND \(MIT OR ISC\)" is not in the allowlist/);
  });

  it('passes an AND expression whose licenses are all in the allowlist', () => {
    const input = fakePackage(
      'mit-and-bsd-pkg',
      { name: 'mit-and-bsd-pkg', version: '1.0.0', license: 'MIT AND BSD-3-Clause' },
      { LICENSE: 'text' },
    );
    assert.match(run({ [input]: 10 }), /License: MIT AND BSD-3-Clause/);
  });

  it('uses the shared Apache text for an Apache-2.0 package without a LICENSE file', () => {
    const input = fakePackage('@aws-sdk/no-license', { name: '@aws-sdk/no-license', version: '3.0.0', license: 'Apache-2.0' });
    const out = run({ [input]: 10 });
    assert.match(out, /Package: @aws-sdk\/no-license/);
    assert.match(out, /reproduced at the end of this file/);
    assert.match(out, /Apache License\nVersion 2\.0, January 2004/);
  });

  it('fails for an MIT package without a LICENSE file', () => {
    const input = fakePackage('mit-no-license', { name: 'mit-no-license', version: '1.0.0', license: 'MIT' });
    assert.throws(() => run({ [input]: 10 }), /mit-no-license@1\.0\.0: no LICENSE file/);
  });

  it('skips inputs that contribute no bytes', () => {
    const used = fakePackage('used-pkg', { name: 'used-pkg', version: '1.0.0', license: 'MIT' }, { LICENSE: 'MIT text' });
    const unused = fakePackage('unused-pkg', { name: 'unused-pkg', version: '1.0.0', license: 'GPL-3.0' });
    const out = run({ [used]: 10, [unused]: 0 });
    assert.match(out, /Package: used-pkg/);
    assert.doesNotMatch(out, /unused-pkg/);
  });

  it('reads string entries in a legacy licenses array', () => {
    const input = fakePackage('legacy-pkg', { name: 'legacy-pkg', version: '1.0.0', licenses: ['MIT', { type: 'ISC' }] }, { LICENSE: 'text' });
    assert.match(run({ [input]: 10 }), /License: MIT OR ISC/);
  });

  it('produces identical output across runs', () => {
    const a = fakePackage('pkg-a', { name: 'pkg-a', version: '1.0.0', license: 'MIT' }, { LICENSE: 'A', NOTICE: 'A notice' });
    const b = fakePackage('pkg-b', { name: 'pkg-b', version: '2.0.0', license: 'ISC' }, { 'LICENSE.md': 'B' });
    const bundles = () => [bundle({ [b]: 5, [a]: 5 }, 'z.mjs'), bundle({ [a]: 1 }, 'a.mjs')];
    const first = buildThirdPartyNotices(bundles(), root, apacheFile);
    const second = buildThirdPartyNotices(bundles(), root, apacheFile);
    assert.equal(first, second);
    assert.ok(first.indexOf('Package: pkg-a') < first.indexOf('Package: pkg-b'));
  });

  it('errors when a bundled package.json has no name', () => {
    const input = fakePackage('nameless', { version: '1.0.0', license: 'MIT' }, { LICENSE: 'text' });
    assert.throws(() => run({ [input]: 10 }), /has no "name" or "version"/);
  });

  it('errors when a bundled package.json has no version', () => {
    const input = fakePackage('versionless', { name: 'versionless', license: 'MIT' }, { LICENSE: 'text' });
    assert.throws(() => run({ [input]: 10 }), /has no "name" or "version"/);
  });
});
