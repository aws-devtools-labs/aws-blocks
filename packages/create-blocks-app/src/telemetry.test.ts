import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';

import { getTelemetryFilePath, trackCommand } from './telemetry.js';

// Env vars that ci-info treats as "running in CI" — CI implies opt-out, so tests
// that need telemetry ENABLED must clear every one of them.
const CI_ENV_VARS = [
  'CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'CODEBUILD_BUILD_ID', 'GITHUB_ACTIONS',
  'GITLAB_CI', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'BITBUCKET_BUILD_NUMBER', 'BUILDKITE',
  'RENDER', 'TASKCLUSTER_ROOT_URL',
];

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

  it('does NOT write file when telemetry is disabled', async () => {
    const filePath = join(tmpdir(), `cba-telemetry-disabled-${Date.now()}`, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';

    await trackCommand('create', async () => {});

    assert.ok(!existsSync(filePath), 'File must not be written when telemetry is disabled');

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
});

describe('create-blocks-app telemetry/opt-out overrides --telemetry-file', () => {
  const moduleUrl = new URL('./telemetry.js', import.meta.url).href;

  interface ChildRun {
    status: number | null;
    stderr: string;
    wroteTelemetryFile: boolean;
    wroteInstallationId: boolean;
  }

  // getInstallationId() persists the installation ID under $HOME and prints the
  // first-run notice, so each case runs in a child process with a throwaway HOME.
  function runTrackCommandInChild(telemetryDisabled: boolean): ChildRun {
    const tmp = mkdtempSync(join(tmpdir(), 'cba-optout-'));
    const home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    const telemetryFile = join(tmp, 'events.json');

    const script = `
      const { trackCommand } = await import(${JSON.stringify(moduleUrl)});
      await trackCommand('create', async () => {});
    `;

    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop',
    };
    if (telemetryDisabled) {
      env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
    } else {
      delete env.AWS_BLOCKS_DISABLE_TELEMETRY;
      for (const name of CI_ENV_VARS) delete env[name];
    }

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, '--', `--telemetry-file=${telemetryFile}`],
      { encoding: 'utf-8', cwd: tmp, env },
    );

    const run: ChildRun = {
      status: result.status,
      stderr: result.stderr,
      wroteTelemetryFile: existsSync(telemetryFile),
      wroteInstallationId: existsSync(join(home, '.blocks', 'telemetry', 'installation-id')),
    };

    rmSync(tmp, { recursive: true, force: true });
    return run;
  }

  it('persists no installation ID and prints no notice when telemetry is disabled', () => {
    const run = runTrackCommandInChild(true);

    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.wroteTelemetryFile, false, 'no telemetry file when opted out');
    assert.strictEqual(run.wroteInstallationId, false, 'no installation ID file when opted out');
    assert.strictEqual(run.stderr, '', 'no first-run notice when opted out');
  });

  it('persists the installation ID and prints the notice when telemetry is enabled', () => {
    const run = runTrackCommandInChild(false);

    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.wroteTelemetryFile, true, 'telemetry file written when enabled');
    assert.strictEqual(run.wroteInstallationId, true, 'installation ID persisted when enabled');
    assert.ok(
      run.stderr.includes('AWS Blocks collects anonymous usage data to improve the product.'),
      `expected first-run notice on stderr, got: ${run.stderr}`,
    );
  });
});
