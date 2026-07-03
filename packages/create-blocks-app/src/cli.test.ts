import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '../dist/index.js');

function run(args: string[], cwd?: string, env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
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
    assert.match(result.stdout, /Available templates: default, bare, react, backend, nextjs, auth-cognito, amplify, demo/);
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
    // Guards the filesystem-driven catalog: if template discovery breaks or a
    // template's `blocksTemplateDescription` disappears, --help output will no
    // longer include the canonical description strings and this test fails.
    const result = run(['--help']);
    assert.strictEqual(result.exitCode, 0);
    // "default" template's canonical description substring. Pinned to a stable
    // fragment so wording tweaks don't require test churn but a missing
    // description does.
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

  it('--template amplify on a fresh dir exits 1 with a helpful message', () => {
    // amplify is auto-selected when an existing Amplify Gen 2 project is
    // detected — it's not scaffoldable as a fresh app. The CLI should
    // reject the fresh-scaffold path up front rather than crashing partway
    // through the file copy on missing template contents.
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
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
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

  it('detects Amplify Gen 2 project over plain project', () => {
    const tmpDir = join(__dirname, '../.test-autodetect-amplify');
    mkdirSync(join(tmpDir, 'amplify'), { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'amplify-app', version: '1.0.0' }));
    writeFileSync(join(tmpDir, 'amplify', 'backend.ts'), 'export const backend = defineBackend({});');
    try {
      const result = run(['-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /Detected Amplify Gen 2 project/);
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

  it('generates .blocks/config.json with stackId for fresh project scaffolding', () => {
    const tmpDir = join(__dirname, '../.test-fresh-project-stackid');
    try {
      const result = run([tmpDir, '--template', 'bare', '--skip-install']);
      assert.strictEqual(result.exitCode, 0);
      const config = JSON.parse(readFileSync(join(tmpDir, '.blocks', 'config.json'), 'utf-8'));
      assert.ok(config.stackId, '.blocks/config.json should have a stackId');
      assert.match(config.stackId, /^[a-z][a-z0-9-]*$/i, 'stackId must be CDK/CFN-safe');
      assert.strictEqual(config.stackId.split('-').pop()!.length, 6, 'suffix should be 6 chars');
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
      const serverContent = readFileSync(join(tmpDir, 'aws-blocks', 'scripts', 'server.ts'), 'utf-8');
      assert.match(serverContent, /next dev/, 'nextjs template should start the Next.js dev server');
      assert.ok(!serverContent.includes('vite'), 'nextjs template should not start a Vite dev server');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('defaults to the default template (vite) when no --template is given for an existing project', () => {
    const tmpDir = join(__dirname, '../.test-existing-default-template');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-vite-app', version: '1.0.0' }));
    try {
      const result = run(['.', '-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      const serverContent = readFileSync(join(tmpDir, 'aws-blocks', 'scripts', 'server.ts'), 'utf-8');
      assert.match(serverContent, /vite/, 'default template should start the Vite dev server');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
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
