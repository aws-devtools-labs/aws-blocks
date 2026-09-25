import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';

import { getTelemetryFilePath, isCI, trackCommand } from './telemetry.js';

describe('create-blocks-app telemetry/isCI', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const ciCases: Array<[string, NodeJS.ProcessEnv]> = [
    ['CI=true', { CI: 'true' }],
    ['CONTINUOUS_INTEGRATION', { CONTINUOUS_INTEGRATION: 'true' }],
    ['GitHub Actions', { GITHUB_ACTIONS: 'true' }],
    ['CodeBuild (CODEBUILD_BUILD_ID)', { CODEBUILD_BUILD_ID: 'build-123' }],
    ['CodeBuild (CODEBUILD_BUILD_ARN)', { CODEBUILD_BUILD_ARN: 'arn:aws:codebuild:us-east-1:000000000000:build/p:1' }],
    ['GitLab CI', { GITLAB_CI: 'true' }],
    ['Jenkins (JENKINS_URL + BUILD_ID)', { JENKINS_URL: 'https://jenkins.example.com', BUILD_ID: '42' }],
    ['Jenkins (JENKINS_URL only)', { JENKINS_URL: 'https://jenkins.example.com' }],
    ['Taskcluster (TASK_ID + RUN_ID)', { TASK_ID: 'abc123', RUN_ID: '0' }],
    ['Taskcluster (TASKCLUSTER_ROOT_URL)', { TASKCLUSTER_ROOT_URL: 'https://tc.example.com' }],
    ['Render', { RENDER: 'true' }],
    ['Netlify', { NETLIFY: 'true' }],
    ['Vercel (VERCEL)', { VERCEL: '1' }],
    ['Vercel (NOW_BUILDER)', { NOW_BUILDER: '1' }],
    ['Bitbucket Pipelines (BITBUCKET_BUILD_NUMBER)', { BITBUCKET_BUILD_NUMBER: '7' }],
    ['Heroku (NODE path)', { NODE: '/app/.heroku/node/bin/node' }],
    ['npm user agent with ci/ token', { npm_config_user_agent: 'npm/10.9.2 node/v22.12.0 linux x64 workspaces/false ci/github-actions' }],
  ];

  for (const [label, env] of ciCases) {
    it(`returns true for ${label}`, () => {
      assert.strictEqual(isCI(env), true);
    });
  }

  const nonCiCases: Array<[string, NodeJS.ProcessEnv]> = [
    ['a clean env', {}],
    ['unrelated variables', { HOME: '/home/user', PATH: '/usr/bin', TERM: 'xterm' }],
    ['TASK_ID without RUN_ID', { TASK_ID: 'abc123' }],
    ['Heroku-like NODE outside the Heroku path', { NODE: '/usr/local/bin/node' }],
    ['empty-string CI', { CI: '' }],
    ['npm user agent without ci/ token', { npm_config_user_agent: 'npm/10.9.2 node/v22.12.0 linux x64 workspaces/false' }],
    ['pnpm user agent', { npm_config_user_agent: 'pnpm/9.15.0 npm/? node/v22.12.0 linux x64' }],
    ['yarn user agent', { npm_config_user_agent: 'yarn/4.5.3 npm/? node/v22.12.0 linux x64' }],
    ['bun user agent', { npm_config_user_agent: 'bun/1.1.38 npm/? node/v22.12.0 linux x64' }],
    ['ci/ inside another user-agent token', { npm_config_user_agent: 'npm/10.9.2 node/v22.12.0 linux x64 workspaces/false foo-ci/1' }],
    ['CI=false overriding vendor variables', { CI: 'false', GITHUB_ACTIONS: 'true', CODEBUILD_BUILD_ID: 'b' }],
    ['CI=false overriding the npm ci/ token', { CI: 'false', npm_config_user_agent: 'npm/10.9.2 ci/github-actions' }],
  ];

  for (const [label, env] of nonCiCases) {
    it(`returns false for ${label}`, () => {
      assert.strictEqual(isCI(env), false);
    });
  }

  it('re-reads process.env on every call when no env is passed', () => {
    process.env = {};
    assert.strictEqual(isCI(), false);
    process.env.TASK_ID = 'abc123';
    process.env.RUN_ID = '0';
    assert.strictEqual(isCI(), true);
    process.env = {};
    assert.strictEqual(isCI(), false);
  });

  describe('parity with ci-info', () => {
    const requireCjs = createRequire(import.meta.url);
    const vendors: Array<{ name: string; env: unknown }> = requireCjs('ci-info/vendors.json');

    function freshCiInfoIsCI(env: NodeJS.ProcessEnv): boolean {
      const saved = process.env;
      const resolved = requireCjs.resolve('ci-info');
      delete requireCjs.cache[resolved];
      process.env = { ...env };
      try {
        return requireCjs('ci-info').isCI;
      } finally {
        process.env = saved;
        delete requireCjs.cache[resolved];
      }
    }

    function envSatisfying(spec: unknown): NodeJS.ProcessEnv {
      if (typeof spec === 'string') return { [spec]: 'true' };
      const obj = spec as Record<string, unknown>;
      if (typeof obj.env === 'string' && typeof obj.includes === 'string') return { [obj.env]: obj.includes };
      if (Array.isArray(obj.any)) return { [obj.any[0] as string]: 'true' };
      return { ...(obj as Record<string, string>) };
    }

    it('loads a non-empty vendor table', () => {
      assert.ok(vendors.length > 20, `expected ci-info vendors, got ${vendors.length}`);
    });

    it('agrees with ci-info for every vendor it knows', () => {
      for (const vendor of vendors) {
        const specs = Array.isArray(vendor.env) ? vendor.env : [vendor.env];
        const env = Object.assign({}, ...specs.map(envSatisfying)) as NodeJS.ProcessEnv;
        assert.strictEqual(freshCiInfoIsCI(env), true, `ci-info should detect ${vendor.name}`);
        assert.strictEqual(isCI(env), true, `isCI should detect ${vendor.name} (${JSON.stringify(env)})`);
      }
    });

    it('agrees with ci-info for a clean env and for CI=false', () => {
      assert.strictEqual(freshCiInfoIsCI({}), false);
      assert.strictEqual(isCI({}), false);
      assert.strictEqual(freshCiInfoIsCI({ CI: 'false', GITHUB_ACTIONS: 'true' }), false);
      assert.strictEqual(isCI({ CI: 'false', GITHUB_ACTIONS: 'true' }), false);
    });
  });
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
});
