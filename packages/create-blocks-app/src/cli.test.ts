import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import assert from 'node:assert';
import { SAFE_TO_SCAFFOLD_ENTRIES, SAFE_TO_SCAFFOLD_PATTERN } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '../dist/index.js');

/**
 * The dev server settings that `blocks dev` resolves for an app, from the built
 * `@aws-blocks/blocks` CLI in this repository: what the scaffolded `blocks.dev` does.
 */
async function resolvedDevConfig(root: string): Promise<{ frontendCommand?: string; port?: number; source: string }> {
  // A runtime path, not a static import: `@aws-blocks/blocks` exports no `cli/config`, and
  // create-blocks-app does not depend on it, so the test loads the sibling package's build.
  const config = pathToFileURL(join(__dirname, '../../blocks/dist/cli/config.js')).href;
  const { resolveDevConfig } = await import(config);
  return resolveDevConfig(root);
}

function run(args: string[], cwd?: string, env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      cwd,
      // Every run spawns the real CLI, which calls trackCommand. Opt out, and point the
      // endpoint at a dead port so a regression cannot reach the production collector.
      env: {
        ...process.env,
        AWS_BLOCKS_DISABLE_TELEMETRY: '1',
        BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop',
        ...env,
      },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

describe('create-blocks-app CLI argument parsing', () => {
  it('--help prints usage and exits 0', () => {
    const result = run(['--help']);
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /Usage: create-blocks-app/);
    assert.match(result.stdout, /--template/);
    assert.match(result.stdout, /Available templates: default, bare, react, backend, api-only, sql, nextjs, auth-cognito, amplify, demo/);
    assert.match(result.stdout, /--skip-install/);
    assert.match(result.stdout, /--help/);
    assert.match(result.stdout, /auto-detected/);
  });

  it('-h prints usage and exits 0', () => {
    const result = run(['-h']);
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /Usage: create-blocks-app/);
  });

  it('--help includes template descriptions', () => {
    const result = run(['--help']);
    assert.strictEqual(result.exitCode, 0);
    assert.match(
      result.stdout,
      /default\s+Vite \+ lit-html frontend with auth/,
      '--help should list the default template with its blocksTemplateDescription',
    );
  });

  it('unknown flag exits 1 with error message', () => {
    const result = run(['--foo']);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /Unknown option: --foo/);
    assert.match(result.stderr, /--help/);
  });

  it('unknown short flag exits 1 with error message', () => {
    const result = run(['-z']);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /Unknown option: -z/);
  });

  it('--template without a value exits 1 with error message', () => {
    const result = run(['--template']);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /Missing value for --template/);
    assert.match(result.stderr, /--help/);
  });

  it('--template followed by another option exits 1 with error message', () => {
    const result = run(['--template', '--skip-install']);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /Missing value for --template/);
    assert.match(result.stderr, /--help/);
  });
  
  it('unknown template exits 1 with a friendly error message', () => {
    const result = run(['--template', 'does-not-exist']);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /Unknown template "does-not-exist"/);
    assert.match(result.stderr, /Available templates:/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  });

  it('a template folder missing package.json is rejected as unknown, not crashed with ENOENT', () => {
    // Latent-bug guard: a folder under templates/ with no package.json is shown
    // in --help but excluded from validation, so selecting it fails cleanly
    // instead of throwing ENOENT on the later template version read.
    const brokenDir = join(__dirname, '../templates', '__broken_test_template__');
    mkdirSync(brokenDir, { recursive: true });
    try {
      const result = run(['my-app', '--template', '__broken_test_template__', '--skip-install']);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.stderr, /Unknown template "__broken_test_template__"/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
    } finally {
      rmSync(brokenDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('--template amplify on a fresh dir exits 1 with a helpful message', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'create-blocks-app-amplify-fresh-'));
    try {
      const result = run([tmpDir, '--template', 'amplify', '--skip-install', '-y']);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.stderr, /amplify.*auto-selected/i);
      assert.match(result.stderr, /--template default/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('multiple positional args exits 1 with error message', () => {
    const result = run(['my-app', 'extra-arg']);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /Unexpected argument: extra-arg/);
  });

  it('--help takes priority even with other args', () => {
    const result = run(['my-app', '--help']);
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /Usage: create-blocks-app/);
  });
});

describe('create-blocks-app template metadata', () => {
  it('every deployable template has a build script', () => {
    const templatesDir = join(__dirname, '..', 'templates');
    const templates = readdirSync(templatesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const missing: string[] = [];
    for (const name of templates) {
      const pkgPath = join(templatesDir, name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const scripts = JSON.parse(readFileSync(pkgPath, 'utf-8')).scripts ?? {};
      // Keep this in step with the standard vendorize-script guard below:
      // a template with a sandbox lifecycle is deployable and must expose build.
      if (scripts.sandbox && (typeof scripts.build !== 'string' || scripts.build.length === 0)) {
        missing.push(name);
      }
    }
    assert.deepStrictEqual(missing, [], `Deployable templates missing "build": ${missing.join(', ')}`);
  });

  it('every deployable template runs its lifecycle scripts through the blocks CLI', () => {
    // The npm script names stay the same; each one is a thin alias of a `blocks`
    // command, so no template ships aws-blocks/scripts/*.ts wrappers any more.
    // `sandbox:deploy` is the one-shot variant of `sandbox` that CI uses.
    const expected: Record<string, string> = {
      dev: 'blocks dev',
      'dev:server': 'blocks dev',
      'dev:stop': 'blocks dev stop',
      sandbox: 'blocks sandbox',
      'sandbox:deploy': 'blocks sandbox deploy',
      'sandbox:destroy': 'blocks sandbox destroy',
      'sandbox:console': 'blocks sandbox console',
      cleanup: 'blocks dev stop --all',
      deploy: 'blocks deploy',
      destroy: 'blocks destroy',
      secret: 'blocks secret',
      typegen: 'blocks generate types',
      spec: 'blocks generate spec',
      vendorize: 'blocks vendorize',
    };
    const templatesDir = join(__dirname, '..', 'templates');
    const problems: string[] = [];
    for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(templatesDir, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const scripts: Record<string, string> = JSON.parse(readFileSync(pkgPath, 'utf-8')).scripts ?? {};
      if (!scripts.sandbox) continue;
      for (const name of ['dev', 'dev:stop', 'sandbox', 'sandbox:deploy', 'sandbox:destroy', 'deploy', 'destroy']) {
        if (!(name in scripts)) problems.push(`${entry.name}: missing "${name}"`);
      }
      for (const [name, value] of Object.entries(scripts)) {
        if (name in expected && value !== expected[name]) {
          problems.push(`${entry.name}: "${name}" should be "${expected[name]}", not "${value}"`);
        }
        if (value.includes('aws-blocks/scripts')) problems.push(`${entry.name}: "${name}" still runs ${value}`);
      }
      if (existsSync(join(templatesDir, entry.name, 'aws-blocks', 'scripts'))) {
        problems.push(`${entry.name}: still ships aws-blocks/scripts/`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });

  it('every deployable template sets its dev server in package.json "blocks.dev"', () => {
    // `blocks dev` and the sandbox's dev server read these settings; they replace
    // the options the removed aws-blocks/scripts/server.ts passed to startDevServer.
    const vite = { frontendCommand: 'npx vite --port 3100 --strictPort', frontendPort: 3100 };
    const expected: Record<string, unknown> = {
      'api-only': { port: 3001, frontend: false },
      backend: { port: 3001, frontend: false },
      sql: { port: 3001, frontend: false },
      nextjs: { frontendCommand: 'npx next dev --webpack --hostname 127.0.0.1 --port 3100', frontendPort: 3100 },
      'auth-cognito': vite,
      bare: vite,
      default: vite,
      demo: vite,
      react: vite,
    };
    const templatesDir = join(__dirname, '..', 'templates');
    const actual: Record<string, unknown> = {};
    for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(templatesDir, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.sandbox) actual[entry.name] = pkg.blocks?.dev;
    }
    assert.deepStrictEqual(actual, expected);
  });

  it('every HTML template declares a UTF-8 charset', () => {
    // Without it, a host that sends `Content-Type: text/html` with no charset
    // (S3, most static servers) makes the browser decode the page as
    // windows-1252, so any non-ASCII text in the HTML or a classic script
    // renders as mojibake. Browsers only honour the tag in the first 1024 bytes.
    const templatesDir = join(__dirname, '..', 'templates');
    const problems: string[] = [];
    for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const htmlPath = join(templatesDir, entry.name, 'index.html');
      if (!existsSync(htmlPath)) continue;
      const head = readFileSync(htmlPath, 'utf-8').slice(0, 1024);
      if (!/<head>\s*<meta charset="utf-8"\s*\/?>/i.test(head)) {
        problems.push(`${entry.name}: index.html should open <head> with <meta charset="utf-8">`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });

  it('nextjs template wraps each page section in its own error boundary', () => {
    // error.tsx covers the whole route: without per-section boundaries, one
    // failing Server Component replaces the page, client components included.
    const pageDir = join(__dirname, '..', 'templates', 'nextjs', 'src', 'app');
    assert.ok(existsSync(join(pageDir, 'section-boundary.tsx')), 'section-boundary.tsx is missing');
    const sections = readFileSync(join(pageDir, 'page.tsx'), 'utf-8').match(/<section[\s\S]*?<\/section>/g) ?? [];
    assert.ok(sections.length > 0, 'page.tsx has no <section> elements');
    const unwrapped = sections.filter((section) => !section.includes('<SectionBoundary>'));
    assert.deepStrictEqual(unwrapped, [], 'every <section> in page.tsx should wrap its content in <SectionBoundary>');
  });

  it('the amplify overlay keeps only the generator the blocks CLI does not cover', () => {
    // `blocks generate client` writes the standard client; the overlay's client
    // needs an Amplify preamble (auth middleware, API URL from amplify_outputs.json).
    const scriptsDir = join(__dirname, '..', 'templates', 'amplify', 'aws-blocks', 'scripts');
    assert.deepStrictEqual(readdirSync(scriptsDir), ['generate-client.ts']);
  });
});

describe('create-blocks-app auto-detection', () => {
  it('detects existing project with package.json when no target dir given', () => {
    const tmpDir = join(__dirname, '../.test-autodetect-no-arg');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }));
    try {
      const result = run(['-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /Detected existing project/);
      assert.match(result.stdout, /Created aws-blocks/);
      assert.match(readFileSync(join(tmpDir, '.gitignore'), 'utf-8'), /^\.bb-data\/$/m);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('deployable templates declare a floating CDK CLI dependency', () => {
    const templatesDir = join(__dirname, '..', 'templates');
    const missingOrPinned: string[] = [];

    for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const pkgPath = join(templatesDir, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;

      const packageJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (!packageJson.scripts?.sandbox) continue;

      const cdkVersion = packageJson.devDependencies?.['aws-cdk'];
      if (typeof cdkVersion !== 'string' || !cdkVersion.startsWith('^2.')) {
        missingOrPinned.push(entry.name);
      }
    }

    assert.deepStrictEqual(
      missingOrPinned,
      [],
      `Deployable templates must declare a floating aws-cdk 2.x dependency: ${missingOrPinned.join(', ')}`,
    );
  });

  it('detects existing project with package.json when "." is given', () => {
    const tmpDir = join(__dirname, '../.test-autodetect-dot');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-nextjs-app', version: '1.0.0' }));
    try {
      const result = run(['.', '-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /Detected existing project/);
      assert.match(result.stdout, /Created aws-blocks/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('detects Amplify Gen 2 project over plain project, and keeps its Blocks dev server backend-only', async () => {
    const tmpDir = join(__dirname, '../.test-autodetect-amplify');
    mkdirSync(join(tmpDir, 'amplify'), { recursive: true });
    // An Amplify app usually has its own frontend dependency, which `blocks dev` would otherwise start.
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'amplify-app', version: '1.0.0', devDependencies: { vite: '*', next: '*' } }),
    );
    writeFileSync(join(tmpDir, 'amplify', 'backend.ts'), 'export const backend = defineBackend({});');
    try {
      const result = run(['-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /Detected Amplify Gen 2 project/);
      assert.match(readFileSync(join(tmpDir, '.gitignore'), 'utf-8'), /^\.bb-data\/$/m);
      const packageJson = JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf-8'));
      const generateClientPath = join(tmpDir, 'aws-blocks', 'scripts', 'generate-client.ts');
      const cognitoVerifierPath = join(tmpDir, 'aws-blocks', 'cognito-verifier.ts');
      assert.strictEqual(packageJson.scripts['blocks:dev'], 'blocks dev');
      assert.strictEqual(packageJson.scripts['blocks:stop'], 'blocks dev stop');
      // The Blocks dev server stays backend-only on :3001, as the removed server.ts set it,
      // even with vite and next installed: the Amplify app runs its own frontend.
      assert.deepStrictEqual(packageJson.blocks, { dev: { port: 3001, frontend: false } });
      const dev = await resolvedDevConfig(tmpDir);
      assert.strictEqual(dev.frontendCommand, undefined);
      assert.strictEqual(dev.port, 3001);
      assert.ok(!existsSync(join(tmpDir, 'aws-blocks', 'scripts', 'server.ts')));
      assert.ok(!existsSync(join(tmpDir, 'aws-blocks', 'scripts', 'stop.ts')));
      assert.match(readFileSync(generateClientPath, 'utf-8'), /from '@aws-blocks\/blocks\/scripts'/);
      assert.match(readFileSync(cognitoVerifierPath, 'utf-8'), /from '@aws-blocks\/blocks'/);
      assert.doesNotMatch(readFileSync(generateClientPath, 'utf-8'), /@aws-blocks\/core/);
      assert.doesNotMatch(readFileSync(cognitoVerifierPath, 'utf-8'), /@aws-blocks\/core/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('generates a lazy backend import for the React template Lambda handler', () => {
    const tmpDir = join(__dirname, '../.test-react-lambda-handler');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'react-app', version: '1.0.0' }));
    try {
      const result = run(['-y', '--skip-install', '--template', 'react'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      const handler = readFileSync(join(tmpDir, 'aws-blocks', 'index.handler.ts'), 'utf-8');
      assert.match(handler, /createLambdaHandler\(\(\) => import\('\.\/index\.js'\)\)/);
      assert.doesNotMatch(handler, /import \* as backend/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('handles Yarn Classic workspace format (object with packages array)', () => {
    const tmpDir = join(__dirname, '../.test-yarn-classic');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'yarn-classic-project',
      version: '1.0.0',
      workspaces: { packages: ['packages/*'] }
    }));
    try {
      const result = run(['-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /Created aws-blocks/);
      assert.match(result.stdout, /Modified package.json/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('does not add "type": "module" to root package.json', () => {
    const tmpDir = join(__dirname, '../.test-no-type-module');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'cjs-project', version: '1.0.0' }));
    try {
      const result = run(['-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      const pkg = JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf-8'));
      assert.strictEqual(pkg.type, undefined, 'should not add "type": "module" to root package.json');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('errors on non-empty directory without package.json when explicit target given', () => {
    const tmpDir = join(__dirname, '../.test-nonempty-no-pkg');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'somefile.txt'), 'content');
    try {
      const result = run([tmpDir]);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.stderr, /not empty/);
      // The error now lists the conflicting (non-allowlisted) entries.
      assert.match(result.stderr, /somefile\.txt/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('scaffolds a fresh project into a directory containing only allowlisted files (e.g. INSTRUCTIONS.md)', () => {
    const tmpDir = join(__dirname, '../.test-nonempty-allowlisted');
    mkdirSync(tmpDir, { recursive: true });
    // Benign, allowlisted seed files (e.g. a benchmark-seeded INSTRUCTIONS.md)
    // must not block a fresh scaffold.
    writeFileSync(join(tmpDir, 'INSTRUCTIONS.md'), '# seed instructions');
    try {
      const result = run([tmpDir, '-y', '--skip-install']);
      assert.strictEqual(result.exitCode, 0);
      // A fresh Blocks app was scaffolded into the directory.
      assert.ok(existsSync(join(tmpDir, 'aws-blocks')), 'expected aws-blocks/ to be scaffolded');
      assert.ok(existsSync(join(tmpDir, 'package.json')), 'expected root package.json to be created');
      // The original seed file is preserved.
      assert.strictEqual(readFileSync(join(tmpDir, 'INSTRUCTIONS.md'), 'utf-8'), '# seed instructions');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('lists conflicting files but omits allowlisted siblings from the conflict output', () => {
    const tmpDir = join(__dirname, '../.test-nonempty-mixed');
    mkdirSync(tmpDir, { recursive: true });
    // A mix of an allowlisted seed file and a genuine conflict: only the
    // conflict should be reported, proving allowlisted entries are filtered out.
    writeFileSync(join(tmpDir, 'INSTRUCTIONS.md'), '# seed instructions');
    writeFileSync(join(tmpDir, 'realfile.txt'), 'content');
    try {
      const result = run([tmpDir]);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.stderr, /realfile\.txt/);
      assert.doesNotMatch(result.stderr, /INSTRUCTIONS\.md/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('blocks scaffolding on a pre-existing README.md and preserves it (no overwrite)', () => {
    const tmpDir = join(__dirname, '../.test-nonempty-readme');
    mkdirSync(tmpDir, { recursive: true });
    // The template ships a README.md, so a user's README.md must block
    // scaffolding rather than being silently overwritten.
    writeFileSync(join(tmpDir, 'README.md'), '# my original readme');
    try {
      const result = run([tmpDir]);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.stderr, /README\.md/);
      // The original file is untouched on disk.
      assert.strictEqual(readFileSync(join(tmpDir, 'README.md'), 'utf-8'), '# my original readme');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('blocks scaffolding on a pre-existing .gitignore and preserves it (no overwrite)', () => {
    const tmpDir = join(__dirname, '../.test-nonempty-gitignore');
    mkdirSync(tmpDir, { recursive: true });
    // The template ships a .gitignore (renamed from gitignore), so a user's
    // .gitignore must block scaffolding rather than being silently overwritten.
    writeFileSync(join(tmpDir, '.gitignore'), '# my original gitignore');
    try {
      const result = run([tmpDir]);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.stderr, /\.gitignore/);
      // The original file is untouched on disk.
      assert.strictEqual(readFileSync(join(tmpDir, '.gitignore'), 'utf-8'), '# my original gitignore');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('treats an editor project file as safe and scaffolds a fresh project', () => {
    const tmpDir = join(__dirname, '../.test-nonempty-iml');
    mkdirSync(tmpDir, { recursive: true });
    // A stray *.iml file is safe-to-scaffold-over and must not block a fresh scaffold.
    writeFileSync(join(tmpDir, 'project.iml'), '<module />');
    try {
      const result = run([tmpDir, '-y', '--skip-install']);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(existsSync(join(tmpDir, 'aws-blocks')), 'expected aws-blocks/ to be scaffolded');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('generates .blocks/config.json with stackId and uses getStackName in index.cdk.ts', () => {
    const tmpDir = join(__dirname, '../.test-stack-name-rewrite');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-cool-app', version: '1.0.0' }));
    try {
      const result = run(['-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      const cdkContent = readFileSync(join(tmpDir, 'aws-blocks', 'index.cdk.ts'), 'utf-8');
      assert.ok(
        !cdkContent.includes('my-blocks-stack'),
        'generated index.cdk.ts should not contain the static placeholder'
      );
      assert.ok(
        cdkContent.includes('getStackName'),
        'generated index.cdk.ts should import getStackName from @aws-blocks/blocks/scripts'
      );
      const config = JSON.parse(readFileSync(join(tmpDir, '.blocks', 'config.json'), 'utf-8'));
      assert.ok(config.stackId, '.blocks/config.json should have a stackId');
      assert.ok(config.stackId.startsWith('my-cool-app-'), 'stackId should start with truncated app name');
      assert.strictEqual(config.stackId.length, 'my-cool-app-'.length + 6, 'stackId should have 6-char random suffix');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('truncates long names to 16 chars in stackId', () => {
    const tmpDir = join(__dirname, '../.test-sanitize-stack-name');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: '@scope/my_app.test', version: '1.0.0' }));
    try {
      const result = run(['-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      const config = JSON.parse(readFileSync(join(tmpDir, '.blocks', 'config.json'), 'utf-8'));
      assert.ok(config.stackId, '.blocks/config.json should have a stackId');
      // Name part (before the random suffix) should be at most 16 chars
      const parts = config.stackId.split('-');
      const suffix = parts.pop();
      const namepart = parts.join('-');
      assert.ok(namepart.length <= 16, `name portion "${namepart}" should be at most 16 chars`);
      assert.strictEqual(suffix!.length, 6, 'random suffix should be 6 chars');
      assert.match(config.stackId, /^[a-z][a-z0-9-]*$/i, 'stackId must be CDK/CFN-safe');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('detects existing project when target dir is an explicit named directory', () => {
    const tmpDir = join(__dirname, '../.test-named-existing');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'named-project', version: '1.0.0' }));
    try {
      const result = run([tmpDir, '-y', '--skip-install']);
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /Detected existing project/);
      assert.match(result.stdout, /Created aws-blocks/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('generates .blocks/config.json with stackId and ships zod for fresh bare project scaffolding', () => {
    const tmpDir = join(__dirname, '../.test-fresh-project-stackid');
    try {
      const result = run([tmpDir, '--template', 'bare', '--skip-install']);
      assert.strictEqual(result.exitCode, 0);
      const config = JSON.parse(readFileSync(join(tmpDir, '.blocks', 'config.json'), 'utf-8'));
      assert.ok(config.stackId, '.blocks/config.json should have a stackId');
      assert.match(config.stackId, /^[a-z][a-z0-9-]*$/i, 'stackId must be CDK/CFN-safe');
      assert.strictEqual(config.stackId.split('-').pop()!.length, 6, 'suffix should be 6 chars');
      // The bare template's commented examples import zod, so a fresh app must depend on it
      // at the template's range (read from the template — dependency bumps change it).
      const templateZod = JSON.parse(readFileSync(join(__dirname, '../templates/bare/package.json'), 'utf-8')).dependencies?.zod;
      assert.strictEqual(typeof templateZod, 'string', 'templates/bare/package.json should declare a zod dependency');
      const appPkg = JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf-8'));
      assert.strictEqual(appPkg.dependencies?.zod, templateZod, 'scaffolded app should depend on zod at the template range');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('honors --template when adding to an existing project (nextjs uses next dev)', () => {
    const tmpDir = join(__dirname, '../.test-existing-nextjs-template');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-next-app', version: '1.0.0' }));
    try {
      const result = run(['.', '--template', 'nextjs', '-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      const pkg = JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf-8'));
      const frontendCommand: string = pkg.blocks?.dev?.frontendCommand ?? '';
      assert.match(frontendCommand, /next dev/, 'nextjs template should start the Next.js dev server');
      assert.ok(!frontendCommand.includes('vite'), 'nextjs template should not start a Vite dev server');
      assert.ok(!existsSync(join(tmpDir, 'aws-blocks', 'scripts')), 'no lifecycle wrappers are copied');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('keeps a backend-only template backend-only in an existing Vite or Next.js project', async () => {
    for (const template of ['backend', 'api-only', 'sql']) {
      const tmpDir = join(__dirname, `../.test-existing-backend-only-${template}`);
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'my-web-app', version: '1.0.0', dependencies: { next: '*' }, devDependencies: { vite: '*' } }),
      );
      try {
        const result = run(['.', '--template', template, '-y', '--skip-install'], tmpDir);
        assert.strictEqual(result.exitCode, 0, result.stderr);
        const pkg = JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf-8'));
        assert.deepStrictEqual(pkg.blocks, { dev: { port: 3001, frontend: false } }, template);
        const dev = await resolvedDevConfig(tmpDir);
        assert.strictEqual(dev.frontendCommand, undefined, template);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  });

  it('defaults to the default template (vite) when no --template is given for an existing project', () => {
    const tmpDir = join(__dirname, '../.test-existing-default-template');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-vite-app', version: '1.0.0' }));
    try {
      const result = run(['.', '-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      // The existing-project path must also wire the sanctioned stop command.
      const pkg = JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf-8'));
      assert.match(pkg.blocks?.dev?.frontendCommand ?? '', /vite/, 'default template should start the Vite dev server');
      assert.strictEqual(pkg.scripts['dev:server'], 'blocks dev');
      assert.strictEqual(pkg.scripts['dev:stop'], 'blocks dev stop');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('keeps an existing project\'s own "blocks.dev" settings', () => {
    const tmpDir = join(__dirname, '../.test-existing-blocks-dev');
    mkdirSync(tmpDir, { recursive: true });
    const own = { port: 4000, frontendCommand: 'npx astro dev --port 4100', frontendPort: 4100 };
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-astro-app', version: '1.0.0', blocks: { dev: own } }));
    try {
      const result = run(['.', '-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      const pkg = JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf-8'));
      assert.deepStrictEqual(pkg.blocks, { dev: own });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('every deployable template ships the standard `vendorize` script', () => {
    // Regression guard: the auth-cognito template was missing `vendorize`
    // (all other deployable templates had it), so `npm run vendorize` didn't
    // work in scaffolded auth-cognito apps. A template that can `sandbox`/`deploy`
    // (i.e. has those lifecycle scripts) must also expose `vendorize` so users
    // can inline a Block's source for customization.
    const templatesDir = join(__dirname, '..', 'templates');
    const templates = readdirSync(templatesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const missing: string[] = [];
    for (const name of templates) {
      const pkgPath = join(templatesDir, name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const scripts = JSON.parse(readFileSync(pkgPath, 'utf-8')).scripts ?? {};
      // Only deployable templates (those with a sandbox lifecycle) are expected
      // to carry vendorize; e.g. the amplify template has no sandbox/deploy.
      if (scripts.sandbox && scripts.vendorize !== 'blocks vendorize') {
        missing.push(name);
      }
    }
    assert.deepStrictEqual(missing, [], `Deployable templates missing "vendorize": ${missing.join(', ')}`);
  });

  it('skips npm install when creating a fresh project with --skip-install', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'create-blocks-app-fresh-skip-install-'));
    const targetDir = join(tmpDir, 'fresh-app');
    try {
      const result = run([targetDir, '-y', '--skip-install'], undefined, {
        NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
      });
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /Blocks app created/);
      assert.doesNotMatch(result.stdout, /Installing dependencies/);
      assert.match(result.stdout, /\n  npm install\n/);
      assert.strictEqual(existsSync(join(targetDir, 'node_modules')), false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

describe('create-blocks-app scaffold allowlist safety', () => {
  it('no template writes a file whose name is in the scaffold allowlist (never-overwrite invariant)', () => {
    // A fresh scaffold copies a template dir into the target (overwriting on
    // collision), renames `gitignore` -> `.gitignore`, and overlays AGENTS.md.
    // The safe-to-scaffold allowlist must stay DISJOINT from that written-set,
    // or a user's pre-existing same-named file would be silently overwritten.
    // Locate the source templates dir relative to the compiled test at dist/.
    const candidates = [
      join(__dirname, '../templates'),
      join(__dirname, '../../templates'),
    ];
    const templatesDir = candidates.find((dir) => existsSync(dir));
    assert.ok(
      templatesDir,
      `could not locate templates/ dir (looked in: ${candidates.join(', ')})`,
    );

    // Build the set of top-level names a fresh scaffold writes at the target:
    // each template's top-level entries (gitignore -> .gitignore), plus the
    // AGENTS.md shared-resource overlay.
    const written = new Map<string, string>(); // written name -> source (template or overlay)
    written.set('AGENTS.md', 'shared resource overlay (resources/AGENTS.md)');
    for (const entry of readdirSync(templatesDir!, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of readdirSync(join(templatesDir!, entry.name))) {
        const writtenName = name === 'gitignore' ? '.gitignore' : name;
        if (!written.has(writtenName)) written.set(writtenName, `template "${entry.name}"`);
      }
    }

    // Collect ALL collisions so the failure lists every offender, not just the first.
    const collisions: string[] = [];
    for (const [name, source] of written) {
      if (SAFE_TO_SCAFFOLD_ENTRIES.has(name) || SAFE_TO_SCAFFOLD_PATTERN.test(name)) {
        collisions.push(`${source} writes "${name}" which is in the scaffold allowlist — a user's same-named file would be overwritten`);
      }
    }

    assert.ok(
      collisions.length === 0,
      `scaffold allowlist collides with template-written files:\n  ${collisions.join('\n  ')}`,
    );
  });
});

describe('create-blocks-app bin-symlink invocation', () => {
  it('runs the scaffold when invoked through a bin symlink (argv[1] is a symlink to the module)', (t) => {
    // When installed, the CLI is invoked through its npm bin symlink
    // (node_modules/.bin/create-blocks-app -> dist/index.js), so argv[1] is the
    // symlink path while import.meta.url is the real file. The run() helper
    // above calls dist/index.js directly and would NOT catch a guard that
    // compares argv[1] verbatim; this test reproduces the symlink path.
    const tmpDir = mkdtempSync(join(tmpdir(), 'create-blocks-app-binsymlink-'));
    const linkPath = join(tmpDir, 'create-blocks-app-link');
    const targetDir = join(tmpDir, 'my-app');
    try {
      try {
        symlinkSync(CLI_PATH, linkPath);
      } catch (err: any) {
        // Some CI environments disallow symlink creation (e.g. EPERM); skip
        // gracefully rather than hard-failing on unsupported platforms.
        t.skip(`symlink creation unsupported: ${err?.code ?? err}`);
        return;
      }
      let exitCode = 0;
      try {
        execFileSync('node', [linkPath, targetDir, '-y', '--skip-install'], {
          encoding: 'utf-8',
          timeout: 30000,
          // This spawn bypasses run(), so it needs the same telemetry guard.
          env: {
            ...process.env,
            AWS_BLOCKS_DISABLE_TELEMETRY: '1',
            BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop',
          },
        });
      } catch (err: any) {
        exitCode = err.status ?? 1;
      }
      assert.strictEqual(exitCode, 0);
      // The guard let create() run through the symlink, so the scaffold happened.
      assert.ok(existsSync(join(targetDir, 'aws-blocks')), 'expected aws-blocks/ to be scaffolded via the bin symlink');
      assert.ok(existsSync(join(targetDir, 'package.json')), 'expected package.json to be created via the bin symlink');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
