import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';

import { getTelemetryFilePath, isDisableValue, trackCommand } from './telemetry.js';

interface DisableValueCase {
  value: string | null;
  expected: boolean;
}

describe('create-blocks-app telemetry/isDisableValue (shared case table)', () => {
  const { cases }: { cases: DisableValueCase[] } = JSON.parse(
    readFileSync(new URL('../../core/src/telemetry/disable-value-cases.test.json', import.meta.url), 'utf-8'),
  );

  it('loads the shared case table', () => {
    assert.ok(cases.length > 10, `expected the shared disable-value cases, got ${cases.length}`);
  });

  for (const testCase of cases) {
    it(`${JSON.stringify(testCase.value)} → ${testCase.expected}`, () => {
      assert.strictEqual(isDisableValue(testCase.value ?? undefined), testCase.expected);
    });
  }
});

describe('create-blocks-app telemetry/isCI', () => {
  interface IsCICase {
    name: string;
    env: Record<string, string>;
    expected: boolean;
    steps?: Array<{ env: Record<string, string>; expected: boolean }>;
  }

  // ci-info computes isCI at import, so each case imports the module in a fresh process with exactly its env.
  const IS_CI_CHILD = `
  const [moduleUrl, stepEnvs] = process.argv.slice(1);
  const { isCI } = await import(moduleUrl);
  const results = [isCI()];
  for (const env of JSON.parse(stepEnvs)) {
    process.env = env;
    results.push(isCI());
  }
  process.stdout.write(JSON.stringify(results));
  `;

  const moduleUrl = new URL('./telemetry.js', import.meta.url).href;
  const { cases }: { cases: IsCICase[] } = JSON.parse(
    readFileSync(new URL('../../core/src/telemetry/is-ci-cases.test.json', import.meta.url), 'utf-8'),
  );

  function runIsCICase(testCase: IsCICase): boolean[] {
    const stepEnvs = JSON.stringify((testCase.steps ?? []).map((step) => step.env));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', IS_CI_CHILD, moduleUrl, stepEnvs], {
      env: testCase.env,
      encoding: 'utf-8',
    });
    assert.strictEqual(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  }

  it('loads the shared case table', () => {
    assert.ok(cases.length > 20, `expected the shared isCI cases, got ${cases.length}`);
  });

  for (const testCase of cases) {
    const expected = [testCase.expected, ...(testCase.steps ?? []).map((step) => step.expected)];
    it(`${testCase.name} → ${expected.join(' → ')}`, () => {
      assert.deepStrictEqual(runIsCICase(testCase), expected);
    });
  }
});

describe('create-blocks-app telemetry/getTelemetryFilePath', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
  });

  it('returns undefined when --telemetry-file is not present', () => {
    process.argv = ['node', 'script.js'];
    assert.strictEqual(getTelemetryFilePath(), undefined);
  });

  it('parses --telemetry-file=path form', () => {
    process.argv = ['node', 'script.js', '--telemetry-file=/tmp/events.json'];
    assert.strictEqual(getTelemetryFilePath(), '/tmp/events.json');
  });

  it('parses --telemetry-file path (space-separated) form', () => {
    process.argv = ['node', 'script.js', '--telemetry-file', '/tmp/events.json'];
    assert.strictEqual(getTelemetryFilePath(), '/tmp/events.json');
  });

  it('handles paths containing = characters', () => {
    process.argv = ['node', 'script.js', '--telemetry-file=/tmp/a=b/events.json'];
    assert.strictEqual(getTelemetryFilePath(), '/tmp/a=b/events.json');
  });

  it('returns undefined for --telemetry-file with no following argument', () => {
    process.argv = ['node', 'script.js', '--telemetry-file'];
    assert.strictEqual(getTelemetryFilePath(), undefined);
  });
});

describe('create-blocks-app telemetry/file sink via trackCommand', () => {
  const originalArgv = [...process.argv];
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.argv = [...originalArgv];
    process.env = { ...originalEnv };
  });

  it('writes telemetry event to file on successful command', async () => {
    const tmp = join(tmpdir(), `cba-telemetry-test-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];

    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.BUILD_NUMBER;
    delete process.env.CODEBUILD_BUILD_ID;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.JENKINS_URL;
    delete process.env.TF_BUILD;
    delete process.env.BITBUCKET_BUILD_NUMBER;
    delete process.env.BUILDKITE;
    delete process.env.RENDER;
    delete process.env.TASKCLUSTER_ROOT_URL;
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    await trackCommand('create', async () => {});

    assert.ok(existsSync(filePath), 'telemetry file should exist');
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event.command, 'create');
    assert.strictEqual(events[0].event.state, 'SUCCESS');
    assert.ok(events[0].identifiers.installationId);
    assert.ok(events[0].identifiers.timestamp);
    assert.ok(events[0].environment.os);
    assert.ok(events[0].product.blocksVersion);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes telemetry event to file on failed command', async () => {
    const tmp = join(tmpdir(), `cba-telemetry-fail-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];

    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.BUILD_NUMBER;
    delete process.env.CODEBUILD_BUILD_ID;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.JENKINS_URL;
    delete process.env.TF_BUILD;
    delete process.env.BITBUCKET_BUILD_NUMBER;
    delete process.env.BUILDKITE;
    delete process.env.RENDER;
    delete process.env.TASKCLUSTER_ROOT_URL;
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    await assert.rejects(
      () => trackCommand('create', async () => { throw new Error('npm install failed'); }),
      { message: 'npm install failed' },
    );

    assert.ok(existsSync(filePath), 'telemetry file should exist');
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event.state, 'FAIL');
    assert.strictEqual(events[0].event.error.code, 'NPM_INSTALL_FAILED');
    assert.strictEqual(events[0].event.error.phase, 'install');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('skips writing when file already exists (not created by this process)', async () => {
    const tmp = join(tmpdir(), `cba-telemetry-append-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(filePath, JSON.stringify([{ existing: true }], null, 2));

    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];

    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.BUILD_NUMBER;
    delete process.env.CODEBUILD_BUILD_ID;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.JENKINS_URL;
    delete process.env.TF_BUILD;
    delete process.env.BITBUCKET_BUILD_NUMBER;
    delete process.env.BUILDKITE;
    delete process.env.RENDER;
    delete process.env.TASKCLUSTER_ROOT_URL;
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    await trackCommand('create', async () => {});

    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1, 'Pre-existing file should not be modified');
    assert.deepStrictEqual(events[0], { existing: true });

    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes file even when telemetry is disabled (matches CDK behavior)', async () => {
    const filePath = join(tmpdir(), `cba-telemetry-disabled-${Date.now()}`, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';

    await trackCommand('create', async () => {});

    assert.ok(existsSync(filePath), 'File should be written even when telemetry is disabled');
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event.command, 'create');

    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it('fires both file and HTTP sinks when telemetry is enabled', async () => {
    const tmp = join(tmpdir(), `cba-telemetry-both-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];

    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          received.push(body);
          res.writeHead(200);
          res.end();
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    const addr = server.address() as { port: number };
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.BUILD_NUMBER;
    delete process.env.CODEBUILD_BUILD_ID;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.JENKINS_URL;
    delete process.env.TF_BUILD;
    delete process.env.BITBUCKET_BUILD_NUMBER;
    delete process.env.BUILDKITE;
    delete process.env.RENDER;
    delete process.env.TASKCLUSTER_ROOT_URL;
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    await trackCommand('create', async () => {});

    await new Promise((r) => setTimeout(r, 200));

    // File sink fired
    assert.ok(existsSync(filePath), 'telemetry file should exist');
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);

    // HTTP sink also fired
    assert.strictEqual(received.length, 1);
    const httpEvent = JSON.parse(received[0]);
    assert.strictEqual(httpEvent.event.command, 'create');

    server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('AWS_BLOCKS_DISABLE_TELEMETRY=true writes file but fires no HTTP sink', async () => {
    const tmp = join(tmpdir(), `cba-telemetry-true-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];

    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          received.push(body);
          res.writeHead(200);
          res.end();
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    const addr = server.address() as { port: number };
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = 'true';
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    try {
      await trackCommand('create', async () => {});

      await new Promise((r) => setTimeout(r, 200));

      // File sink still fires regardless of opt-out (D-010 contract)
      assert.ok(existsSync(filePath), 'telemetry file should exist');
      assert.strictEqual(received.length, 0, 'no HTTP request should be sent when opted out');
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('create-blocks-app telemetry/opt-out persists no identifiers', () => {
  // Driven in a child process: the id helper writes to the real HOME otherwise.
  const EMIT_CHILD = `
  const [moduleUrl] = process.argv.slice(1);
  const { trackCommand } = await import(moduleUrl);
  await trackCommand('create', async () => {});
  `;

  const moduleUrl = new URL('./telemetry.js', import.meta.url).href;

  for (const value of ['1', 'true', 'TRUE', 'yes', ' true ']) {
    it(`writes no identifiers and sends nothing when AWS_BLOCKS_DISABLE_TELEMETRY=${JSON.stringify(value)}`, () => {
      const home = join(tmpdir(), `cba-optout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(home, { recursive: true });

      const result = spawnSync(process.execPath, ['--input-type=module', '-e', EMIT_CHILD, moduleUrl], {
        encoding: 'utf-8',
        cwd: home,
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AWS_BLOCKS_DISABLE_TELEMETRY: value,
          NODE_DEBUG: 'blocks-telemetry',
          // Unset would fall through to DEFAULT_ENDPOINT, the real collector.
          BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop',
        },
      });

      assert.strictEqual(result.status, 0, result.stderr);
      const idFile = join(home, '.blocks', 'telemetry', 'installation-id');
      assert.ok(!existsSync(idFile), 'installation-id must not be written');
      assert.doesNotMatch(result.stderr, /sending event to/, 'no event should be sent');
      assert.ok(!result.stderr.includes('AWS Blocks collects anonymous usage data'), 'no first-run notice');

      rmSync(home, { recursive: true, force: true });
    });
  }
});
