import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runBuild } from './runner.js';

void describe('runBuild', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hosting-build-runner-test-'),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('executes a successful command and returns stdout', () => {
    const result = runBuild({
      command: 'node -e "process.stdout.write(\'build success\')"',
      cwd: tmpDir,
    });

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('build success'));
  });

  void it('creates files during build (side effect)', () => {
    runBuild({
      command:
        'node -e "require(\'fs\').writeFileSync(\'index.html\', \'<html></html>\')"',
      cwd: tmpDir,
    });

    assert.ok(
      fs.existsSync(path.join(tmpDir, 'index.html')),
      'Build should have created index.html',
    );
  });

  void it('throws BuildError when command fails', () => {
    assert.throws(
      () =>
        runBuild({
          command: 'node -e "process.exit(1)"',
          cwd: tmpDir,
        }),
      (error: Error) => {
        assert.strictEqual(error.name, 'BuildError');
        assert.ok(error.message.includes('Build command failed'));
        return true;
      },
    );
  });

  void it('throws BuildError with non-zero exit code', () => {
    assert.throws(
      () =>
        runBuild({
          command:
            'node -e "process.stderr.write(\'some error\'); process.exit(2)"',
          cwd: tmpDir,
        }),
      (error: Error) => {
        assert.strictEqual(error.name, 'BuildError');
        return true;
      },
    );
  });

  void it('throws BuildError for unknown command', () => {
    assert.throws(
      () =>
        runBuild({
          command: 'definitely_not_a_real_command_12345',
          cwd: tmpDir,
        }),
      (error: Error) => {
        assert.strictEqual(error.name, 'BuildError');
        return true;
      },
    );
  });

  void it('passes custom environment variables', () => {
    const result = runBuild({
      command: 'node -e "process.stdout.write(process.env.MY_TEST_VAR)"',
      cwd: tmpDir,
      env: { MY_TEST_VAR: 'hello_from_env' },
    });

    assert.ok(result.stdout.includes('hello_from_env'));
  });

  void it('runs the command without the cdk condition a synth sets in NODE_OPTIONS', () => {
    const saved = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--conditions=cdk --max-old-space-size=512';
    try {
      const result = runBuild({
        command: 'node -e "process.stdout.write(process.env.NODE_OPTIONS)"',
        cwd: tmpDir,
      });
      assert.strictEqual(result.stdout, '--max-old-space-size=512');
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved;
    }
  });

  void it('uses the specified working directory', () => {
    const subDir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(subDir);

    const result = runBuild({
      command: 'node -e "process.stdout.write(process.cwd())"',
      cwd: subDir,
    });

    assert.ok(result.stdout.trim().endsWith('subdir'));
  });

  void it('truncates long error output in BuildError message', () => {
    assert.throws(
      () =>
        runBuild({
          command:
            'node -e "process.stderr.write(\'X\'.repeat(5000)); process.exit(1)"',
          cwd: tmpDir,
        }),
      (error: Error & { resolution?: string }) => {
        assert.strictEqual(error.name, 'BuildError');
        assert.ok(
          error.resolution?.includes('truncated'),
          'Long output should be truncated in error resolution',
        );
        return true;
      },
    );
  });

  void it('handles command that fails with no output', () => {
    assert.throws(
      () =>
        runBuild({
          command: 'node -e "process.exit(3)"',
          cwd: tmpDir,
        }),
      (error: Error) => {
        assert.strictEqual(error.name, 'BuildError');
        return true;
      },
    );
  });
});
