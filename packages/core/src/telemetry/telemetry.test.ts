import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { isDisableValue, isTelemetryEnabled } from './consent.js';
import { detectOS, detectNodeVersion, detectPackageManager, detectAgent, collectEnvironment } from './environment.js';
import { trackCommand, classifyError } from './trackCommand.js';
import { buildAndSendEvent, buildEvent, sendEvent, getTelemetryFilePath } from './client.js';
import { getInstallationId, getProjectId, generateEventId } from './identifiers.js';
import { spawnSync, spawn as spawnChild } from 'node:child_process';
import type { BlocksTelemetryEvent } from './types.js';
import { Scope, OFFICIAL_BB_NAMES } from '../common/index.js';
import type { ScopeParent } from '../common/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DisableValueCase {
  value: string | null;
  expected: boolean;
}

describe('telemetry/isDisableValue (shared case table)', () => {
  const { cases }: { cases: DisableValueCase[] } = JSON.parse(
    readFileSync(new URL('../../src/telemetry/disable-value-cases.test.json', import.meta.url), 'utf-8'),
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

describe('telemetry/consent', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  it('returns false when AWS_BLOCKS_DISABLE_TELEMETRY=1', () => {
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
    delete process.env.CI;
    assert.strictEqual(isTelemetryEnabled(), false);
  });

  for (const value of ['true', 'TRUE', 'yes', ' true ']) {
    it(`returns false when AWS_BLOCKS_DISABLE_TELEMETRY=${JSON.stringify(value)}`, () => {
      process.env.AWS_BLOCKS_DISABLE_TELEMETRY = value;
      delete process.env.CI;
      assert.strictEqual(isTelemetryEnabled(), false);
    });
  }

  // Driven in a child process: afterEach replaces `process.env`, severing HOME.
  const CONSENT_CHILD = `
  const [moduleUrl] = process.argv.slice(1);
  const { isTelemetryEnabled } = await import(moduleUrl);
  process.stdout.write(String(isTelemetryEnabled()));
  `;

  for (const value of ['0', 'false', '']) {
    it(`stays enabled when AWS_BLOCKS_DISABLE_TELEMETRY=${JSON.stringify(value)}`, () => {
      const home = mkdtempSync(join(tmpdir(), 'blocks-consent-home-'));
      const consentUrl = new URL('./consent.js', import.meta.url).href;

      const result = spawnSync(process.execPath, ['--input-type=module', '-e', CONSENT_CHILD, consentUrl], {
        encoding: 'utf-8',
        cwd: home,
        timeout: 30_000,
        env: { HOME: home, USERPROFILE: home, AWS_BLOCKS_DISABLE_TELEMETRY: value, PATH: process.env.PATH ?? '' },
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, 'true');

      rmSync(home, { recursive: true, force: true });
    });
  }

  it('returns true in CI (CI does not suppress telemetry)', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    process.env.CI = 'true';
    const tmp = join(tmpdir(), `blocks-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);
    assert.strictEqual(isTelemetryEnabled(), true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true in CI when project config explicitly enables telemetry', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    process.env.CI = 'true';
    const tmp = join(tmpdir(), `blocks-test-${Date.now()}`);
    mkdirSync(join(tmp, '.blocks'), { recursive: true });
    writeFileSync(join(tmp, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled: true } }));
    process.chdir(tmp);
    assert.strictEqual(isTelemetryEnabled(), true); // CI + config enabled = true
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false in CI when project config explicitly disables telemetry', () => {
    delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    process.env.CI = 'true';
    const tmp = join(tmpdir(), `blocks-test-${Date.now()}`);
    mkdirSync(join(tmp, '.blocks'), { recursive: true });
    writeFileSync(join(tmp, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled: false } }));
    process.chdir(tmp);
    assert.strictEqual(isTelemetryEnabled(), false); // config disable still works in CI
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false when per-project config disables telemetry', () => {
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
    const tmp = join(tmpdir(), `blocks-test-${Date.now()}`);
    mkdirSync(join(tmp, '.blocks'), { recursive: true });
    writeFileSync(join(tmp, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled: false } }));
    process.chdir(tmp);
    assert.strictEqual(isTelemetryEnabled(), false);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('env var disables even when config enables', () => {
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
    const tmp = join(tmpdir(), `blocks-test-${Date.now()}`);
    mkdirSync(join(tmp, '.blocks'), { recursive: true });
    writeFileSync(join(tmp, '.blocks', 'config.json'), JSON.stringify({ telemetry: { enabled: true } }));
    process.chdir(tmp);
    assert.strictEqual(isTelemetryEnabled(), false);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('telemetry/opt-out persists no identifiers', () => {
  // Driven in a child process: the id helpers write to the real HOME and cwd.
  const EMIT_CHILD = `
  const [moduleUrl] = process.argv.slice(1);
  const { buildAndSendEvent } = await import(moduleUrl);
  buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 1 });
  `;

  const moduleUrl = new URL('./client.js', import.meta.url).href;

  for (const value of ['1', 'true', 'TRUE', 'yes', ' true ']) {
    it(`writes no identifiers and sends nothing when AWS_BLOCKS_DISABLE_TELEMETRY=${JSON.stringify(value)}`, () => {
      const home = mkdtempSync(join(tmpdir(), 'blocks-optout-home-'));
      const project = mkdtempSync(join(tmpdir(), 'blocks-optout-proj-'));

      const result = spawnSync(process.execPath, ['--input-type=module', '-e', EMIT_CHILD, moduleUrl], {
        encoding: 'utf-8',
        cwd: project,
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
      assert.ok(!existsSync(join(project, '.blocks', 'config.json')), 'project config.json must not be written');
      assert.doesNotMatch(result.stderr, /sending event to/, 'no event should be sent');
      assert.ok(!result.stderr.includes('AWS Blocks collects anonymous usage data'), 'no first-run notice');

      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    });
  }
});

describe('telemetry/environment', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('isCI', () => {
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

    const moduleUrl = new URL('./environment.js', import.meta.url).href;
    const { cases }: { cases: IsCICase[] } = JSON.parse(
      readFileSync(new URL('../../src/telemetry/is-ci-cases.test.json', import.meta.url), 'utf-8'),
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

  it('detectOS returns a valid platform', () => {
    const os = detectOS();
    assert.ok(['linux', 'darwin', 'win32'].includes(os));
  });

  it('detectNodeVersion returns version without v prefix', () => {
    const version = detectNodeVersion();
    assert.ok(!version.startsWith('v'));
    assert.strictEqual(version, process.versions.node);
  });

  it('detectPackageManager returns npm_config_user_agent', () => {
    process.env.npm_config_user_agent = 'npm/10.2.0 node/v22.0.0';
    assert.strictEqual(detectPackageManager(), 'npm/10.2.0 node/v22.0.0');
  });

  it('detectPackageManager returns undefined when not set', () => {
    delete process.env.npm_config_user_agent;
    assert.strictEqual(detectPackageManager(), undefined);
  });

  describe('detectAgent', () => {
    beforeEach(() => {
      delete process.env.CLAUDECODE;
      delete process.env.CURSOR_TRACE_ID;
      delete process.env.CODEX_CLI_VERSION;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.CLINE_TASK_ID;
      delete process.env.CLINE_SESSION_ID;
      delete process.env.CODEIUM_EDITOR_APP_ROOT;
      delete process.env.WINDSURF_SESSION_ID;
      delete process.env.GEMINI_CLI;
      delete process.env.REPL_ID;
      delete process.env.REPL_OWNER;
      delete process.env.AIDER_MODEL;
      delete process.env.AIDER_SESSION;
      delete process.env.CONTINUE_GLOBAL_DIR;
      delete process.env.ROOCODE_SESSION_ID;
      delete process.env.ROO_SESSION_ID;
      delete process.env.AWS_EXECUTION_ENV;
    });

    it('returns undefined when no agent detected', () => {
      assert.strictEqual(detectAgent(), undefined);
    });

    it('detects claude-code', () => {
      process.env.CLAUDECODE = '1';
      assert.strictEqual(detectAgent(), 'claude-code');
    });

    it('detects cursor', () => {
      process.env.CURSOR_TRACE_ID = 'abc123';
      assert.strictEqual(detectAgent(), 'cursor');
    });

    it('detects amazon-q from AWS_EXECUTION_ENV', () => {
      process.env.AWS_EXECUTION_ENV = 'AmazonQ-Desktop';
      assert.strictEqual(detectAgent(), 'amazon-q');
    });

    it('detects kiro from AWS_EXECUTION_ENV', () => {
      process.env.AWS_EXECUTION_ENV = 'Kiro-IDE';
      assert.strictEqual(detectAgent(), 'kiro');
    });
  });

  it('collectEnvironment returns required fields', () => {
    const env = collectEnvironment();
    assert.ok('os' in env);
    assert.ok('nodeVersion' in env);
    assert.ok('ci' in env);
    assert.strictEqual(typeof env.ci, 'boolean');
    assert.ok(['linux', 'darwin', 'win32'].includes(env.os));
  });

  it('collectEnvironment omits undefined optional fields', () => {
    delete process.env.npm_config_user_agent;
    delete process.env.CLAUDECODE;
    delete process.env.CURSOR_TRACE_ID;
    delete process.env.CODEX_CLI_VERSION;
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CLINE_TASK_ID;
    delete process.env.CLINE_SESSION_ID;
    delete process.env.CODEIUM_EDITOR_APP_ROOT;
    delete process.env.WINDSURF_SESSION_ID;
    delete process.env.GEMINI_CLI;
    delete process.env.REPL_ID;
    delete process.env.REPL_OWNER;
    delete process.env.AIDER_MODEL;
    delete process.env.AIDER_SESSION;
    delete process.env.CONTINUE_GLOBAL_DIR;
    delete process.env.ROOCODE_SESSION_ID;
    delete process.env.ROO_SESSION_ID;
    delete process.env.AWS_EXECUTION_ENV;
    const env = collectEnvironment();
    assert.strictEqual('packageManager' in env, false);
    assert.strictEqual('agent' in env, false);
  });
});

describe('telemetry/identifiers', () => {
  it('generateEventId returns a UUID v4', () => {
    const id = generateEventId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generateEventId returns unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateEventId()));
    assert.strictEqual(ids.size, 100);
  });

  it('getInstallationId returns a consistent UUID', () => {
    const id1 = getInstallationId();
    const id2 = getInstallationId();
    assert.strictEqual(id1, id2);
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('getProjectId returns a UUID', () => {
    const id = getProjectId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe('telemetry/classifyError', () => {
  it('classifies port in use', () => {
    const result = classifyError(new Error('listen EADDRINUSE: address already in use'));
    assert.strictEqual(result.code, 'PORT_IN_USE');
    assert.strictEqual(result.phase, 'startup');
  });

  it('classifies permission denied', () => {
    const result = classifyError(new Error('Access Denied'));
    assert.strictEqual(result.code, 'PERMISSION_DENIED');
    assert.strictEqual(result.phase, 'auth');
  });

  it('classifies credentials failure', () => {
    const result = classifyError(new Error('Could not load credentials'));
    assert.strictEqual(result.code, 'CREDENTIALS_FAILED');
    assert.strictEqual(result.phase, 'auth');
  });

  it('classifies CDK deploy failure', () => {
    const result = classifyError(new Error('Deployment failed: stack update failed'));
    assert.strictEqual(result.code, 'CDK_DEPLOY_FAILED');
    assert.strictEqual(result.phase, 'deploy');
  });

  it('classifies CDK destroy failure', () => {
    const result = classifyError(new Error('cdk destroy failed'));
    assert.strictEqual(result.code, 'CDK_DESTROY_FAILED');
    assert.strictEqual(result.phase, 'destroy');
  });

  it('classifies npm install failure', () => {
    const result = classifyError(new Error('npm install failed with code 1'));
    assert.strictEqual(result.code, 'NPM_INSTALL_FAILED');
    assert.strictEqual(result.phase, 'install');
  });

  it('classifies unknown errors', () => {
    const result = classifyError(new Error('something totally unexpected'));
    assert.strictEqual(result.code, 'UNKNOWN');
    assert.strictEqual(result.phase, 'unknown');
  });

  it('classifies non-Error as UNKNOWN', () => {
    const result = classifyError('just a string');
    assert.strictEqual(result.code, 'UNKNOWN');
    assert.strictEqual(result.phase, 'unknown');
  });
});

describe('telemetry/trackCommand', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('executes the function when telemetry is disabled', async () => {
    let called = false;
    await trackCommand('deploy', async () => { called = true; });
    assert.strictEqual(called, true);
  });

  it('re-throws errors from the wrapped function', async () => {
    await assert.rejects(
      () => trackCommand('deploy', async () => { throw new Error('boom'); }),
      { message: 'boom' },
    );
  });

  it('executes the function when telemetry is enabled (with no endpoint)', async () => {
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:19999/noop';
    let called = false;
    await trackCommand('sandbox', async () => { called = true; });
    assert.strictEqual(called, true);
  });
});

describe('telemetry/client', () => {
  it('buildAndSendEvent sends event when telemetry is enabled', async () => {
    const originalEnv = { ...process.env };
    const received: string[] = [];

    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 1234 });

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(received.length, 1);
    const parsed = JSON.parse(received[0]);
    assert.strictEqual(parsed.telemetryVersion, '1.0.0');
    assert.strictEqual(parsed.event.command, 'deploy');
    assert.strictEqual(parsed.event.state, 'SUCCESS');
    assert.strictEqual(parsed.event.duration, 1234);
    assert.ok(parsed.identifiers.installationId);
    assert.ok(parsed.identifiers.projectId);
    assert.ok(parsed.identifiers.eventId);
    assert.ok(parsed.product.blocksVersion);
    assert.ok(parsed.environment.os);

    server.close();
    process.env = { ...originalEnv };
  });

  it('buildAndSendEvent does not send HTTP when telemetry is disabled', async () => {
    const originalEnv = { ...process.env };
    const received: string[] = [];

    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          received.push(body);
          res.writeHead(200);
          res.end();
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    const addr = server.address() as { port: number };
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 500 });

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(received.length, 0);

    server.close();
    process.env = { ...originalEnv };
  });

  it('sendEvent fires HTTP POST to configured endpoint', async () => {
    const originalEnv = { ...process.env };
    const received: string[] = [];

    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          received.push(body);
          res.writeHead(200);
          res.end();
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    const addr = server.address() as { port: number };
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    const event: BlocksTelemetryEvent = {
      telemetryVersion: '1.0.0',
      identifiers: {
        installationId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
        eventId: '33333333-3333-4333-8333-333333333333',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      event: { command: 'deploy', state: 'SUCCESS', duration: 1234 },
      environment: { os: 'linux', nodeVersion: '22.0.0', ci: false },
    };

    sendEvent(event);

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(received.length, 1);
    const parsed = JSON.parse(received[0]);
    assert.strictEqual(parsed.telemetryVersion, '1.0.0');
    assert.strictEqual(parsed.identifiers.installationId, '11111111-1111-4111-8111-111111111111');
    assert.strictEqual(parsed.identifiers.projectId, '22222222-2222-4222-8222-222222222222');
    assert.strictEqual(parsed.identifiers.eventId, '33333333-3333-4333-8333-333333333333');
    assert.strictEqual(parsed.event.command, 'deploy');
    assert.strictEqual(parsed.event.state, 'SUCCESS');
    assert.strictEqual(parsed.event.duration, 1234);
    assert.strictEqual(parsed.environment.os, 'linux');
    assert.strictEqual(parsed.environment.nodeVersion, '22.0.0');
    assert.strictEqual(parsed.environment.ci, false);

    server.close();
    process.env = { ...originalEnv };
  });

  it('sendEvent does not throw on network error', () => {
    const originalEnv = { ...process.env };
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/unreachable';

    const event: BlocksTelemetryEvent = {
      telemetryVersion: '1.0.0',
      identifiers: {
        installationId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
        eventId: '33333333-3333-4333-8333-333333333333',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      event: { command: 'deploy', state: 'FAIL', duration: 500, error: { code: 'CDK_DEPLOY_FAILED', phase: 'deploy' } },
      environment: { os: 'linux', nodeVersion: '22.0.0', ci: false },
    };

    assert.doesNotThrow(() => sendEvent(event));

    process.env = { ...originalEnv };
  });
});

describe('telemetry/send-worker', () => {
  it('worker POSTs payload from stdin to endpoint', async () => {
    const received: string[] = [];

    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          received.push(body);
          res.writeHead(200);
          res.end();
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    const addr = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${addr.port}/collect`;
    const payload = JSON.stringify({ test: true, command: 'dev' });
    const workerPath = join(__dirname, 'telemetry-send-worker.js');

    const exitCode = await new Promise<number | null>((resolve) => {
      const proc = spawnChild(process.execPath, [workerPath, endpoint], {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      proc.stdin!.write(payload);
      proc.stdin!.end();
      proc.on('close', (code) => resolve(code));
    });

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(JSON.parse(received[0]), { test: true, command: 'dev' });

    server.close();
  });

  it('worker exits with 1 on unreachable endpoint', async () => {
    const payload = JSON.stringify({ test: true });
    const workerPath = join(__dirname, 'telemetry-send-worker.js');

    const exitCode = await new Promise<number | null>((resolve) => {
      const proc = spawnChild(process.execPath, [workerPath, 'http://127.0.0.1:1/unreachable'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      proc.stdin!.write(payload);
      proc.stdin!.end();
      proc.on('close', (code) => resolve(code));
    });

    assert.strictEqual(exitCode, 1);
  });

  it('worker writes debug output to stderr when NODE_DEBUG is set', async () => {
    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => { res.writeHead(200); res.end(); });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    const addr = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${addr.port}/collect`;
    const payload = JSON.stringify({ test: true });
    const workerPath = join(__dirname, 'telemetry-send-worker.js');

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const proc = spawnChild(process.execPath, [workerPath, endpoint], {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '', NODE_DEBUG: 'blocks-telemetry' },
      });
      let stderr = '';
      proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.stdin!.write(payload);
      proc.stdin!.end();
      proc.on('close', (code) => resolve({ code, stderr }));
    });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stderr.includes('BLOCKS-TELEMETRY: sent (status=200)'), `Expected debug output, got: ${result.stderr}`);

    server.close();
  });
});

describe('telemetry/trackCommand integration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sends telemetry event matching server schema on successful command', async () => {
    const received: string[] = [];

    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    await trackCommand('deploy', async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(received.length, 1);
    const parsed = JSON.parse(received[0]) as BlocksTelemetryEvent;

    // Verify schema structure
    assert.strictEqual(parsed.telemetryVersion, '1.0.0');
    assert.ok(parsed.identifiers.installationId);
    assert.ok(parsed.identifiers.projectId);
    assert.ok(parsed.identifiers.eventId);
    assert.ok(parsed.identifiers.timestamp);
    assert.strictEqual(parsed.event.command, 'deploy');
    assert.strictEqual(parsed.event.state, 'SUCCESS');
    assert.ok(parsed.event.duration >= 40);
    assert.ok(parsed.environment.os);
    assert.ok(parsed.environment.nodeVersion);
    assert.strictEqual(typeof parsed.environment.ci, 'boolean');

    // Verify no extra top-level fields (additionalProperties: false)
    const allowedTopLevel = ['telemetryVersion', 'identifiers', 'event', 'environment', 'product', 'counters'];
    for (const key of Object.keys(parsed)) {
      assert.ok(allowedTopLevel.includes(key), `Unexpected top-level field: ${key}`);
    }

    server.close();
  });

  it('sends telemetry event with error info on failure', async () => {
    const received: string[] = [];

    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    await assert.rejects(
      () => trackCommand('sandbox', async () => {
        throw new Error('Deployment failed: stack update failed');
      }),
      { message: 'Deployment failed: stack update failed' },
    );

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(received.length, 1);
    const parsed = JSON.parse(received[0]) as BlocksTelemetryEvent;
    assert.strictEqual(parsed.event.command, 'sandbox');
    assert.strictEqual(parsed.event.state, 'FAIL');
    assert.ok(parsed.event.error);
    assert.strictEqual(parsed.event.error!.code, 'CDK_DEPLOY_FAILED');
    assert.strictEqual(parsed.event.error!.phase, 'deploy');

    server.close();
  });

  it('includes product and counters when options provided', async () => {
    const received: string[] = [];

    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    await trackCommand('create-blocks-app', async () => {}, {
      template: 'demo',
      framework: 'nextjs',
      blocksCount: 2,
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(received.length, 1);
    const parsed = JSON.parse(received[0]) as BlocksTelemetryEvent;
    assert.strictEqual(parsed.event.command, 'create-blocks-app');
    assert.ok(parsed.product);
    assert.deepStrictEqual(parsed.product!.template, { name: 'demo' });
    assert.strictEqual(parsed.product!.framework, 'nextjs');
    assert.strictEqual(parsed.product!.buildingBlocks, undefined);
    assert.ok(parsed.counters);
    assert.strictEqual(parsed.counters!.blocksCount, 2);

    server.close();
  });
});

describe('telemetry/identifiers first-run notice', () => {
  it('prints first-run notice to stderr when installation-id file does not exist', () => {
    const tmp = join(tmpdir(), `blocks-test-firstrun-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    const script = `
      import { getInstallationId } from './identifiers.js';
      const id = getInstallationId();
      process.stdout.write(id);
    `;

    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '-e', script,
    ], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: tmp },
      cwd: __dirname,
    });

    assert.ok(result.stderr.includes('AWS Blocks collects anonymous usage data to improve the product.'));
    assert.ok(result.stderr.includes('No customer content or PII is collected.'));
    assert.ok(result.stderr.includes('AWS_BLOCKS_DISABLE_TELEMETRY=1'));
    assert.ok(result.stdout.trim().length > 0, 'Should output an installation ID');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('does NOT print first-run notice when installation-id file already exists', () => {
    const tmp = join(tmpdir(), `blocks-test-nonotice-${Date.now()}`);
    const telemetryDir = join(tmp, '.blocks', 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    const existingId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    writeFileSync(join(telemetryDir, 'installation-id'), existingId, 'utf-8');

    const script = `
      import { getInstallationId } from './identifiers.js';
      const id = getInstallationId();
      process.stdout.write(id);
    `;

    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '-e', script,
    ], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: tmp },
      cwd: __dirname,
    });

    assert.strictEqual(result.stderr, '');
    assert.strictEqual(result.stdout.trim(), existingId);

    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('telemetry/--telemetry-file flag', () => {
  const originalArgv = [...process.argv];
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.argv = [...originalArgv];
    process.env = { ...originalEnv };
  });

  it('getTelemetryFilePath returns undefined when flag is not set', () => {
    process.argv = ['node', 'script.js'];
    assert.strictEqual(getTelemetryFilePath(), undefined);
  });

  it('getTelemetryFilePath parses --telemetry-file=path form', () => {
    process.argv = ['node', 'script.js', '--telemetry-file=/tmp/events.json'];
    assert.strictEqual(getTelemetryFilePath(), '/tmp/events.json');
  });

  it('getTelemetryFilePath parses --telemetry-file path form', () => {
    process.argv = ['node', 'script.js', '--telemetry-file', '/tmp/events.json'];
    assert.strictEqual(getTelemetryFilePath(), '/tmp/events.json');
  });

  it('does not treat a flag as a file path in space-separated form', () => {
    process.argv = ['node', 'script.js', '--telemetry-file', '--some-flag'];
    assert.strictEqual(getTelemetryFilePath(), undefined);
  });

  it('writes event to file when --telemetry-file is set', async () => {
    const tmp = join(tmpdir(), `blocks-telemetry-file-test-${Date.now()}`);
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 1234 });

    assert.ok(existsSync(filePath), 'Telemetry file should be created');
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event.command, 'deploy');
    assert.strictEqual(events[0].event.state, 'SUCCESS');
    assert.strictEqual(events[0].event.duration, 1234);
    assert.ok(events[0].telemetryVersion);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('does not write file when --telemetry-file is not set', () => {
    process.argv = ['node', 'script.js'];
    assert.strictEqual(getTelemetryFilePath(), undefined);
  });

  it('writes file even when telemetry is disabled (matches CDK behavior)', () => {
    const filePath = join(tmpdir(), `blocks-telemetry-disabled-${Date.now()}`, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';

    buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 1 });

    assert.ok(existsSync(filePath), 'File should be written even when telemetry is disabled');
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event.command, 'deploy');

    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it('creates parent directories for telemetry file', () => {
    const tmp = join(tmpdir(), `blocks-telemetry-mkdir-test-${Date.now()}`);
    const filePath = join(tmp, 'nested', 'deep', 'events.json');
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    buildAndSendEvent({ command: 'sandbox', state: 'SUCCESS', duration: 100 });

    assert.ok(existsSync(filePath), 'Nested telemetry file should be created');
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event.command, 'sandbox');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('skips writing when file already exists (not created by this process)', () => {
    const tmp = join(tmpdir(), `blocks-telemetry-append-test-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(filePath, JSON.stringify([{ existing: true }]));

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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 200 });

    const content = readFileSync(filePath, 'utf-8');
    const events = JSON.parse(content);
    assert.strictEqual(events.length, 1, 'Pre-existing file should not be modified');
    assert.deepStrictEqual(events[0], { existing: true });

    rmSync(tmp, { recursive: true, force: true });
  });

  it('still sends HTTP when --telemetry-file is set (additive)', async () => {
    const tmp = join(tmpdir(), `blocks-telemetry-both-test-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];

    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 300 });

    await new Promise((r) => setTimeout(r, 200));

    // File sink fired
    assert.ok(existsSync(filePath));
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);

    // HTTP sink also fired
    assert.strictEqual(received.length, 1);

    server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes file but does NOT send HTTP when telemetry is disabled', async () => {
    const tmp = join(tmpdir(), `blocks-telemetry-file-no-http-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];

    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          received.push(body);
          res.writeHead(200);
          res.end();
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    const addr = server.address() as { port: number };
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 300 });

    await new Promise((r) => setTimeout(r, 200));

    // File sink fired (regardless of opt-out)
    assert.ok(existsSync(filePath), 'File should be written even when telemetry is disabled');
    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event.command, 'deploy');

    // HTTP sink did NOT fire
    assert.strictEqual(received.length, 0, 'HTTP should NOT be sent when telemetry is disabled');

    server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes file even when telemetry is disabled via project config (matches CDK behavior)', () => {
    const filePath = join(tmpdir(), `blocks-telemetry-config-disabled-${Date.now()}`, 'events.json');
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

    const configDir = join(process.cwd(), '.blocks');
    const configPath = join(configDir, 'config.json');
    const had = existsSync(configPath);
    const original = had ? readFileSync(configPath, 'utf-8') : null;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ telemetry: { enabled: false } }));

    try {
      buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 1 });
      assert.ok(existsSync(filePath), 'File should be written even when project config disables telemetry');
      const events = JSON.parse(readFileSync(filePath, 'utf-8'));
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].event.command, 'deploy');
      rmSync(dirname(filePath), { recursive: true, force: true });
    } finally {
      if (had) writeFileSync(configPath, original!);
      else rmSync(configDir, { recursive: true, force: true });
    }
  });
  it('writes file even when telemetry is disabled via global config (matches CDK behavior)', () => {
    const filePath = join(tmpdir(), `blocks-telemetry-global-disabled-${Date.now()}`, 'events.json');
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

    // Use homedir() to find the actual global config path (os.homedir reads
    // from native env, not the plain-object process.env that afterEach installs).
    const globalConfigDir = join(homedir(), '.blocks');
    const globalConfigPath = join(globalConfigDir, 'config.json');
    const hadConfig = existsSync(globalConfigPath);
    const originalConfig = hadConfig ? readFileSync(globalConfigPath, 'utf-8') : null;
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(globalConfigPath, JSON.stringify({ telemetry: { enabled: false } }));

    try {
      buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 1 });
      assert.ok(existsSync(filePath), 'File should be written even when global config disables telemetry');
      const events = JSON.parse(readFileSync(filePath, 'utf-8'));
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].event.command, 'deploy');
      rmSync(dirname(filePath), { recursive: true, force: true });
    } finally {
      if (hadConfig) {
        writeFileSync(globalConfigPath, originalConfig!);
      } else {
        rmSync(globalConfigPath, { force: true });
      }
    }
  });

  it('handles path containing = correctly', () => {
    const filePath = join(tmpdir(), `blocks-eq-${Date.now()}`, 'a=b', 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    assert.strictEqual(getTelemetryFilePath(), filePath);
  });

  it('rejects empty path', () => {
    process.argv = ['node', 'script.js', '--telemetry-file='];
    assert.strictEqual(getTelemetryFilePath(), undefined);
  });

  it('rejects whitespace-only path', () => {
    process.argv = ['node', 'script.js', '--telemetry-file=   '];
    assert.strictEqual(getTelemetryFilePath(), undefined);
  });

  it('handles path with spaces', () => {
    const filePath = join(tmpdir(), `blocks telemetry ${Date.now()}`, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 1 });
    assert.ok(existsSync(filePath));
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it('skips pre-existing file atomically (no race condition)', () => {
    const filePath = join(tmpdir(), `blocks-atomic-${Date.now()}`, 'events.json');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify([{ existing: true }]));

    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 1 });

    // Original file should be untouched
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.deepStrictEqual(content, [{ existing: true }]);
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it('keeps every event when one run emits several', () => {
    const tmp = join(tmpdir(), `blocks-telemetry-multi-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    try {
      buildAndSendEvent({
        command: 'dev', state: 'FAIL', duration: 1, error: { code: 'PORT_IN_USE', phase: 'startup' },
      });
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 2 });
      buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 3 });

      const events = JSON.parse(readFileSync(filePath, 'utf-8'));
      assert.strictEqual(events.length, 3, 'A run emitting several events must keep all of them');
      assert.deepStrictEqual(
        events.map((e: BlocksTelemetryEvent) => [e.event.command, e.event.state]),
        [['dev', 'FAIL'], ['dev', 'SUCCESS'], ['deploy', 'SUCCESS']],
        'Events must be kept in emission order',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports an append failure on stderr when NODE_DEBUG is set', () => {
    const tmp = join(tmpdir(), `blocks-telemetry-debug-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    mkdirSync(tmp, { recursive: true });

    const script = `
      import { writeFileSync } from 'node:fs';
      import { buildAndSendEvent } from './client.js';
      process.argv = ['node', 'script.js', '--telemetry-file=' + ${JSON.stringify(filePath)}];
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 1 });
      writeFileSync(${JSON.stringify(filePath)}, 'not json');
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 2 });
    `;

    // Opted out so the HTTP sink's detached worker never holds this stderr pipe open.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      env: { ...process.env, NODE_DEBUG: 'blocks-telemetry', AWS_BLOCKS_DISABLE_TELEMETRY: '1' },
      cwd: __dirname,
      timeout: 20_000,
    });

    try {
      assert.match(
        result.stderr ?? '', /failed to append telemetry event/,
        `Expected debug output, got: ${result.stderr}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('leaves the file alone when its content stops being a JSON array mid-run', () => {
    const tmp = join(tmpdir(), `blocks-telemetry-clobber-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    try {
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 1 });
      writeFileSync(filePath, 'not json');
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 2 });

      assert.strictEqual(readFileSync(filePath, 'utf-8'), 'not json');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not append to a foreign file when the cwd changes under a relative path', () => {
    const owned = join(tmpdir(), `blocks-telemetry-cwd-a-${Date.now()}`);
    const foreign = join(tmpdir(), `blocks-telemetry-cwd-b-${Date.now()}`);
    mkdirSync(owned, { recursive: true });
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'events.json'), '[{"USER_AUTHORED":true}]');

    // Ownership is keyed on the resolved path, so the same relative spelling under a
    // different cwd is a different file and must not be treated as ours.
    const script = `
      const { buildAndSendEvent } = await import('./client.js');
      process.argv = ['node', 'script.js', '--telemetry-file=events.json'];
      process.chdir(${JSON.stringify(owned)});
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 1 });
      process.chdir(${JSON.stringify(foreign)});
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 2 });
    `;

    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf-8',
        env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1' },
        cwd: __dirname,
        timeout: 20_000,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(
        readFileSync(join(foreign, 'events.json'), 'utf-8'), '[{"USER_AUTHORED":true}]',
        'a file this run did not create must be left untouched',
      );
    } finally {
      rmSync(owned, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('leaves a clobbered non-array file intact even when Object.prototype is polluted', () => {
    const tmp = join(tmpdir(), `blocks-telemetry-proto-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    mkdirSync(tmp, { recursive: true });

    // The child creates the file itself, so the path is owned and the append path
    // is reachable. A polluted push makes a plain object pushable, so only an explicit array
    // check keeps the sink from writing a mutated user object back to disk.
    const script = `
      Object.prototype.push = function (x) { this.polluted = x; return 1; };
      const { writeFileSync } = await import('node:fs');
      const { buildAndSendEvent } = await import('./client.js');
      process.argv = ['node', 'script.js', '--telemetry-file=' + ${JSON.stringify(filePath)}];
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 1 });
      writeFileSync(${JSON.stringify(filePath)}, '{"USER_AUTHORED":true}');
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 2 });
    `;

    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf-8',
        env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1' },
        cwd: __dirname,
        timeout: 20_000,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(readFileSync(filePath, 'utf-8'), '{"USER_AUTHORED":true}');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps the appended file 2-space indented, as the first write leaves it', () => {
    const tmp = join(tmpdir(), `blocks-telemetry-shape-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    try {
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 1 });
      const afterFirst = JSON.parse(readFileSync(filePath, 'utf-8'));
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 2 });
      const afterSecond = JSON.parse(readFileSync(filePath, 'utf-8'));

      assert.strictEqual(
        readFileSync(filePath, 'utf-8'),
        JSON.stringify([afterFirst[0], afterSecond[1]], null, 2),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still sends the HTTP event when the append throws', async () => {
    const tmp = join(tmpdir(), `blocks-telemetry-contain-${Date.now()}`);
    const filePath = join(tmp, 'events.json');
    process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];

    const received: string[] = [];
    const server: Server = await new Promise((resolve) => {
      const srv = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => { received.push(body); res.writeHead(200); res.end(); });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const addr = server.address() as { port: number };
    process.env.BLOCKS_TELEMETRY_ENDPOINT = `http://127.0.0.1:${addr.port}/collect`;

    try {
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 1 });
      writeFileSync(filePath, 'not json');
      buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 2 });
      await new Promise((r) => setTimeout(r, 400));

      assert.strictEqual(received.length, 2, 'a failed file append must not suppress the HTTP sink');
    } finally {
      server.close();
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
      readFileSync(new URL('../../src/telemetry/telemetry-file-append-cases.test.json', import.meta.url), 'utf-8'),
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
      it(testCase.name, () => {
        const tmp = join(tmpdir(), `blocks-own-case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const filePath = join(tmp, 'events.json');
        mkdirSync(tmp, { recursive: true });
        if (testCase.preExisting !== null) writeFileSync(filePath, testCase.preExisting);

        process.argv = ['node', 'script.js', `--telemetry-file=${filePath}`];
        process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

        try {
          for (let i = 0; i < testCase.emits; i++) {
            buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: i + 1 });
          }

          const content = readFileSync(filePath, 'utf-8');
          if (testCase.preserved) {
            assert.strictEqual(content, testCase.preExisting, 'a pre-existing file must be left untouched');
          } else {
            const events = JSON.parse(content);
            assert.ok(Array.isArray(events), 'sink must write a JSON array');
            assert.strictEqual(events.length, testCase.expectedLength);
            assert.strictEqual(events[events.length - 1].event.command, 'deploy');
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  });

});

/** Test BB subclass that simulates an official Building Block. */
class OfficialTestBB extends Scope {
  constructor(parent: ScopeParent, id: string) {
    super(id, { parent, bbName: 'KVStore', bbVersion: '1.0.0' });
  }
}

/** Test BB subclass with a different official name. */
class AnotherOfficialBB extends Scope {
  constructor(parent: ScopeParent, id: string) {
    super(id, { parent, bbName: 'Database', bbVersion: '2.0.0' });
  }
}

/** Test BB subclass that simulates a custom (non-official) Building Block. */
class CustomTestBB extends Scope {
  constructor(parent: ScopeParent, id: string) {
    super(id, { parent, bbName: 'MyCustomBlock', bbVersion: '0.1.0' });
  }
}

describe('Scope.getRegisteredBlocks', () => {
  afterEach(() => {
    Scope._resetRegistry();
  });

  it('returns empty when no BBs have been instantiated', () => {
    const result = Scope.getRegisteredBlocks();
    assert.deepStrictEqual(result, { blocks: [], totalCount: 0, customBlocksCount: 0 });
  });

  it('registers an official BB after instantiation', () => {
    const parent = { id: 'test-app' };
    new OfficialTestBB(parent, 'store-1');

    const result = Scope.getRegisteredBlocks();
    assert.deepStrictEqual(result.blocks, [{ name: 'KVStore', version: '1.0.0' }]);
    assert.strictEqual(result.totalCount, 1);
  });

  it('custom BB is counted but NOT included in blocks (privacy)', () => {
    const parent = { id: 'test-app' };
    new CustomTestBB(parent, 'custom-1');

    const result = Scope.getRegisteredBlocks();
    assert.deepStrictEqual(result.blocks, []);
    assert.strictEqual(result.totalCount, 1);
    assert.strictEqual(result.customBlocksCount, 1);
  });

  it('multiple instances of the same BB are counted correctly', () => {
    const parent = { id: 'test-app' };
    new OfficialTestBB(parent, 'store-1');
    new OfficialTestBB(parent, 'store-2');
    new OfficialTestBB(parent, 'store-3');

    const result = Scope.getRegisteredBlocks();
    assert.deepStrictEqual(result.blocks, [{ name: 'KVStore', version: '1.0.0' }]);
    assert.strictEqual(result.totalCount, 3);
  });

  it('multiple different BBs are tracked independently', () => {
    const parent = { id: 'test-app' };
    new OfficialTestBB(parent, 'store-1');
    new AnotherOfficialBB(parent, 'db-1');
    new CustomTestBB(parent, 'custom-1');

    const result = Scope.getRegisteredBlocks();
    assert.strictEqual(result.blocks.length, 2);
    assert.ok(result.blocks.some(b => b.name === 'KVStore'));
    assert.ok(result.blocks.some(b => b.name === 'Database'));
    assert.strictEqual(result.totalCount, 3);
    assert.strictEqual(result.customBlocksCount, 1);
  });


  it('multiple instances of one custom BB counts all instances', () => {
    const parent = { id: 'test-app' };
    new CustomTestBB(parent, 'custom-1');
    new CustomTestBB(parent, 'custom-2');

    const result = Scope.getRegisteredBlocks();
    // totalCount includes both instances
    assert.strictEqual(result.totalCount, 2);
    // customBlocksCount counts total custom instances, not distinct types
    assert.strictEqual(result.customBlocksCount, 2);
    assert.deepStrictEqual(result.blocks, []);

  });
  it('_resetRegistry clears everything', () => {
    const parent = { id: 'test-app' };
    new OfficialTestBB(parent, 'store-1');
    new AnotherOfficialBB(parent, 'db-1');

    assert.strictEqual(Scope.getRegisteredBlocks().totalCount, 2);

    Scope._resetRegistry();

    const result = Scope.getRegisteredBlocks();
    assert.deepStrictEqual(result, { blocks: [], totalCount: 0, customBlocksCount: 0 });
  });

  it('plain Scope (no bbName) does not appear in registry', () => {
    const parent = { id: 'test-app' };
    new Scope('plain-scope', { parent });

    const result = Scope.getRegisteredBlocks();
    assert.deepStrictEqual(result, { blocks: [], totalCount: 0, customBlocksCount: 0 });
  });
});

describe('telemetry/buildAndSendEvent with Scope registry', () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    Scope._resetRegistry();
  });

  it('includes registered BBs in the telemetry event', async () => {
    const parent = { id: 'test-app' };
    new OfficialTestBB(parent, 'store-1');
    new AnotherOfficialBB(parent, 'db-1');
    new CustomTestBB(parent, 'custom-1');

    const tmp = join(tmpdir(), `blocks-telemetry-bb-test-${Date.now()}`);
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: 1000 });

    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    const parsed = events[0];

    assert.ok(Array.isArray(parsed.product.buildingBlocks));
    assert.ok(parsed.product.buildingBlocks.some((b: any) => b.name === 'KVStore' && b.version === '1.0.0'));
    assert.ok(parsed.product.buildingBlocks.some((b: any) => b.name === 'Database' && b.version === '2.0.0'));
    // Custom BB names must NEVER appear in the telemetry event
    assert.ok(!parsed.product.buildingBlocks.some((b: any) => b.name === 'MyCustomBlock'));
    assert.strictEqual(parsed.counters.customBuildingBlocks, 1);
    assert.strictEqual(parsed.counters.blocksCount, 3);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('omits buildingBlocks when no BBs registered', async () => {
    const tmp = join(tmpdir(), `blocks-telemetry-nobb-test-${Date.now()}`);
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
    process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';

    buildAndSendEvent({ command: 'deploy', state: 'SUCCESS', duration: 500 });

    const events = JSON.parse(readFileSync(filePath, 'utf-8'));
    const parsed = events[0];

    assert.strictEqual(parsed.product.buildingBlocks, undefined);
    assert.strictEqual(parsed.counters, undefined);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('custom BB names are NEVER included in the telemetry event', () => {
    const parent = { id: 'test-app' };
    new CustomTestBB(parent, 'custom-1');
    new OfficialTestBB(parent, 'store-1');

    const event = buildEvent({ command: 'dev', state: 'SUCCESS', duration: 500 });

    // Official BB is present with version
    assert.ok(Array.isArray(event.product!.buildingBlocks));
    assert.ok(event.product!.buildingBlocks!.some((b: any) => b.name === 'KVStore' && b.version === '1.0.0'));

    // Custom BB name must NEVER appear in the event payload
    assert.ok(!event.product!.buildingBlocks!.some((b: any) => b.name === 'MyCustomBlock'));

    // Custom blocks are only counted, never named
    assert.strictEqual(event.counters!.customBuildingBlocks, 1);
    assert.strictEqual(event.counters!.blocksCount, 2);
  });

  it('reads template info from project package.json', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'telemetry-tpl-'));
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      blocksTemplate: 'nextjs',
      blocksTemplateVersion: '0.5.3',
    }));

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const event = buildEvent({ command: 'deploy', state: 'SUCCESS', duration: 100 });

      assert.deepStrictEqual(event.product!.template, { name: 'nextjs', version: '0.5.3' });
    } finally {
      process.chdir(originalCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
