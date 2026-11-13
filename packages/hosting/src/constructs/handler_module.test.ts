// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { resolveHandlerModule } from './handler_module.js';

const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'handler-module-'));
after(() => fs.rmSync(bundle, { recursive: true, force: true }));

void describe('resolveHandlerModule', () => {
  void it('splits the setting at its last dot and finds the module by extension (.mjs, .js, .cjs)', () => {
    fs.mkdirSync(path.join(bundle, 'server'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'server', 'index.js'), '');
    fs.writeFileSync(path.join(bundle, 'server', 'index.cjs'), '');
    assert.deepEqual(resolveHandlerModule(bundle, 'server/index.handler'), {
      moduleBase: 'server/index',
      exportName: 'handler',
      moduleFile: 'server/index.js',
    });
    fs.writeFileSync(path.join(bundle, 'server', 'index.mjs'), '');
    assert.equal(resolveHandlerModule(bundle, 'server/index.handler')?.moduleFile, 'server/index.mjs');
  });

  void it('reports a missing module, and a setting without a module and an export', () => {
    assert.deepEqual(resolveHandlerModule(bundle, 'missing.handler'), {
      moduleBase: 'missing',
      exportName: 'handler',
      moduleFile: undefined,
    });
    assert.equal(resolveHandlerModule(bundle, 'handler'), undefined);
    assert.equal(resolveHandlerModule(bundle, '.handler'), undefined);
  });
});
