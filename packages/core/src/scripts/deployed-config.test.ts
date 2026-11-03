// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deployedConfigFile, migrateLegacyDeployedConfig, writeDeployedConfig } from './deployed-config.js';
import { legacyDeployedStage } from '../client/legacy-config.js';
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

  it("tells an older deploy's config.json from a dev server's", () => {
    assert.strictEqual(legacyDeployedStage({ apiUrl: 'https://p.example/aws-blocks/api', environment: 'production' }), 'production');
    assert.strictEqual(legacyDeployedStage({ apiUrl: 'https://s.example/prod/aws-blocks/api', environment: 'sandbox' }), 'sandbox');
    // The dev servers of `cdk-blocks dev` and `cdk-blocks sandbox` (which proxies to the sandbox) write http URLs.
    assert.strictEqual(legacyDeployedStage({ apiUrl: 'http://localhost:3000/aws-blocks/api', environment: 'local' }), null);
    assert.strictEqual(legacyDeployedStage({ apiUrl: 'http://10.0.0.5:3000/aws-blocks/api', environment: 'sandbox' }), null);
    assert.strictEqual(legacyDeployedStage(null), null);
  });

  it("moves an older deploy's config.json to its stage file, keeps a newer record, and leaves a dev server's alone", () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-legacy-config-'));
    const out = join(dir, '.blocks-sandbox');
    const write = (name: string, body: unknown) => writeFileSync(join(out, name), JSON.stringify(body));
    const read = (name: string) => JSON.parse(readFileSync(join(out, name), 'utf-8'));
    try {
      mkdirSync(out);
      migrateLegacyDeployedConfig(out); // no config.json: nothing to do
      const prod = { apiUrl: 'https://stub/aws-blocks/api', environment: 'production' };
      write('config.json', prod);
      migrateLegacyDeployedConfig(out);
      assert.ok(!existsSync(join(out, 'config.json')));
      assert.deepStrictEqual(read('config.production.json'), prod);

      write('config.json', { apiUrl: 'https://old/aws-blocks/api', environment: 'production' });
      migrateLegacyDeployedConfig(out);
      assert.ok(!existsSync(join(out, 'config.json')));
      assert.deepStrictEqual(read('config.production.json'), prod, 'a newer deploy record wins');

      const local = { apiUrl: 'http://localhost:3000/aws-blocks/api', environment: 'sandbox' };
      write('config.json', local);
      migrateLegacyDeployedConfig(out);
      assert.deepStrictEqual(read('config.json'), local);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
