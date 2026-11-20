// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';

import { getTelemetryFilePath, trackCommand } from './telemetry.js';

// Prevent an inherited CDK telemetry opt-out from disabling enabled-path tests.
delete process.env.CDK_DISABLE_CLI_TELEMETRY;

const DEAD_ENDPOINT = 'http://127.0.0.1:1/noop';

function spawnTelemetryChild(
  script: string,
  argv: string[],
  options: { home: string; cwd?: string; disable?: string; timeout?: number; env?: Record<string, string> },
) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, ...argv], {
    encoding: 'utf-8',
    cwd: options.cwd ?? options.home,
    timeout: options.timeout ?? 30_000,
    env: {
      ...process.env,
      HOME: options.home,
      USERPROFILE: options.home,
      CDK_DISABLE_CLI_TELEMETRY: options.disable ?? '',
      BLOCKS_TELEMETRY_ENDPOINT: DEAD_ENDPOINT,
      ...options.env,
    },
  });
}
const moduleUrl = new URL('./telemetry.js', import.meta.url).href;

// Driven in a child process: the id helper writes to the real HOME otherwise.
const EMIT_CHILD = `
const [moduleUrl] = process.argv.slice(1);
const { trackCommand } = await import(moduleUrl);
await trackCommand('create', async () => {});
`;

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

  it('rejects whitespace-only path in space-separated form', () => {
    process.argv = ['node', 'script.js', '--telemetry-file', '   '];
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

    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = DEAD_ENDPOINT;

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

    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = DEAD_ENDPOINT;

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

    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = DEAD_ENDPOINT;

    await trackCommand('create', async () => {});

    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1, 'Pre-existing file should not be modified');
    assert.deepStrictEqual(events[0], { existing: true });

    rmSync(tmp, { recursive: true, force: true });
  });

  it('does not write file when telemetry is disabled', async () => {
    const filePath = join(tmpdir(), `cba-telemetry-disabled-${Date.now()}`, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.CDK_DISABLE_CLI_TELEMETRY = '1';
    process.env.BLOCKS_TELEMETRY_ENDPOINT = DEAD_ENDPOINT;

    await trackCommand('create', async () => {});

    try {
      assert.ok(!existsSync(filePath), 'File must not be written when telemetry is disabled');
    } finally {
      rmSync(dirname(filePath), { recursive: true, force: true });
    }
  });

  it('does not write file when the CDK project context disables telemetry', async () => {
    const filePath = join(tmpdir(), `cba-telemetry-config-disabled-${Date.now()}`, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
    process.env.BLOCKS_TELEMETRY_ENDPOINT = DEAD_ENDPOINT;

    // What `cdk cli-telemetry --disable` records for one app.
    const configPath = join(process.cwd(), 'cdk.context.json');
    const had = existsSync(configPath);
    const original = had ? readFileSync(configPath, 'utf-8') : null;
    writeFileSync(configPath, JSON.stringify({ 'cli-telemetry': false }));

    try {
      await trackCommand('create', async () => {});
      assert.ok(!existsSync(filePath), 'File must not be written when the CDK project context disables telemetry');
    } finally {
      // Restore first: a throwing rmSync must not skip it and leave telemetry disabled.
      if (original !== null) writeFileSync(configPath, original);
      else rmSync(configPath, { force: true });
      rmSync(dirname(filePath), { recursive: true, force: true });
    }
  });

  it('does not write file when the CDK user config disables telemetry', () => {
    // Driven in a child: os.homedir reads native env at startup, not the plain-object
    // process.env this suite mutates.
    const home = join(tmpdir(), `cba-global-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.cdk.json'), JSON.stringify({ context: { 'cli-telemetry': false } }));
    const telemetryFile = join(home, 'events.json');

    const result = spawnTelemetryChild(EMIT_CHILD, [moduleUrl, `--telemetry-file=${telemetryFile}`], { home });

    try {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(!existsSync(telemetryFile), 'File must not be written when the CDK user config disables telemetry');
      assert.ok(
        !existsSync(join(home, '.cdk-blocks', 'telemetry', 'installation-id')),
        'installation-id must not be written',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fires both file and HTTP sinks when telemetry is enabled', { timeout: 10_000 }, async (t) => {
    const tmp = join(tmpdir(), `cba-telemetry-both-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];

    const received: string[] = [];
    const server = createServer();
    t.after(async () => {
      try {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
    const requestReceived = new Promise<void>((resolve) => {
      server.on('request', (req, res) => {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          received.push(body);
          res.writeHead(200);
          res.end(() => resolve());
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const addr = server.address() as { port: number };
    delete process.env.CDK_DISABLE_CLI_TELEMETRY;
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

    await requestReceived;

    // File sink fired
    assert.ok(existsSync(filePath), 'telemetry file should exist');
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);

    // HTTP sink also fired
    assert.strictEqual(received.length, 1);
    const httpEvent = JSON.parse(received[0]);
    assert.strictEqual(httpEvent.event.command, 'create');
  });

  it('CDK_DISABLE_CLI_TELEMETRY=true writes no file and fires no HTTP sink', async () => {
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
    process.env.CDK_DISABLE_CLI_TELEMETRY = 'true';
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    try {
      await trackCommand('create', async () => {});

      await new Promise((r) => setTimeout(r, 200));

      assert.ok(!existsSync(filePath), 'telemetry file should not exist');
      assert.strictEqual(received.length, 0, 'no HTTP request should be sent when opted out');
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('keeps every event when one run emits several', async () => {
    const tmp = join(tmpdir(), `cba-telemetry-multi-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.BLOCKS_TELEMETRY_ENDPOINT = DEAD_ENDPOINT;

    try {
      await assert.rejects(trackCommand('create', async () => { throw new Error('npm install failed'); }));
      await trackCommand('create', async () => {});
      await trackCommand('create', async () => {});

      const events = JSON.parse(readFileSync(filePath, 'utf-8'));
      assert.strictEqual(events.length, 3, 'A run emitting several events must keep all of them');
      assert.deepStrictEqual(
        events.map((e: { event: { state: string } }) => e.event.state),
        ['FAIL', 'SUCCESS', 'SUCCESS'],
        'Events must be kept in emission order',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('leaves the file alone when its content stops being a JSON array mid-run', async () => {
    const tmp = join(tmpdir(), `cba-telemetry-clobber-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.BLOCKS_TELEMETRY_ENDPOINT = DEAD_ENDPOINT;

    try {
      await trackCommand('create', async () => {});
      writeFileSync(filePath, 'not json');
      await trackCommand('create', async () => {});

      assert.strictEqual(readFileSync(filePath, 'utf-8'), 'not json');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps the appended file 2-space indented, as the first write leaves it', async () => {
    const tmp = join(tmpdir(), `cba-telemetry-shape-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.BLOCKS_TELEMETRY_ENDPOINT = DEAD_ENDPOINT;

    try {
      await trackCommand('create', async () => {});
      const afterFirst = JSON.parse(readFileSync(filePath, 'utf-8'));
      await trackCommand('create', async () => {});
      const afterSecond = JSON.parse(readFileSync(filePath, 'utf-8'));

      assert.strictEqual(
        readFileSync(filePath, 'utf-8'),
        JSON.stringify([afterFirst[0], afterSecond[1]], null, 2),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe('pre-existing file handling (shared case table)', () => {
    interface TelemetryFileCase {
      name: string;
      preExisting: string | null;
      emits: number;
      preserved: boolean;
      expectedLength: number | null;
    }

    const { cases }: { cases: TelemetryFileCase[] } = JSON.parse(
      readFileSync(new URL('../../core/src/telemetry/telemetry-file-append-cases.test.json', import.meta.url), 'utf-8'),
    );

    it('pins the shared case table contents', () => {
      assert.deepStrictEqual(
        cases.map((c) => [c.name, c.preExisting, c.emits, c.preserved, c.expectedLength]),
        [
          ['no pre-existing file, one event', null, 1, false, 1],
          ['file created by this run, two events', null, 2, false, 2],
          ['file created by this run, three events', null, 3, false, 3],
          ['pre-existing JSON array', '[{"existing":true}]', 1, true, null],
          ['pre-existing JSON array, several events', '[{"existing":true}]', 3, true, null],
          ['pre-existing bare object', '{"existing":true}', 1, true, null],
          ['pre-existing non-JSON text', 'this is not json', 1, true, null],
          ['pre-existing empty file', '', 1, true, null],
        ],
      );
    });

    for (const testCase of cases) {
      it(testCase.name, async () => {
        const tmp = join(tmpdir(), `cba-own-case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const filePath = join(tmp, 'events.json');
        mkdirSync(tmp, { recursive: true });
        if (testCase.preExisting !== null) writeFileSync(filePath, testCase.preExisting);

        process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
        process.env.BLOCKS_TELEMETRY_ENDPOINT = DEAD_ENDPOINT;

        try {
          for (let i = 0; i < testCase.emits; i++) {
            await trackCommand('create', async () => {});
          }

          const content = readFileSync(filePath, 'utf-8');
          if (testCase.preserved) {
            assert.strictEqual(content, testCase.preExisting, 'a pre-existing file must be left untouched');
          } else {
            const events = JSON.parse(content);
            assert.ok(Array.isArray(events), 'sink must write a JSON array');
            assert.strictEqual(events.length, testCase.expectedLength);
            assert.strictEqual(events[events.length - 1].event.command, 'create');
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  });
});

describe('create-blocks-app telemetry/opt-out persists no identifiers even with --telemetry-file', () => {

  // CDK matches its variable case-sensitively and untrimmed, so these two are the whole set.
  const disableValues = ['1', 'true'];

  it('writes the identifiers and the file when telemetry is enabled', () => {
    const home = join(tmpdir(), `cba-optin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    const telemetryFile = join(home, 'events.json');

    const result = spawnTelemetryChild(EMIT_CHILD, [moduleUrl, `--telemetry-file=${telemetryFile}`], { home });

    try {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(existsSync(join(home, '.cdk-blocks', 'telemetry', 'installation-id')), 'installation-id must be written');
      assert.ok(existsSync(telemetryFile), '--telemetry-file must be written');
      assert.strictEqual(JSON.parse(readFileSync(telemetryFile, 'utf-8')).length, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('re-throws the command error when an opt-out lands while it runs', () => {
    const home = join(tmpdir(), `cba-rethrow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });

    const CHILD = `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    const [moduleUrl] = process.argv.slice(1);
    const { trackCommand } = await import(moduleUrl);
    try {
      await trackCommand('create', async () => {
        const d = join(homedir(), '.cdk-blocks');
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'config.json'), JSON.stringify({ telemetry: { enabled: false } }));
        throw new Error('USER_COMMAND_FAILED');
      });
    } catch (e) {
      process.stdout.write('propagated:' + e.message);
      process.exit(0);
    }
    process.stdout.write('swallowed');
    process.exit(3);
    `;

    const result = spawnTelemetryChild(CHILD, [moduleUrl], { home });

    try {
      assert.strictEqual(result.status, 0, `expected the throw to propagate, got: ${result.stdout}${result.stderr}`);
      assert.strictEqual(result.stdout, 'propagated:USER_COMMAND_FAILED');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('honors an opt-out that lands while the wrapped command runs', () => {
    const home = join(tmpdir(), `cba-midrun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    const telemetryFile = join(home, 'events.json');

    const CHILD = `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    const [moduleUrl] = process.argv.slice(1);
    const { trackCommand } = await import(moduleUrl);
    await trackCommand('create', async () => {
      writeFileSync(join(process.cwd(), 'cdk.context.json'), JSON.stringify({ 'cli-telemetry': false }));
    });
    `;

    const result = spawnTelemetryChild(CHILD, [moduleUrl, `--telemetry-file=${telemetryFile}`], { home });

    try {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(
        !existsSync(join(home, '.cdk-blocks', 'telemetry', 'installation-id')),
        'installation-id must not be written',
      );
      assert.ok(!existsSync(telemetryFile), '--telemetry-file must not be written');
      assert.ok(!result.stderr.includes('AWS CDK Blocks collects usage data'), 'no first-run notice');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const value of disableValues) {
    it(`writes no identifiers and sends nothing when CDK_DISABLE_CLI_TELEMETRY=${JSON.stringify(value)}`, () => {
      const home = join(tmpdir(), `cba-optout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(home, { recursive: true });
      const telemetryFile = join(home, 'events.json');

      const result = spawnTelemetryChild(EMIT_CHILD, [moduleUrl, `--telemetry-file=${telemetryFile}`], {
        home,
        disable: value,
        env: { NODE_DEBUG: 'blocks-telemetry' },
      });

      try {
        assert.strictEqual(result.status, 0, result.stderr);
        const idFile = join(home, '.cdk-blocks', 'telemetry', 'installation-id');
        assert.ok(!existsSync(idFile), 'installation-id must not be written');
        assert.ok(!existsSync(telemetryFile), '--telemetry-file must not be written');
        assert.doesNotMatch(result.stderr, /sending event to/, 'no event should be sent');
        assert.ok(!result.stderr.includes('AWS CDK Blocks collects usage data'), 'no first-run notice');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe('create-blocks-app telemetry/first-run notice', () => {
  it('states what is sent, does not claim "no PII", and gives opt-outs that work everywhere', () => {
    const home = join(tmpdir(), `cba-notice-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });

    const result = spawnTelemetryChild(EMIT_CHILD, [moduleUrl], { home });

    try {
      assert.strictEqual(result.status, 0, result.stderr);
      const notice = result.stderr;
      assert.ok(notice.includes('AWS CDK Blocks collects usage data to improve the product.'), notice);
      // The endpoint sees the source IP of every request, so the notice must not
      // promise that no personal data reaches it, and must say so in full.
      assert.doesNotMatch(notice, /\bPII\b/);
      assert.doesNotMatch(notice, /anonymous/i);
      assert.ok(notice.includes('The collection endpoint also receives your IP address, as with any HTTPS request.'), notice);
      // What the service keeps, and for how long: the IP address is dropped from accepted requests,
      // events are kept for up to 1 year and logs of all requests for up to 10 years.
      assert.match(notice, /It is not stored, except in logs of requests that the endpoint's firewall blocks\./);
      assert.match(notice, /Events are kept for up to 1 year, and logs of all requests, blocked or not, for up to 10 years\./);
      // The sender sets no User-Agent header, so only the payload's package manager user agent is claimed.
      assert.doesNotMatch(notice, /IP address and user agent/);
      // What the event itself carries, and what it never carries.
      assert.match(notice, /random installation and project IDs, and an event ID and timestamp/);
      assert.match(notice, /the template name and version/);
      assert.match(notice, /names and versions of the official Building Blocks the app uses, how many Building Blocks it uses/);
      assert.match(notice, /custom Building Block names are never sent/);
      assert.match(notice, /never include names, email addresses, AWS account IDs, ARNs, file paths, file contents or source code/);
      // The opt-out is CDK's, and the notice points at CDK's own documentation for it.
      assert.ok(notice.includes('cdk cli-telemetry --disable'), notice);
      assert.ok(notice.includes('export CDK_DISABLE_CLI_TELEMETRY=1'), notice);
      assert.ok(notice.includes('https://docs.aws.amazon.com/cdk/v2/guide/cli-telemetry.html#telemetry-opt-out'), notice);
      assert.doesNotMatch(notice, /AWS_BLOCKS_DISABLE_TELEMETRY|blocks-telemetry/, 'the AWS CDK Blocks opt-out is gone');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('describes collection and retention the same way as the core notice', () => {
    // Opt-out instructions differ: the generator can run before an app exists.
    const extract = (url: URL): string => {
      const match = /const FIRST_RUN_NOTICE = `([^`]*)`;/.exec(readFileSync(url, 'utf-8'));
      assert.ok(match, `FIRST_RUN_NOTICE not found in ${url.pathname}`);
      return match[1].split('\nTo opt out everywhere,')[0];
    };
    assert.strictEqual(
      extract(new URL('../src/telemetry.ts', import.meta.url)),
      extract(new URL('../../core/src/telemetry/identifiers.ts', import.meta.url)),
    );
  });

  it('states the same retention as the aws-cdk-blocks README', () => {
    // The README telemetry paragraph repeats the retention lines of the notice word for word.
    const readme = readFileSync(new URL('../../blocks/README.md', import.meta.url), 'utf-8');
    for (const sentence of [
      "It is not stored, except in logs of requests that the endpoint's firewall blocks.",
      'Events are kept for up to 1 year, and logs of all requests, blocked or not, for up to 10 years.',
    ]) {
      assert.ok(readme.includes(sentence), `README is missing: ${sentence}`);
    }
  });
});

describe('create-blocks-app CDK telemetry opt-out (shared case table)', () => {
  const moduleUrl = new URL('./telemetry.js', import.meta.url).href;

  // Run shared consent cases in a child so HOME controls the user CDK config.
  const GATE_CHILD = `
  const [moduleUrl] = process.argv.slice(1);
  const { isTelemetryEnabled } = await import(moduleUrl);
  process.stdout.write(String(isTelemetryEnabled()));
  `;

  const EMIT_CHILD = `
  const [moduleUrl] = process.argv.slice(1);
  const { trackCommand } = await import(moduleUrl);
  await trackCommand('create', async () => {});
  `;

  interface CdkConsentCase {
    name: string;
    cdkEnv: string | null;
    cdkJson: boolean | string | null;
    cdkContextJson: boolean | string | null;
    userCdkJson: boolean | string | null;
    expected: boolean;
  }

  const { cases: cdkCases }: { cases: CdkConsentCase[] } = JSON.parse(
    readFileSync(new URL('../../core/src/telemetry/cdk-consent-cases.test.json', import.meta.url), 'utf-8'),
  );

  function makeTmpDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeCdkConfig(path: string, value: boolean | string): void {
    writeFileSync(path, JSON.stringify({ context: { 'cli-telemetry': value } }));
  }

  function setUpCase(testCase: CdkConsentCase, home: string, project: string): void {
    if (testCase.cdkJson !== null) writeCdkConfig(join(project, 'cdk.json'), testCase.cdkJson);
    if (testCase.cdkContextJson !== null) {
      writeFileSync(join(project, 'cdk.context.json'), JSON.stringify({ 'cli-telemetry': testCase.cdkContextJson }));
    }
    if (testCase.userCdkJson !== null) writeCdkConfig(join(home, '.cdk.json'), testCase.userCdkJson);
  }

  for (const testCase of cdkCases) {
    it(testCase.name, () => {
      const home = makeTmpDir('cba-cdk-consent-home');
      const project = makeTmpDir('cba-cdk-consent-proj');
      try {
        setUpCase(testCase, home, project);

        const result = spawnSync(process.execPath, ['--input-type=module', '-e', GATE_CHILD, moduleUrl], {
          encoding: 'utf-8',
          cwd: project,
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            CDK_DISABLE_CLI_TELEMETRY: testCase.cdkEnv ?? '',
          },
        });

        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stdout, String(testCase.expected), 'isTelemetryEnabled() — the send gate');
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    });
  }

  async function countHttpRequestsForCdk(options: { cdkEnv?: string; cdkContextJson?: boolean }): Promise<number> {
    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => { received.push('hit'); res.writeHead(200); res.end(); });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    const { port } = server.address() as { port: number };
    const home = makeTmpDir('cba-cdk-http-home');
    const project = makeTmpDir('cba-cdk-http-proj');
    if (options.cdkContextJson !== undefined) {
      writeFileSync(join(project, 'cdk.context.json'), JSON.stringify({ 'cli-telemetry': options.cdkContextJson }));
    }

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', EMIT_CHILD, moduleUrl], {
      encoding: 'utf-8',
      cwd: project,
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CDK_DISABLE_CLI_TELEMETRY: options.cdkEnv ?? '',
        BLOCKS_TELEMETRY_ENDPOINT: `http://127.0.0.1:${port}/collect`,
      },
    });
    assert.strictEqual(result.status, 0, result.stderr);

    await new Promise((r) => setTimeout(r, 1_000));
    server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    return received.length;
  }

  it('sends an HTTP request with no CDK opt-out set (positive control)', async () => {
    assert.strictEqual(await countHttpRequestsForCdk({}), 1);
  });

  it('sends no HTTP request when CDK_DISABLE_CLI_TELEMETRY=1', async () => {
    assert.strictEqual(await countHttpRequestsForCdk({ cdkEnv: '1' }), 0);
  });

  it('sends no HTTP request when cdk.context.json disables CDK telemetry', async () => {
    assert.strictEqual(await countHttpRequestsForCdk({ cdkContextJson: false }), 0);
  });
});
