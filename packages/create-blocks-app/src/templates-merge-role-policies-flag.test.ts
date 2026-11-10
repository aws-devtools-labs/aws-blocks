// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// The core execution-role statement-merging opt-in. New projects must ship with it
// set; existing apps opt in themselves. A regenerated/edited template that drops it
// should fail CI (CDK templates via cdk.json; the Amplify overlay, which has no
// cdk.json, via a setContext call in aws-blocks/index.cdk.ts).
const FLAG = '@aws-blocks/core:mergeExecutionRolePolicies';

// Compiled test runs from dist/; templates live at the package root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../templates');

const templateNames = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('create-blocks-app templates turn on execution-role statement merging', () => {
  it('discovers template directories to check', () => {
    assert.ok(templateNames.length > 0, `no template directories found under ${TEMPLATES_DIR}`);
  });

  for (const name of templateNames) {
    it(`template "${name}" enables ${FLAG}`, () => {
      const templateDir = join(TEMPLATES_DIR, name);
      const cdkJsonPath = join(templateDir, 'cdk.json');

      if (existsSync(cdkJsonPath)) {
        const cdkJson = JSON.parse(readFileSync(cdkJsonPath, 'utf-8'));
        assert.strictEqual(
          cdkJson?.context?.[FLAG],
          true,
          `${name}/cdk.json must set context["${FLAG}"] to boolean true`,
        );
      } else {
        const cdkEntry = join(templateDir, 'aws-blocks', 'index.cdk.ts');
        assert.ok(existsSync(cdkEntry), `${name} has no cdk.json and no aws-blocks/index.cdk.ts in which to set ${FLAG}`);
        assert.match(
          readFileSync(cdkEntry, 'utf-8'),
          /setContext\(\s*['"]@aws-blocks\/core:mergeExecutionRolePolicies['"]\s*,\s*true\s*\)/,
          `${name}/aws-blocks/index.cdk.ts must call setContext('${FLAG}', true)`,
        );
      }
    });
  }
});
