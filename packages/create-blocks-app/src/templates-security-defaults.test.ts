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
  'config/credentials',
  '.aws/credentials',
];

/** App files that must stay committable despite the secret patterns. */
const APP_PATHS = ['.env.example', 'src/features/credentials/CredentialsForm.tsx'];

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

      // The documented example env file, and app code in a `credentials/`
      // directory, stay committable.
      for (const path of APP_PATHS) {
        assert.strictEqual(checkIgnore(path).status, 1, `${name}/gitignore must not ignore ${path}`);
      }
    });
  }
});

/** `source` with `/* … *\/` and `// …` comments removed, so a doc comment can't satisfy a check on the code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/** Body of `async <method>(...) { ... }` in a template backend, up to its closing `},`. */
function methodBody(source: string, method: string): string {
  const match = source.match(new RegExp(`async ${method}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\},`));
  assert.ok(match, `method ${method} not found`);
  return match[1];
}

describe('create-blocks-app template key-value methods require auth', () => {
  for (const name of ['demo', 'auth-cognito']) {
    const source = stripComments(readFileSync(join(TEMPLATES_DIR, name, 'aws-blocks', 'index.ts'), 'utf-8'));

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

describe('create-blocks-app demo template gates its data-changing and secret methods', () => {
  const source = stripComments(readFileSync(join(TEMPLATES_DIR, 'demo', 'aws-blocks', 'index.ts'), 'utf-8'));

  const gated = [
    'getUploadSlot',
    'getFileHandle',
    'setFlag',
    'rotateApiKey',
    'getApiKey',
    'getPreviousApiKey',
    'apiKeyVersionCount',
    'sendWelcome',
    'runGreetingJob',
  ];
  for (const method of gated) {
    it(`demo ${method} calls requireAuth before anything else`, () => {
      const body = methodBody(source, method).trim();
      assert.match(
        body,
        /^(const user = )?await auth\.requireAuth\(context\);/,
        `demo ${method} must start with auth.requireAuth(context)`,
      );
    });
  }

  it('demo KV keys use an encoded, prefixed per-user namespace', () => {
    // `user:` keeps user keys apart from app keys (`job-ran:`); encoding stops a
    // `:` in the username from moving the user/key boundary.
    assert.match(source, /`user:\$\{encodeURIComponent\(username\)\}:\$\{key\}`/);
    for (const method of ['getValue', 'setValue']) {
      assert.match(methodBody(source, method), /store\.(get|put)\(userKey\(user\.username, key\)/);
    }
  });

  it('demo file paths are scoped per user', () => {
    for (const method of ['getUploadSlot', 'getFileHandle']) {
      assert.match(methodBody(source, method), /files\.\w+\(userPath\(user\.username, path\)/);
    }
  });
});

describe('create-blocks-app template cookies are fixed-name, HttpOnly, SameSite=Lax', () => {
  for (const name of templateNames) {
    const backend = join(TEMPLATES_DIR, name, 'aws-blocks', 'index.ts');
    if (!existsSync(backend)) continue;
    const source = stripComments(readFileSync(backend, 'utf-8'));
    if (!/set-cookie/i.test(source)) continue;

    it(`template "${name}" sets only safe cookies`, () => {
      assert.doesNotMatch(source, /SameSite=None/i, `${name} must not set SameSite=None cookies`);
      assert.doesNotMatch(source, /Domain=/i, `${name} cookies must not set Domain`);
      assert.match(source, /HttpOnly/, `${name} cookies must be HttpOnly`);
      assert.match(source, /SameSite=Lax/, `${name} cookies must be SameSite=Lax`);
      assert.match(source, /Secure/, `${name} cookies must be Secure outside plain-HTTP localhost`);
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

  it('demo template applies its cookie attributes to every set-cookie header', () => {
    const source = stripComments(readFileSync(join(TEMPLATES_DIR, 'demo', 'aws-blocks', 'index.ts'), 'utf-8'));
    const calls = [...source.matchAll(/headers\.set\(\s*'set-cookie',([\s\S]*?)\);/g)];
    assert.ok(calls.length >= 2, 'expected the setCookie and deleteCookie set-cookie calls');
    for (const [call, header] of calls) {
      assert.match(header, /demoCookieAttrs\(context\.request\.headers\)/, `missing cookie attributes: ${call}`);
    }
  });
});
