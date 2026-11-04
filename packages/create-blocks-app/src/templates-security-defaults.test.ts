import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';

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
  '.bb-data/settings.json',
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

// Adding Blocks to an existing project patches its .gitignore instead of
// copying a template one, so the scaffolder has to add the same patterns.
describe('create-blocks-app adds secret patterns to an existing project .gitignore', () => {
  const CLI_PATH = join(__dirname, 'index.js');

  /** Scaffold into a fresh existing project and return its directory. */
  const addBlocks = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cba-existing-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const result = spawnSync('node', [CLI_PATH, '-y', '--skip-install'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop' },
    });
    assert.strictEqual(result.status, 0, `create-blocks-app failed: ${result.stderr}`);
    const init = spawnSync('git', ['init', '-q', dir]);
    assert.strictEqual(init.status, 0, `git init failed: ${init.stderr}`);
    return dir;
  };

  const assertIgnoresSecrets = (dir: string) => {
    const checkIgnore = (...paths: string[]) =>
      spawnSync('git', ['-c', `core.excludesFile=${join(dir, '.no-global-excludes')}`, 'check-ignore', ...paths], {
        cwd: dir,
        encoding: 'utf-8',
      });
    const ignored = checkIgnore(...SECRET_PATHS).stdout.split('\n').filter(Boolean);
    const missing = SECRET_PATHS.filter((p) => !ignored.includes(p));
    assert.deepStrictEqual(missing, [], `.gitignore does not ignore: ${missing.join(', ')}`);
    for (const path of APP_PATHS) {
      assert.strictEqual(checkIgnore(path).status, 1, `.gitignore must not ignore ${path}`);
    }
  };

  const projects: Record<string, Record<string, string>> = {
    'a project with no .gitignore': { 'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }) },
    // `.env.local` contains `.env`: a substring check would wrongly skip it.
    'a project whose .gitignore already ignores .env.local': {
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      '.gitignore': 'node_modules\n.env.local\n',
    },
    'an Amplify Gen 2 project': {
      'package.json': JSON.stringify({ name: 'amplify-app', version: '1.0.0' }),
      'amplify/backend.ts': 'export const backend = defineBackend({});',
    },
  };

  for (const [label, files] of Object.entries(projects)) {
    it(`ignores secrets and key material in ${label}`, () => {
      const dir = addBlocks(files);
      try {
        assertIgnoresSecrets(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });
  }

  it('keeps the existing .gitignore content and does not repeat its entries', () => {
    const dir = addBlocks({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      '.gitignore': 'node_modules\n.env\n',
    });
    try {
      const lines = readFileSync(join(dir, '.gitignore'), 'utf-8').split('\n');
      assert.deepStrictEqual(lines.slice(0, 2), ['node_modules', '.env']);
      assert.strictEqual(lines.filter((l) => l === '.env').length, 1, '.env is listed twice');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
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

/** AuthCognito methods that take `context` and throw 401 without a signed-in session. */
const SESSION_GATED_AUTH_METHODS = [
  'fetchUserAttributes',
  'updateUserAttributes',
  'confirmUserAttribute',
  'sendUserAttributeVerificationCode',
  'updatePassword',
  'fetchDevices',
  'forgetDevice',
];

/** Reason for a method that is gated by the auth block method it calls rather than by its first statement. */
const SESSION_GATED = 'gated: calls an auth block method that requires a signed-in session';

const PUBLIC_GREETING = 'public: static hello-world, touches no data';

/**
 * Template RPC methods that do not start with `requireAuth`/`requireRole`,
 * keyed `<namespace>.<method>`, each with its reason. Every other method in
 * every template must gate first: ApiNamespace methods are public,
 * internet-reachable endpoints by default, and a template is the security
 * posture every scaffolded app starts from. Adding a method to this list is a
 * security decision — say why it is safe to call signed out.
 */
const UNGATED: Record<string, Record<string, string>> = {
  amplify: { 'api.greet': PUBLIC_GREETING },
  'api-only': { 'api.health': 'public: liveness probe, touches no data' },
  'auth-cognito': {
    'hello.greet': PUBLIC_GREETING,
    'api.ping': 'public: liveness probe, touches no data',
    'api.fetchUserAttributes': SESSION_GATED,
    'api.updateDepartment': SESSION_GATED,
    'api.updateEmail': SESSION_GATED,
    'api.confirmAttribute': SESSION_GATED,
    'api.sendAttributeVerificationCode': SESSION_GATED,
    'api.changePassword': SESSION_GATED,
    'api.listDevices': SESSION_GATED,
    'api.forgetCurrentDevice': SESSION_GATED,
    'api.signOutEverywhere': "public: signs out the caller's own session, a no-op without one",
    'api.getLastCode': 'public: local mock only, returns null when BLOCKS_STACK_NAME is set (every deployed Lambda)',
  },
  backend: { 'api.greet': PUBLIC_GREETING },
  bare: { 'api.greet': PUBLIC_GREETING },
  demo: {
    'hello.greet': PUBLIC_GREETING,
    'api.getFlag': 'public: reads one app-wide, non-secret flag',
    'api.jobRan': 'public: returns whether a named demo job ran (a boolean)',
    'api.setCookie': 'public: fixed-name HttpOnly SameSite=Lax cookie (see the cookie checks below)',
    'api.getCookie': 'public: reads back the fixed-name demo cookie',
    'api.deleteCookie': 'public: clears the fixed-name demo cookie',
  },
  nextjs: {
    'api.greet': PUBLIC_GREETING,
    'api.getServerTime': 'public: returns the server clock, touches no data',
  },
};

interface TemplateMethod {
  /** `<namespace>.<method>` */
  name: string;
  body: ts.Block;
}

/** Every method of every `new ApiNamespace(scope, '<namespace>', (context) => ({ … }))` in `file`. */
function apiMethods(file: string): TemplateMethod[] {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
  const methods: TemplateMethod[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(sourceFile) === 'ApiNamespace') {
      const [, nsArg, factory] = node.arguments ?? [];
      assert.ok(nsArg && ts.isStringLiteral(nsArg), `${file}: ApiNamespace needs a string literal namespace`);
      assert.ok(factory && ts.isArrowFunction(factory), `${file}: ${nsArg.text} factory must be an arrow function`);
      let object: ts.Expression | ts.ConciseBody = factory.body;
      while (ts.isParenthesizedExpression(object)) object = object.expression;
      assert.ok(ts.isObjectLiteralExpression(object), `${file}: ${nsArg.text} factory must return an object literal`);
      for (const property of object.properties) {
        assert.ok(
          ts.isMethodDeclaration(property) && property.body,
          `${file}: ${nsArg.text} members must be method declarations (async name(…) { … })`,
        );
        methods.push({ name: `${nsArg.text}.${property.name.getText(sourceFile)}`, body: property.body });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return methods;
}

/** `node` is `auth.<method>(context, …)`. */
function isAuthCall(node: ts.Node, methodNames: string[]): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === 'auth' &&
    methodNames.includes(node.expression.name.text) &&
    node.arguments[0]?.getText() === 'context'
  );
}

/** The method's first statement is `[const x = ]await auth.requireAuth|requireRole(context…)`. */
function gatesFirst(body: ts.Block): boolean {
  const first = body.statements[0];
  if (!first) return false;
  let expression: ts.Expression | undefined;
  if (ts.isExpressionStatement(first)) expression = first.expression;
  else if (ts.isVariableStatement(first) && first.declarationList.declarations.length === 1) {
    expression = first.declarationList.declarations[0].initializer;
  }
  return (
    !!expression && ts.isAwaitExpression(expression) && isAuthCall(expression.expression, ['requireAuth', 'requireRole'])
  );
}

/** The method body calls `auth.<session-gated method>(context…)`. */
function callsSessionGatedAuth(body: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (isAuthCall(node, SESSION_GATED_AUTH_METHODS)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

describe('create-blocks-app template RPC methods require auth unless listed as public', () => {
  for (const name of templateNames) {
    const backend = join(TEMPLATES_DIR, name, 'aws-blocks', 'index.ts');
    if (!existsSync(backend)) continue;

    it(`template "${name}" gates every API method that is not listed in UNGATED`, () => {
      const methods = apiMethods(backend);
      assert.ok(methods.length > 0, `${name}: no ApiNamespace methods found`);
      const allowed = UNGATED[name] ?? {};

      const ungated = methods.filter((m) => !gatesFirst(m.body)).map((m) => m.name);
      const unlisted = ungated.filter((m) => !(m in allowed));
      assert.deepStrictEqual(
        unlisted,
        [],
        `${name}: start these methods with \`await auth.requireAuth(context)\`, or list them in UNGATED with the reason they are safe to call signed out`,
      );

      // A listed method that is now gated, or gone, makes the list claim more is public than is.
      const stale = Object.keys(allowed).filter((m) => !ungated.includes(m));
      assert.deepStrictEqual(stale, [], `${name}: remove these from UNGATED (gated or no longer present)`);

      // "Gated by the auth block" must stay true of the code, not just the list.
      for (const method of methods) {
        if (allowed[method.name] !== SESSION_GATED) continue;
        assert.ok(
          callsSessionGatedAuth(method.body),
          `${name} ${method.name} is listed as gated by the auth block but calls none of ${SESSION_GATED_AUTH_METHODS.join(', ')}`,
        );
      }
    });
  }
});

describe('create-blocks-app demo template scopes per-user data', () => {
  const source = stripComments(readFileSync(join(TEMPLATES_DIR, 'demo', 'aws-blocks', 'index.ts'), 'utf-8'));

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
