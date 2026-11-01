// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deployedConfigFile, writeDeployedConfig } from './deployed-config.js';
import { specConfigFile } from './generate-spec.js';

describe('deployed config — where a deploy records its API URL', () => {
  it('writes config.<stage>.json, never the dev server config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-deployed-config-'));
    try {
      const out = join(dir, '.blocks-sandbox');
      writeDeployedConfig(out, 'production', 'https://p.example/aws-blocks/api');
      writeDeployedConfig(out, 'sandbox', 'https://s.example/aws-blocks/api');
      assert.deepStrictEqual(readdirSync(out).sort(), ['config.production.json', 'config.sandbox.json']);
      assert.ok(!existsSync(join(out, 'config.json')));
      assert.deepStrictEqual(JSON.parse(readFileSync(join(out, deployedConfigFile('sandbox')), 'utf-8')), {
        apiUrl: 'https://s.example/aws-blocks/api',
        environment: 'sandbox',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the spec a deployed server only for an explicit BLOCKS_SPEC_STAGE', () => {
    assert.strictEqual(specConfigFile(undefined), 'config.json');
    assert.strictEqual(specConfigFile('local'), 'config.json');
    assert.strictEqual(specConfigFile('sandbox'), 'config.sandbox.json');
    assert.strictEqual(specConfigFile('production'), 'config.production.json');
  });
});
