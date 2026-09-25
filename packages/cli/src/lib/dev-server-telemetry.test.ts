import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('dev-server telemetry integration', () => {
  let telemetryServer: Server | null = null;
  let devProcess: ChildProcess | null = null;
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (devProcess && !devProcess.killed) {
      devProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (!devProcess.killed) devProcess.kill('SIGKILL');
    }
    if (telemetryServer) {
      telemetryServer.close();
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('sends telemetry event when dev server starts successfully', async () => {
    const received: string[] = [];

    // 1. Start a mock telemetry endpoint
    telemetryServer = await new Promise<Server>((resolve) => {
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

    const addr = telemetryServer.address() as { port: number };

    // 2. Create a minimal backend file and preload script in a temp directory
    tmpDir = join(tmpdir(), `dev-telemetry-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'backend.ts'), `export const hello = { greet: () => 'world' };\n`);

    // Polyfill process.loadEnvFile for Node <21
    writeFileSync(join(tmpDir, 'preload.mjs'), `
if (!process.loadEnvFile) {
  process.loadEnvFile = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
}
`);

    const scriptContent = `
import { startDevServer } from '${join(__dirname, 'dev-server.js').replace(/\\/g, '/')}';
startDevServer({ backendPath: '${join(tmpDir!, 'backend.ts').replace(/\\/g, '/')}', port: 19877 });
`;
    const scriptPath = join(tmpDir, 'run-dev.ts');
    writeFileSync(scriptPath, scriptContent);

    // 3. Start the dev server as a child process with telemetry endpoint configured
    const tsxBin = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    devProcess = spawn(tsxBin, ['--import', join(tmpDir, 'preload.mjs'), scriptPath], {
      env: {
        ...process.env,
        BLOCKS_TELEMETRY_ENDPOINT: `http://127.0.0.1:${addr.port}/collect`,
        AWS_BLOCKS_DISABLE_TELEMETRY: '',
        CI: '',
        CONTINUOUS_INTEGRATION: '',
        BUILD_NUMBER: '',
        CODEBUILD_BUILD_ID: '',
        GITHUB_ACTIONS: '',
        GITLAB_CI: '',
        CIRCLECI: '',
        JENKINS_URL: '',
        TF_BUILD: '',
        BITBUCKET_BUILD_NUMBER: '',
        BUILDKITE: '',
        BLOCKS_DEV_QUIET: '1',
      },
      cwd: tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    devProcess.stdout?.on('data', (d) => { stdout += d.toString(); });
    devProcess.stderr?.on('data', (d) => { stderr += d.toString(); });

    // 4. Wait for telemetry event to arrive (up to 15 seconds)
    const deadline = Date.now() + 15_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
    }

    // 5. Verify a telemetry event was received
    assert.ok(received.length >= 1, `Expected telemetry event but received ${received.length}. stdout: ${stdout.slice(0, 500)}, stderr: ${stderr.slice(0, 500)}`);

    const parsed = JSON.parse(received[0]);
    assert.strictEqual(parsed.telemetryVersion, '1.0.0');
    assert.strictEqual(parsed.event.command, 'dev');
    assert.strictEqual(parsed.event.state, 'SUCCESS');
    assert.ok(parsed.event.duration >= 0);
    assert.ok(parsed.identifiers.installationId);
    assert.ok(parsed.identifiers.projectId);
    assert.ok(parsed.identifiers.eventId);
    assert.ok(parsed.identifiers.timestamp);
    assert.ok(parsed.environment.os);
    assert.ok(parsed.environment.nodeVersion);
    assert.strictEqual(typeof parsed.environment.ci, 'boolean');

    // Verify no extra top-level fields (server uses additionalProperties: false)
    const allowedTopLevel = ['telemetryVersion', 'identifiers', 'event', 'environment', 'product', 'counters'];
    for (const key of Object.keys(parsed)) {
      assert.ok(allowedTopLevel.includes(key), `Unexpected top-level field: ${key}`);
    }
  });
});
