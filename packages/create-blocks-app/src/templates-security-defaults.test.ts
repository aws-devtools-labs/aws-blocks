import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Secure defaults that scaffolded apps inherit (AppSec finding): templates must
// not commit secrets, must gate the sample key-value methods behind auth, and
// must not let callers set arbitrary cookies. A regenerated/edited template that
// regresses any of these should fail CI.

// Compiled test runs from dist/; templates live at the package root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../templates');

const templateNames = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** Paths that hold secrets or key material and must be git-ignored. */
const SECRET_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
  'server.pem',
  'tls.key',
  'cert.p12',
  'credentials',
  '.aws/credentials',
];

describe('create-blocks-app template .gitignore covers secrets', () => {
  let repo: string;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'cba-gitignore-'));
    const init = spawnSync('git', ['init', '-q', repo]);
    assert.strictEqual(init.status, 0, `git init failed: ${init.stderr}`);
  });

  after(() => rmSync(repo, { recursive: true, force: true }));

  // Ignore the developer's global excludes file so only the template's rules count.
  const checkIgnore = (...paths: string[]) =>
    spawnSync('git', ['-c', `core.excludesFile=${join(repo, '.no-global-excludes')}`, 'check-ignore', ...paths], {
      cwd: repo,
      encoding: 'utf-8',
    });

  for (const name of templateNames) {
    const templateDir = join(TEMPLATES_DIR, name);
    // Overlay templates (e.g. amplify) have no cdk.json and no gitignore: they
    // integrate into an existing project rather than scaffolding a new repo.
    if (!existsSync(join(templateDir, 'cdk.json'))) continue;

    it(`template "${name}" ignores secrets and key material`, () => {
      const gitignore = join(templateDir, 'gitignore');
      assert.ok(existsSync(gitignore), `${name} must ship a gitignore`);
      copyFileSync(gitignore, join(repo, '.gitignore'));

      // `git check-ignore` prints each ignored path; exit 1 means none matched.
      const result = checkIgnore(...SECRET_PATHS);
      const ignored = result.stdout.split('\n').filter(Boolean);
      const missing = SECRET_PATHS.filter((p) => !ignored.includes(p));
      assert.deepStrictEqual(missing, [], `${name}/gitignore does not ignore: ${missing.join(', ')}`);

      // The documented example env file stays committable.
      const example = checkIgnore('.env.example');
      assert.strictEqual(example.status, 1, `${name}/gitignore must not ignore .env.example`);
    });
  }
});

/** Body of `async <method>(...) { ... }` in a template backend, up to its closing `},`. */
function methodBody(source: string, method: string): string {
  const match = source.match(new RegExp(`async ${method}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\},`));
  assert.ok(match, `method ${method} not found`);
  return match[1];
}

describe('create-blocks-app template key-value methods require auth', () => {
  for (const name of ['demo', 'auth-cognito']) {
    const source = readFileSync(join(TEMPLATES_DIR, name, 'aws-blocks', 'index.ts'), 'utf-8');

    for (const method of ['getValue', 'setValue']) {
      it(`template "${name}" gates ${method} with requireAuth before touching the store`, () => {
        const body = methodBody(source, method);
        const gate = body.indexOf('auth.requireAuth(context)');
        const storeCall = body.search(/store\.(get|put)\(/);
        assert.ok(gate !== -1, `${name} ${method} must call auth.requireAuth(context)`);
        assert.ok(storeCall > gate, `${name} ${method} must call requireAuth before the store`);
      });
    }
  }
});

describe('create-blocks-app template cookies are fixed-name, HttpOnly, SameSite=Lax', () => {
  for (const name of templateNames) {
    const backend = join(TEMPLATES_DIR, name, 'aws-blocks', 'index.ts');
    if (!existsSync(backend)) continue;
    const source = readFileSync(backend, 'utf-8');
    if (!/set-cookie/i.test(source)) continue;

    it(`template "${name}" sets only safe cookies`, () => {
      assert.doesNotMatch(source, /SameSite=None/i, `${name} must not set SameSite=None cookies`);
      assert.match(source, /HttpOnly/, `${name} cookies must be HttpOnly`);
      assert.match(source, /SameSite=Lax/, `${name} cookies must be SameSite=Lax`);
      for (const method of ['setCookie', 'getCookie', 'deleteCookie']) {
        if (!source.includes(`async ${method}(`)) continue;
        assert.doesNotMatch(
          source,
          new RegExp(`async ${method}\\([^)]*\\bname\\b`),
          `${name} ${method} must not take a caller-chosen cookie name`,
        );
      }
    });
  }
});
