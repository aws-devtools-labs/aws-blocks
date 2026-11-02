import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// A scaffolded app keeps the @aws-blocks/* ranges its template declares, so a
// "*" there means a fresh install of an old app pulls whatever the latest release
// is, breaking changes included. The release tooling
// (scripts/sync-template-versions.ts) keeps every range on `^<version>` of the
// release create-blocks-app ships with.

// Compiled test runs from dist/; the package root is one level up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..');
const TEMPLATES_DIR = join(PACKAGE_ROOT, 'templates');
const CARET_RANGE = /^\^\d+\.\d+\.\d+$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

type PackageJson = Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>;
const readPkg = (path: string): PackageJson => JSON.parse(readFileSync(path, 'utf-8'));

function templatePackageJsons(dir = TEMPLATES_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...templatePackageJsons(path));
    else if (entry.name === 'package.json') found.push(path);
  }
  return found;
}

const blocksDeps = (pkg: PackageJson): Array<[string, string]> =>
  DEP_FIELDS.flatMap((field) => Object.entries(pkg[field] ?? {})).filter(([name]) => name.startsWith('@aws-blocks/'));

describe('create-blocks-app template @aws-blocks/* ranges', () => {
  const files = templatePackageJsons();

  it('finds the template package.json files, including the nested amplify one', () => {
    assert.ok(files.length > 0, `no package.json found under ${TEMPLATES_DIR}`);
    assert.ok(files.some((f) => f.endsWith(join('amplify', 'aws-blocks', 'package.json'))));
  });

  for (const file of files) {
    it(`${relative(TEMPLATES_DIR, file)} pins each @aws-blocks/* dependency to a caret range`, () => {
      for (const [name, range] of blocksDeps(readPkg(file))) {
        assert.match(range, CARET_RANGE, `${name} is "${range}"; run scripts/sync-template-versions.ts --write`);
      }
    });
  }
});

// Runs the CLI the way `npm create @aws-blocks/blocks-app` does: installed under
// node_modules/@aws-blocks/, with no monorepo siblings next to it. Inside the
// monorepo the CLI rewrites @aws-blocks/* to file: paths, which would hide the
// ranges it writes for customers.
describe('create-blocks-app from a registry install writes the template ranges', () => {
  let root: string;
  let cli: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'create-blocks-app-registry-'));
    const installed = join(root, 'node_modules', '@aws-blocks', 'create-blocks-app');
    for (const entry of ['package.json', 'dist', 'templates', 'resources']) {
      cpSync(join(PACKAGE_ROOT, entry), join(installed, entry), {
        recursive: true,
        filter: (src) => !src.split(/[\\/]/).includes('node_modules'),
      });
    }
    // The CLI's own runtime dependency, resolved from where npm would hoist it.
    const ciInfo = dirname(createRequire(import.meta.url).resolve('ci-info/package.json'));
    symlinkSync(ciInfo, join(root, 'node_modules', 'ci-info'), 'dir');
    cli = join(installed, 'dist', 'index.js');
  });

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const run = (args: string[], cwd: string): string =>
    execFileSync('node', [cli, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop' },
    });

  const templateRange = (template: string, name = '@aws-blocks/blocks'): string => {
    const range = readPkg(join(TEMPLATES_DIR, template, 'package.json')).dependencies?.[name];
    assert.ok(range, `templates/${template} declares no ${name}`);
    return range;
  };

  it('a new app gets the template ranges', () => {
    const appDir = join(root, 'new-app');
    run([appDir, '--template', 'default', '--skip-install', '-y'], root);
    const deps = readPkg(join(appDir, 'package.json')).dependencies ?? {};
    assert.strictEqual(deps['@aws-blocks/blocks'], templateRange('default'));
    assert.strictEqual(deps['@aws-blocks/hosting'], templateRange('default', '@aws-blocks/hosting'));
  });

  it('adding Blocks to an existing project uses the template range for @aws-blocks/blocks', () => {
    const appDir = join(root, 'existing-app');
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'existing-app', version: '1.0.0' }));
    run(['-y', '--skip-install'], appDir);
    assert.strictEqual(readPkg(join(appDir, 'package.json')).dependencies?.['@aws-blocks/blocks'], templateRange('default'));
  });

  it('adding Blocks to an Amplify Gen 2 project uses the amplify template range for @aws-blocks/blocks', () => {
    const appDir = join(root, 'amplify-app');
    mkdirSync(join(appDir, 'amplify'), { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'amplify-app', version: '1.0.0' }));
    writeFileSync(join(appDir, 'amplify', 'backend.ts'), 'export const backend = defineBackend({});');
    run(['-y', '--skip-install'], appDir);
    assert.strictEqual(
      readPkg(join(appDir, 'package.json')).dependencies?.['@aws-blocks/blocks'],
      templateRange(join('amplify', 'aws-blocks')),
    );
  });
});
