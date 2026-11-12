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

  /** Scaffold into a fresh existing project; return its directory and the CLI's output. */
  const runAddBlocks = (files: Record<string, string>): { dir: string; stdout: string } => {
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
    return { dir, stdout: result.stdout };
  };

  /** Scaffold into a fresh existing project and return its directory. */
  const addBlocks = (files: Record<string, string>): string => runAddBlocks(files).dir;

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

  /** Paths in `dir` that its `.gitignore` does not ignore. */
  const notIgnored = (dir: string, paths: string[]) => {
    const result = spawnSync(
      'git',
      ['-c', `core.excludesFile=${join(dir, '.no-global-excludes')}`, 'check-ignore', ...paths],
      { cwd: dir, encoding: 'utf-8' },
    );
    const ignored = result.stdout.split('\n').filter(Boolean);
    return paths.filter((p) => !ignored.includes(p));
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
    // Git applies the last matching line, so the `.env` line alone doesn't make it present.
    'a project whose .gitignore un-ignores .env after ignoring it': {
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      '.gitignore': '.env\n!.env\n',
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

  // The new lines change the project's ignore policy (`.env.*` also covers
  // `.env.development` / `.env.production`), so the plan and the result say so.
  it('tells the user which .gitignore entries it adds', () => {
    const { dir, stdout } = runAddBlocks({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      '.gitignore': 'node_modules\n.env\n',
    });
    try {
      assert.match(stdout, /MODIFY {2}\.gitignore .*secret and key-material patterns/);
      const modified = stdout.split('\n').find((line) => line.includes('Modified .gitignore'));
      assert.ok(modified, `no "Modified .gitignore" line in:\n${stdout}`);
      for (const entry of ['.blocks-sandbox', '.env.*', '*.pem', '.aws/', '!.env.example']) {
        assert.ok(modified.includes(entry), `"${modified}" does not list ${entry}`);
      }
      assert.ok(!/[(,] ?\.env[,)]/.test(modified), `"${modified}" lists .env, which the project already ignores`);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('appends with the line ending of a CRLF .gitignore', () => {
    const dir = addBlocks({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      '.gitignore': 'node_modules\r\n.env.local\r\n',
    });
    try {
      const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
      assert.ok(gitignore.includes('*.pem'), 'secret patterns were appended');
      assert.doesNotMatch(gitignore, /(?<!\r)\n/, 'every line ends with CRLF');
      assertIgnoresSecrets(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  // The `!.env.example` / `!credentials/` exceptions come last, so appending one
  // after a line the project already had would un-ignore what that line ignores.
  const alreadyIgnored: Record<string, string> = {
    'credentials/': 'credentials/service-account.json',
    'config/credentials/': 'config/credentials/service-account.json',
    '.env*': '.env.example',
    '*.example': '.env.example',
  };
  for (const [line, path] of Object.entries(alreadyIgnored)) {
    it(`keeps ${path} ignored when the existing .gitignore has ${line}`, () => {
      const dir = addBlocks({ 'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }), '.gitignore': `${line}\n` });
      try {
        assert.deepStrictEqual(notIgnored(dir, [path, ...SECRET_PATHS]), []);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
  for (const name of templateNames) {
    const backend = join(TEMPLATES_DIR, name, 'aws-blocks', 'index.ts');
    if (!existsSync(backend)) continue;
    const source = stripComments(readFileSync(backend, 'utf-8'));
    // Deny by default: an `auth.protect` namespace runs its methods only after the
    // session check (the auth.protect test below checks they are in `methods`).
    if (/export const api = auth\.protect\(/.test(source)) continue;

    for (const method of ['getValue', 'setValue']) {
      if (!source.includes(`async ${method}(`)) continue;
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

describe('create-blocks-app auth template defines its signed-in methods with auth.protect', () => {
  const source = stripComments(readFileSync(join(TEMPLATES_DIR, 'auth', 'aws-blocks', 'index.ts'), 'utf-8'));
  const protect = source.match(/export const api = auth\.protect\(scope, 'api', \{([\s\S]*?)\n\}\);/);

  it('the template\'s api namespace is auth.protect(...)', () => {
    assert.ok(protect, 'auth template: export const api = auth.protect(scope, \'api\', { ... }) not found');
  });

  const parts = protect?.[1].split(/\n  methods: \(context, user\) => \(\{/) ?? [];
  for (const method of ['getValue', 'setValue', 'whoAmI', 'createTodo', 'listTodos', 'updateTodo', 'deleteTodo']) {
    it(`auth template ${method} is a protected method (in methods, not public)`, () => {
      assert.strictEqual(parts.length, 2, 'auth template: a single `methods: (context, user) => ({` factory');
      assert.ok(!new RegExp(`async ${method}\\(`).test(parts[0]), `${method} must not be a public method`);
      assert.ok(new RegExp(`async ${method}\\(`).test(parts[1]), `${method} must be in methods`);
    });
  }
});

/** `Auth` methods that take `context` and throw 401 without a signed-in session. */
const SESSION_GATED_AUTH_METHODS = [
  'getUserAttributes',
  'updateUserAttributes',
  'confirmUserAttribute',
  'sendUserAttributeVerificationCode',
  'updatePassword',
  'scanDevices',
  'rememberDevice',
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
  agent: { 'api.ping': 'public: liveness probe, touches no data' },
  amplify: { 'api.greet': PUBLIC_GREETING },
  'api-only': { 'api.health': 'public: liveness probe, touches no data' },
  // `api` is `auth.protect(...)`: deny-by-default, checked by the auth.protect test above.
  auth: { 'hello.greet': PUBLIC_GREETING },
  backend: { 'api.greet': PUBLIC_GREETING },
  bare: { 'api.greet': PUBLIC_GREETING },
  // The template has no auth block. Its store only holds what the two cron handlers write.
  cron: { 'api.lastRun': 'public: when a scheduled job last fired and how often, no user data' },
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
  /** Names the method's parameters bind (the caller's arguments), including destructured ones. */
  parameters: string[];
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
        methods.push({
          name: `${nsArg.text}.${property.name.getText(sourceFile)}`,
          parameters: property.parameters.flatMap((p) => boundNames(p.name)),
          body: property.body,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return methods;
}

/** Every name a parameter binds, including destructured and rest elements (`{ id, ...rest }`). */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name)));
}

/** The identifier an expression is read from: `updates` for `updates`, `updates.fields` or `updates['x']`. */
function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let node = expression;
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return ts.isIdentifier(node) ? node : undefined;
}

/**
 * Where `method` copies one of its arguments wholesale into an object: an
 * object spread (`...updates`, `...updates.fields`) or an `Object.assign(…)`
 * argument read from a parameter, including a destructured or rest one.
 */
function argumentSpreads(method: TemplateMethod): string[] {
  const spreads: string[] = [];
  const fromParameter = (expression: ts.Expression) => {
    const root = rootIdentifier(expression);
    return !!root && method.parameters.includes(root.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isSpreadAssignment(node) && fromParameter(node.expression)) {
      spreads.push(`${method.name} (...${node.expression.getText()})`);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText() === 'Object.assign'
    ) {
      for (const argument of node.arguments) {
        if (fromParameter(argument)) spreads.push(`${method.name} (Object.assign(…, ${argument.getText()}))`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(method.body);
  return spreads;
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

    // RPC arguments are not checked at runtime, so `{ ...existing, ...updates }`
    // lets a caller set any field, including the owner key that scopes the row.
    it(`template "${name}" never spreads or Object.assigns a caller's argument into an object`, () => {
      const spreads = apiMethods(backend).flatMap(argumentSpreads);
      assert.deepStrictEqual(spreads, [], `${name}: copy the fields a caller may set instead of spreading the argument`);
    });
  }
});

/**
 * FileBucket methods that sign a URL. Whoever holds the URL (or the handle
 * built on it) can read or write that key until it expires, with no further
 * auth check, so only a gated method may hand one out.
 */
const PRESIGNING_METHODS = ['getUrl', 'putUrl', 'getFileHandle', 'createUploadHandle'];

/**
 * Every `<x>.getUrl|putUrl|getFileHandle|createUploadHandle(…)` call in `file`,
 * with the API method it sits in (`undefined` when it is outside every
 * ApiNamespace method, e.g. in a module-level helper).
 *
 * Matches on the method name, whatever the receiver, as `<bucket>.<method>(…)`
 * or `<bucket>['<method>'](…)`. Templates must call the FileBucket presign
 * methods that way: a destructured or `bind`-aliased call
 * (`const { getUrl } = files`) is not seen by this check.
 */
function presignedUrlCalls(file: string): { call: string; method?: TemplateMethod }[] {
  const methods = apiMethods(file);
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
  const calls: { call: string; method?: TemplateMethod }[] = [];
  const presignedName = (callee: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
      return callee.argumentExpression.text;
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && PRESIGNING_METHODS.includes(presignedName(node.expression) ?? '')) {
      // Offsets match across parses of the same text, so the enclosing method is the one whose body spans the call.
      const method = methods.find((m) => m.body.pos <= node.pos && node.end <= m.body.end);
      calls.push({ call: node.expression.getText(sourceFile), method });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/** The presigned-URL calls in `file` that a signed-out caller could reach, each with why. */
function ungatedPresignedUrlCalls(file: string, allowed: Record<string, string>): string[] {
  return presignedUrlCalls(file).flatMap(({ call, method }) => {
    if (!method) return [`${call} (outside an API method, so its gate can't be checked)`];
    // Checked before the gate: a URL-signing method listed in UNGATED is fixed by removing it from the list.
    if (method.name in allowed) return [`${method.name} → ${call} (listed in UNGATED)`];
    if (!gatesFirst(method.body)) return [`${method.name} → ${call} (does not start with requireAuth/requireRole)`];
    return [];
  });
}

// A presigned URL is a bearer credential for one object: an ungated method that
// mints one lets anyone on the internet read or write that key. Checked across
// every template, so a new template (or a new method) can't ship one signed out.
describe('create-blocks-app template methods that return a presigned URL require auth', () => {
  // Counted when the tests are registered, not inside them, so the guard below
  // holds under --test-name-pattern / --test-only too.
  const callsPerTemplate: Record<string, number> = {};
  for (const name of templateNames) {
    const dir = join(TEMPLATES_DIR, name, 'aws-blocks');
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.ts') && !f.split(/[\\/]/).includes('node_modules'))
      .map((f) => join(dir, f));
    callsPerTemplate[name] = files.reduce((total, file) => total + presignedUrlCalls(file).length, 0);

    it(`template "${name}" signs URLs only inside API methods that gate first`, () => {
      const allowed = UNGATED[name] ?? {};
      for (const file of files) {
        assert.deepStrictEqual(
          ungatedPresignedUrlCalls(file, allowed),
          [],
          `${name} (${file}): start these methods with \`await auth.requireAuth(context)\` before signing a URL, and keep them out of UNGATED`,
        );
      }
    });
  }

  // Guards against the check passing because it found nothing to check.
  for (const name of ['api-only', 'demo']) {
    it(`finds the presigned-URL calls template "${name}" ships`, () => {
      assert.ok((callsPerTemplate[name] ?? 0) > 0, `${name}: expected at least one presigned-URL call, found none`);
    });
  }
});

describe('ungatedPresignedUrlCalls', () => {
  it('flags a presigned URL minted signed out, outside an API method, or by a method listed as public', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cba-presign-'));
    const file = join(dir, 'index.ts');
    writeFileSync(
      file,
      `const sign = (path: string) => files.getUrl(path);
      export const api = new ApiNamespace(scope, 'api', (context) => ({
        async gated(path: string) { const user = await auth.requireAuth(context); return files.putUrl(path); },
        async role(path: string) { await auth.requireRole(context, 'admin'); return files.getFileHandle(path); },
        async open(path: string) { return { url: await files.getUrl(path) }; },
        async late(path: string) { const url = await files.createUploadHandle(path); await auth.requireAuth(context); return url; },
        async listed(path: string) { await auth.requireAuth(context); return files.getUrl(path); },
        async publicSigner(path: string) { return files.putUrl(path); },
        async indexed(path: string) { return files['getFileHandle'](path); },
      }));`,
    );
    try {
      assert.deepStrictEqual(ungatedPresignedUrlCalls(file, { 'api.listed': 'test', 'api.publicSigner': 'test' }), [
        "files.getUrl (outside an API method, so its gate can't be checked)",
        'api.open → files.getUrl (does not start with requireAuth/requireRole)',
        'api.late → files.createUploadHandle (does not start with requireAuth/requireRole)',
        'api.listed → files.getUrl (listed in UNGATED)',
        // Listed and ungated: the fix is to drop it from UNGATED (and gate it), so name the listing.
        'api.publicSigner → files.putUrl (listed in UNGATED)',
        "api.indexed → files['getFileHandle'] (does not start with requireAuth/requireRole)",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('argumentSpreads', () => {
  it('flags every way a method copies a caller argument wholesale into an object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cba-spreads-'));
    const file = join(dir, 'index.ts');
    writeFileSync(
      file,
      `export const api = new ApiNamespace(scope, 'api', (context) => ({
        async bare(updates: object) { return { ...existing, ...updates }; },
        async assign(updates: object) { return Object.assign(existing, updates); },
        async member(updates: { fields: object }) { return { ...updates.fields }; },
        async rest({ id, ...rest }: { id: string }) { return { id, ...rest }; },
        async nested([{ ...inner }]: object[]) { return { ...inner }; },
        async picked(updates: { title?: string }) { return { ...existing, title: updates.title }; },
      }));`,
    );
    try {
      assert.deepStrictEqual(apiMethods(file).flatMap(argumentSpreads), [
        'api.bare (...updates)',
        'api.assign (Object.assign(…, updates))',
        'api.member (...updates.fields)',
        'api.rest (...rest)',
        'api.nested (...inner)',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A template's FileBucket is the starting point for every scaffolded app's file
// storage. Keep versioning on (the FileBucket default) so an overwritten or
// deleted object can be restored, and sign presigned uploads only for an
// explicit set of content types.
describe('create-blocks-app template file buckets are versioned and uploads are typed', () => {
  for (const name of templateNames) {
    const backend = join(TEMPLATES_DIR, name, 'aws-blocks', 'index.ts');
    if (!existsSync(backend)) continue;
    const source = stripComments(readFileSync(backend, 'utf-8'));
    if (!source.includes('new FileBucket(')) continue;

    it(`${name}: no FileBucket turns versioning off`, () => {
      assert.doesNotMatch(source, /versioned:\s*false/, `${name} must keep FileBucket versioning on`);
    });

    // `createUploadHandle` signs a presigned PUT too (from `putUrl` on AWS).
    if (/\.(putUrl|createUploadHandle)\(/.test(source)) {
      it(`${name}: presigned uploads check the content type against an allowlist`, () => {
        assert.match(
          source,
          /ALLOWED_UPLOAD_TYPES\.has\(contentType\)/,
          `${name} must check contentType before putUrl / createUploadHandle`,
        );
      });
    }
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
