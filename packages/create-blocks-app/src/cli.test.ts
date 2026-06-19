import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '../dist/index.js');

function run(args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      cwd,
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
    assert.match(result.stdout, /--help/);
    assert.match(result.stdout, /auto-detected/);
  });

  it('-h prints usage and exits 0', () => {
    const result = run(['-h']);
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /Usage: create-blocks-app/);
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

  it('unknown template exits 1 with a friendly error message', () => {
    const result = run(['--template', 'does-not-exist']);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /Unknown template "does-not-exist"/);
    assert.match(result.stderr, /Available templates:/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
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

  it('replaces my-blocks-stack placeholder in generated aws-blocks/index.cdk.ts', () => {
    const tmpDir = join(__dirname, '../.test-stack-name-rewrite');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-cool-app', version: '1.0.0' }));
    try {
      const result = run(['-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      const cdkContent = readFileSync(join(tmpDir, 'aws-blocks', 'index.cdk.ts'), 'utf-8');
      assert.ok(
        !cdkContent.includes('my-blocks-stack'),
        'generated index.cdk.ts should not contain the placeholder "my-blocks-stack"'
      );
      assert.ok(
        cdkContent.includes('-stack'),
        'generated index.cdk.ts should contain the derived stack name'
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('sanitizes directory names with special characters for CDK stack IDs', () => {
    const tmpDir = join(__dirname, '../.test-sanitize-stack-name');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: '@scope/my_app.test', version: '1.0.0' }));
    try {
      const result = run(['-y', '--skip-install'], tmpDir);
      assert.strictEqual(result.exitCode, 0);
      const cdkContent = readFileSync(join(tmpDir, 'aws-blocks', 'index.cdk.ts'), 'utf-8');
      assert.ok(
        !cdkContent.includes('my-blocks-stack'),
        'placeholder should be replaced'
      );
      // Stack name should only contain [A-Za-z][A-Za-z0-9-]* characters
      const stackNameMatch = cdkContent.match(/`([^`]+)-\$\{getSandboxId/);
      assert.ok(stackNameMatch, 'regex should match stack name pattern in CDK output');
      if (stackNameMatch) {
        assert.match(stackNameMatch[1], /^[A-Za-z][A-Za-z0-9-]*$/, 'stack name should be CDK-safe');
      }
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
});
