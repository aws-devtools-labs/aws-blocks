import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// A scaffold that cannot reach the registry must fail, and must not leave the
// `"*"` placeholder behind. `"*"` is a valid range, so a project carrying it
// installs whatever is newest on every clean install — including a breaking
// release. The placeholder is removed before npm is asked to add the packages,
// so a failed install leaves the dependency absent rather than unpinned.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

// A registry that cannot answer, with retries off so the failure is immediate.
const UNREACHABLE_REGISTRY = {
  npm_config_registry: 'http://127.0.0.1:1/',
  npm_config_fetch_retries: '0',
  npm_config_fetch_retry_mintimeout: '1',
  npm_config_fetch_retry_maxtimeout: '5',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
};

let workDir: string;
let cliPath: string;

before(() => {
  // Lay the package out the way npm installs it: outside the monorepo, so the
  // CLI takes its published path rather than rewriting deps to file: paths.
  workDir = mkdtempSync(join(tmpdir(), 'blocks-failclosed-'));
  const installed = join(workDir, 'node_modules', '@aws-blocks', 'create-blocks-app');
  for (const entry of ['dist', 'templates', 'resources', 'package.json']) {
    const from = join(PKG_ROOT, entry);
    if (existsSync(from)) cpSync(from, join(installed, entry), { recursive: true });
  }
  // The published CLI's runtime dependencies, which npm would have installed.
  for (const dep of ['ci-info']) {
    const from = join(PKG_ROOT, '..', '..', 'node_modules', dep);
    if (existsSync(from)) cpSync(from, join(workDir, 'node_modules', dep), { recursive: true });
  }
  cliPath = join(installed, 'dist', 'index.js');
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Every manifest under `dir` that a scaffold may have written. */
function manifestsUnder(dir: string): string[] {
  return [join(dir, 'package.json'), join(dir, 'aws-blocks', 'package.json')].filter((p) => existsSync(p));
}

/**
 * The four paths that put `@aws-blocks/*` into a customer project. Each is run
 * in the published layout, so the CLI cannot fall back to `file:` paths.
 */
const SCAFFOLD_PATHS: { label: string; args: string[]; seed?: (dir: string) => void }[] = [
  { label: 'a fresh project', args: ['--template', 'default', '--yes', '--skip-install'] },
  { label: 'a fresh project from a backend-only template', args: ['--template', 'backend', '--yes', '--skip-install'] },
  {
    label: 'an existing project',
    args: ['.', '--yes', '--skip-install'],
    seed: (dir) => writeFileSync(join(dir, 'package.json'), '{"name":"existing","version":"1.0.0"}'),
  },
  {
    label: 'an Amplify Gen 2 project',
    args: ['.', '--yes', '--skip-install'],
    seed: (dir) => {
      writeFileSync(join(dir, 'package.json'), '{"name":"amp","version":"1.0.0"}');
      mkdirSync(join(dir, 'amplify'), { recursive: true });
      writeFileSync(join(dir, 'amplify', 'backend.ts'), 'export const backend = defineBackend({});\n');
    },
  },
];

describe('a published scaffold that cannot reach the registry', () => {
  for (const [index, path] of SCAFFOLD_PATHS.entries()) {
    it(`fails and never leaves a "*" behind when adding to ${path.label}`, () => {
      const targetDir = join(workDir, `case-${index}`);
      mkdirSync(targetDir, { recursive: true });
      path.seed?.(targetDir);

      const args = path.args[0] === '.' ? path.args : [targetDir, ...path.args];
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: targetDir,
        encoding: 'utf-8',
        env: { ...process.env, ...UNREACHABLE_REGISTRY },
        timeout: 120_000,
      });

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      assert.notStrictEqual(result.status, 0, `expected a non-zero exit, got ${result.status}\n${output}`);

      // The scaffold may be half-written — the install is what failed — but no
      // manifest may carry the placeholder, which npm would resolve to whatever
      // is newest on the next clean install.
      const written = manifestsUnder(targetDir);
      assert.ok(written.length > 0, `expected at least one manifest\n${output}`);
      for (const manifestPath of written) {
        const deps = JSON.parse(readFileSync(manifestPath, 'utf-8')).dependencies ?? {};
        for (const [name, spec] of Object.entries(deps)) {
          assert.notStrictEqual(spec, '*', `${manifestPath} left ${name} as the "*" placeholder`);
        }
      }
    });
  }
});
