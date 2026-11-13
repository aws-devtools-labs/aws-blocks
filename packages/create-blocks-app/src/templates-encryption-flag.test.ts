import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// The bb-data storage-encryption flag. bb-data encrypts Database storage by
// default, so the flag is optional: absent or `true` means encrypted, and only
// `false` opts out (keeping an existing unencrypted cluster as-is). New projects
// still ship with it set to `true` to make the choice visible in the project.
// This test keeps the templates from drifting to a different value (CDK templates
// via cdk.json; the Amplify overlay, which has no cdk.json, via a setContext call
// in aws-blocks/index.cdk.ts).
const FLAG = '@aws-blocks/bb-data:encryptStorageByDefault';

// Compiled test runs from dist/; templates live at the package root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../templates');

const templateNames = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('create-blocks-app templates set the storage-encryption flag', () => {
  it('discovers template directories to check', () => {
    assert.ok(templateNames.length > 0, `no template directories found under ${TEMPLATES_DIR}`);
  });

  for (const name of templateNames) {
    it(`template "${name}" sets ${FLAG} to true`, () => {
      const templateDir = join(TEMPLATES_DIR, name);
      const cdkJsonPath = join(templateDir, 'cdk.json');

      if (existsSync(cdkJsonPath)) {
        // Standalone CDK template: the flag lives in cdk.json context as a boolean.
        const cdkJson = JSON.parse(readFileSync(cdkJsonPath, 'utf-8'));
        assert.strictEqual(
          cdkJson?.context?.[FLAG],
          true,
          `${name}/cdk.json must set context["${FLAG}"] to boolean true`,
        );
      } else {
        // Amplify-style overlay: no cdk.json (Amplify synthesizes via `ampx`), so
        // the flag is set in code via stack.node.setContext(FLAG, true).
        const cdkEntry = join(templateDir, 'aws-blocks', 'index.cdk.ts');
        assert.ok(
          existsSync(cdkEntry),
          `${name} has no cdk.json and no aws-blocks/index.cdk.ts in which to set ${FLAG}`,
        );
        const source = readFileSync(cdkEntry, 'utf-8');
        assert.match(
          source,
          /setContext\(\s*['"]@aws-blocks\/bb-data:encryptStorageByDefault['"]\s*,\s*true\s*\)/,
          `${name}/aws-blocks/index.cdk.ts must call setContext('${FLAG}', true)`,
        );
      }
    });
  }
});
