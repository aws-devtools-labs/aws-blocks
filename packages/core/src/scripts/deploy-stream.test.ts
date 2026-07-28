// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCdkDeployArgs,
  createLineAssembler,
  decideSignalResponse,
  formatElapsed,
  runStreaming,
  DeployProcessError,
  type OutputSink,
  type SignalRegistry,
} from './deploy-stream.js';

const isWindows = process.platform === 'win32';
// The end-to-end signal tests below deliver a *process-group* signal
// (`kill -TERM -pgid`) — the exact shape of the reap that killed a backgrounded
// deploy in issue #222. Windows has no process groups, so those cases are
// POSIX-only; everything else runs everywhere.
const posixOnly = isWindows ? 'POSIX-only (delivers a process-group signal)' : false;

function collectingSink(): OutputSink & { text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// ── signal policy ───────────────────────────────────────────────────────────
// The "decouple the CLI lifecycle from the in-flight deploy" rule, asserted
// directly: which signals abandon a converging CloudFormation deploy and which
// only warn.
describe('decideSignalResponse — a converging deploy is not abandoned by one signal', () => {
  it('defers the first SIGTERM and explains how to force an abort', () => {
    const { action, message } = decideSignalResponse('SIGTERM', false);
    assert.strictEqual(action, 'defer');
    assert.match(message, /Ignoring SIGTERM/);
    assert.match(message, /send SIGTERM again to abort/i);
  });

  it('aborts on a second SIGTERM so an operator is never stuck', () => {
    const { action, message } = decideSignalResponse('SIGTERM', true);
    assert.strictEqual(action, 'abort');
    assert.match(message, /SIGTERM/);
  });

  it('always defers SIGHUP — a closed terminal must not kill a backgrounded deploy', () => {
    assert.strictEqual(decideSignalResponse('SIGHUP', false).action, 'defer');
    assert.strictEqual(decideSignalResponse('SIGHUP', true).action, 'defer');
  });

  it('aborts on the first SIGINT — Ctrl-C is unambiguous intent', () => {
    const { action, message } = decideSignalResponse('SIGINT', false);
    assert.strictEqual(action, 'abort');
    assert.match(message, /Interrupted/);
  });
});

// ── line assembly ───────────────────────────────────────────────────────────
// Pipe chunks split wherever the kernel felt like it; a naive split emits torn
// CloudFormation event lines and drops the final one.
describe('createLineAssembler — whole lines across chunk boundaries', () => {
  it('holds a partial line until the rest of it arrives', () => {
    const assembler = createLineAssembler();
    assert.deepStrictEqual(assembler.push('CREATE_IN_'), []);
    assert.deepStrictEqual(assembler.push('PROGRESS\n'), ['CREATE_IN_PROGRESS']);
  });

  it('emits every complete line in one chunk and buffers the tail', () => {
    const assembler = createLineAssembler();
    assert.deepStrictEqual(assembler.push('one\ntwo\nthr'), ['one', 'two']);
    assert.deepStrictEqual(assembler.flush(), ['thr']);
  });

  it('strips CRLF so Windows CDK output does not carry stray carriage returns', () => {
    const assembler = createLineAssembler();
    assert.deepStrictEqual(assembler.push('one\r\ntwo\r\n'), ['one', 'two']);
  });

  it('flushes an unterminated last line and then nothing', () => {
    const assembler = createLineAssembler();
    assembler.push('tail-without-newline');
    assert.deepStrictEqual(assembler.flush(), ['tail-without-newline']);
    assert.deepStrictEqual(assembler.flush(), []);
  });
});

describe('formatElapsed', () => {
  it('renders sub-minute and multi-minute durations', () => {
    assert.strictEqual(formatElapsed(0), '0s');
    assert.strictEqual(formatElapsed(45_000), '45s');
    assert.strictEqual(formatElapsed(245_000), '4m 05s');
  });

  it('never renders a negative duration', () => {
    assert.strictEqual(formatElapsed(-1_000), '0s');
  });
});

// ── cdk argv contract ───────────────────────────────────────────────────────
// `--ci` is what moves CloudFormation events off stderr and onto stdout (the CDK
// CLI picks its stream as `isCI ? stdout : stderr`), and `--progress events`
// keeps them line-oriented when there is no TTY. Dropping either flag restores
// the 0-byte stdout, so the argv is pinned here.
describe('buildCdkDeployArgs — flags that make the deploy observable', () => {
  const args = buildCdkDeployArgs({ projectRoot: '/app', outputsFile: '.blocks-sandbox/outputs.json' });

  it('sends CDK logs to stdout instead of stderr', () => {
    assert.ok(args.includes('--ci'), `expected --ci in: ${args.join(' ')}`);
  });

  it('asks for per-event progress rather than the TTY progress bar', () => {
    assert.strictEqual(args[args.indexOf('--progress') + 1], 'events');
  });

  it('keeps the existing non-interactive deploy contract', () => {
    assert.strictEqual(args[0], 'cdk');
    assert.strictEqual(args[1], 'deploy');
    assert.strictEqual(args[args.indexOf('--require-approval') + 1], 'never');
    assert.strictEqual(args[args.indexOf('--outputs-file') + 1], '.blocks-sandbox/outputs.json');
    assert.strictEqual(args[args.indexOf('--context') + 1], 'projectRoot=/app');
  });
});

// ── streaming ───────────────────────────────────────────────────────────────
// Real child processes throughout: the proof that output is relayed *while the
// deploy is still running* is causal, not timing-based — the child only exits
// after the test has already seen its first line.
describe('runStreaming — relays output while the child is still running', () => {
  it('surfaces a line before the child exits (the child waits for us to see it)', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-stream-'));
    try {
      const gate = join(dir, 'seen-by-parent');
      // The child prints one line, then blocks until the test writes the gate
      // file — which the test only does after observing that line. If output
      // were buffered until exit (the old behaviour), this deadlocks and fails.
      const script = join(dir, 'gated.mjs');
      writeFileSync(
        script,
        `import { existsSync } from 'node:fs';\n` +
          `console.log('ProbeStack | CREATE_IN_PROGRESS | AWS::Lambda::Function | Handler');\n` +
          `const wait = () => existsSync(${JSON.stringify(gate)}) ? console.log('done') : setTimeout(wait, 25);\n` +
          `wait();\n`,
      );

      const stdout = collectingSink();
      const stderr = collectingSink();
      const run = runStreaming(process.execPath, [script], {
        stdout,
        stderr,
        heartbeatMs: 0,
        signalTarget: new EventEmitter() as unknown as SignalRegistry,
      });

      assert.ok(
        await waitFor(() => stdout.text().includes('CREATE_IN_PROGRESS'), 15_000),
        'the CloudFormation event line must reach stdout while the child is still alive',
      );
      writeFileSync(gate, 'go');

      await run;
      assert.match(stdout.text(), /CREATE_IN_PROGRESS[\s\S]*done/);
      assert.strictEqual(stderr.text(), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps child stderr on stderr so error output is still distinguishable', { timeout: 30_000 }, async () => {
    const stdout = collectingSink();
    const stderr = collectingSink();
    await runStreaming(
      process.execPath,
      ['-e', "console.log('out-line'); console.error('err-line');"],
      { stdout, stderr, heartbeatMs: 0, signalTarget: new EventEmitter() as unknown as SignalRegistry },
    );
    assert.strictEqual(stdout.text(), 'out-line\n');
    assert.strictEqual(stderr.text(), 'err-line\n');
  });

  it('prints an idle heartbeat so a silent CloudFormation phase still reports progress', { timeout: 30_000 }, async () => {
    const stdout = collectingSink();
    await runStreaming(process.execPath, ['-e', 'setTimeout(() => {}, 900);'], {
      stdout,
      stderr: collectingSink(),
      heartbeatMs: 150,
      label: 'cdk deploy',
      signalTarget: new EventEmitter() as unknown as SignalRegistry,
    });
    const beats = stdout.text().split('\n').filter((line) => line.includes('still running'));
    assert.ok(beats.length >= 2, `expected repeated heartbeats, got: ${JSON.stringify(stdout.text())}`);
    assert.match(beats[0], /\[cdk deploy\] still running after \d+s/);
  });

  it('throws a DeployProcessError carrying the child exit code', { timeout: 30_000 }, async () => {
    await assert.rejects(
      () =>
        runStreaming(process.execPath, ['-e', 'process.exit(7)'], {
          stdout: collectingSink(),
          stderr: collectingSink(),
          heartbeatMs: 0,
          signalTarget: new EventEmitter() as unknown as SignalRegistry,
        }),
      (error: unknown) => {
        assert.ok(error instanceof DeployProcessError);
        assert.strictEqual(error.exitCode, 7);
        assert.strictEqual(error.aborted, false);
        return true;
      },
    );
  });

  it('defers a SIGTERM and still completes the run it was told to abandon', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-stream-'));
    try {
      const marker = join(dir, 'child-finished');
      const script = join(dir, 'slow.mjs');
      writeFileSync(
        script,
        `import { writeFileSync } from 'node:fs';\n` +
          `console.log('ProbeStack | CREATE_IN_PROGRESS | AWS::S3::Bucket | Assets');\n` +
          `setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'ok'); console.log('ProbeStack | CREATE_COMPLETE'); }, 700);\n`,
      );

      const stdout = collectingSink();
      const signals = new EventEmitter();
      const run = runStreaming(process.execPath, [script], {
        stdout,
        stderr: collectingSink(),
        heartbeatMs: 0,
        signalTarget: signals as unknown as SignalRegistry,
      });

      assert.ok(
        await waitFor(() => stdout.text().includes('CREATE_IN_PROGRESS'), 15_000),
        'child should be mid-run before the signal',
      );
      signals.emit('SIGTERM');

      await run; // resolves ⇒ the run completed successfully despite the SIGTERM
      assert.match(stdout.text(), /Ignoring SIGTERM/);
      assert.match(stdout.text(), /CREATE_COMPLETE/);
      assert.ok(existsSync(marker), 'the deferred SIGTERM must not have cut the child short');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts on the second SIGTERM and reports it as an abort', { timeout: 30_000 }, async () => {
    const stdout = collectingSink();
    const signals = new EventEmitter();
    const run = runStreaming(process.execPath, ['-e', "console.log('working'); setInterval(() => {}, 1000);"], {
      stdout,
      stderr: collectingSink(),
      heartbeatMs: 0,
      signalTarget: signals as unknown as SignalRegistry,
    });

    assert.ok(await waitFor(() => stdout.text().includes('working'), 15_000), 'child should be running');
    signals.emit('SIGTERM');
    assert.ok(await waitFor(() => stdout.text().includes('Ignoring SIGTERM'), 5_000), 'first SIGTERM is deferred');
    signals.emit('SIGTERM');

    await assert.rejects(
      () => run,
      (error: unknown) => {
        assert.ok(error instanceof DeployProcessError);
        assert.strictEqual(error.aborted, true);
        return true;
      },
    );
    assert.match(stdout.text(), /Received SIGTERM while deploying/);
  });
});

// ── the root cause, verified against the real CDK CLI ───────────────────────
// `buildCdkDeployArgs` passing `--ci` is load-bearing, so it is checked against
// the actual CLI rather than trusted: a `cdk deploy` that reaches the credential
// check writes NOTHING to stdout by default (every line goes to stderr) and
// writes to stdout once CI mode is on. No credentials, no network and no
// mutation are involved — the probe deploys a pre-synthesized assembly pinned to
// the all-zeros account, which never resolves, so CDK always stops before any
// AWS write.
describe('the real CDK CLI only logs to stdout in CI mode', () => {
  const cdkBin = (() => {
    try {
      return createRequire(import.meta.url).resolve('aws-cdk/bin/cdk');
    } catch {
      return undefined;
    }
  })();

  function writeProbeAssembly(): string {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-cdk-probe-'));
    writeFileSync(
      join(dir, 'ProbeStack.template.json'),
      JSON.stringify({ Resources: { Probe: { Type: 'AWS::SNS::Topic' } } }),
    );
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '22.0.0',
        artifacts: {
          ProbeStack: {
            type: 'aws:cloudformation:stack',
            // The all-zeros account is never issued, so the deploy cannot touch
            // real infrastructure even if the runner happens to have credentials.
            environment: 'aws://000000000000/us-east-1',
            properties: { templateFile: 'ProbeStack.template.json' },
          },
        },
      }),
    );
    return dir;
  }

  function probeDeploy(assembly: string, ciFlag: '--ci' | '--no-ci') {
    const env: NodeJS.ProcessEnv = { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' };
    // CDK derives its CI default from the environment; drop those markers so the
    // explicit flag is the only thing deciding the routing.
    for (const key of ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER']) delete env[key];
    return spawnSync(
      process.execPath,
      [
        cdkBin as string,
        ...buildCdkDeployArgs({ projectRoot: assembly, outputsFile: join(assembly, 'outputs.json') }).slice(1),
        ciFlag,
        'ProbeStack',
        '--app',
        assembly,
      ],
      { encoding: 'utf-8', env, timeout: 120_000 },
    );
  }

  it('sends every deploy log line to stderr by default, and to stdout with --ci', { timeout: 180_000 }, (t) => {
    if (!cdkBin) return t.skip('aws-cdk CLI is not installed in this workspace');
    const assembly = writeProbeAssembly();
    try {
      const withCi = probeDeploy(assembly, '--ci');
      const reachedCredentialCheck = /Need to perform AWS calls|credentials/i.test(withCi.stderr ?? '');
      if (!reachedCredentialCheck) {
        return t.skip(`cdk probe never reached the credential check: ${(withCi.stderr ?? '').slice(0, 300)}`);
      }

      const withoutCi = probeDeploy(assembly, '--no-ci');
      assert.strictEqual(
        withoutCi.stdout,
        '',
        'the CDK default routes every log line to stderr — this is the 0-byte stdout in issue #222',
      );
      assert.notStrictEqual(withoutCi.stderr, '', 'the log output still exists, just on the wrong stream');
      assert.notStrictEqual(
        withCi.stdout,
        '',
        '--ci must move the deploy log (CloudFormation progress included) onto stdout',
      );
    } finally {
      rmSync(assembly, { recursive: true, force: true });
    }
  });
});

// ── end-to-end: a backgrounded deploy reaped by its parent shell ────────────
// The issue #222 repro, with real OS signals and three real processes:
//
//   test ──spawn(detached)──▶ deploy wrapper ──runStreaming──▶ fake cdk
//
// The wrapper is its own process-group leader, so `kill -TERM -pgid` reproduces
// exactly what a harness reaping a backgrounded `npm run deploy &` does. The
// fake cdk stands in for the CDK CLI: it prints CloudFormation-shaped events and
// installs no signal handler, so it dies if a signal reaches it.
describe('a backgrounded deploy survives the group SIGTERM that killed it before', { skip: posixOnly }, () => {
  function scaffold(totalTicks: number, tickMs: number): { dir: string; wrapper: string } {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-deploy-'));
    const moduleUrl = new URL('./deploy-stream.js', import.meta.url).href;
    writeFileSync(
      join(dir, 'fake-cdk.mjs'),
      `import { writeFileSync } from 'node:fs';\n` +
        `const dir = process.argv[2];\n` +
        `writeFileSync(dir + '/cdk.pid', String(process.pid));\n` +
        `let n = 0;\n` +
        `const tick = () => {\n` +
        `  n += 1;\n` +
        `  console.log('ProbeStack | ' + n + '/${totalTicks} | CREATE_IN_PROGRESS | AWS::Lambda::Function | Handler' + n);\n` +
        `  if (n >= ${totalTicks}) {\n` +
        `    writeFileSync(dir + '/cfn-done', 'ok');\n` +
        `    console.log('ProbeStack | CREATE_COMPLETE | AWS::CloudFormation::Stack | ProbeStack');\n` +
        `    return;\n` +
        `  }\n` +
        `  setTimeout(tick, ${tickMs});\n` +
        `};\n` +
        `tick();\n`,
    );
    const wrapper = join(dir, 'wrapper.mjs');
    writeFileSync(
      wrapper,
      `import { writeFileSync } from 'node:fs';\n` +
        `import { runStreaming } from ${JSON.stringify(moduleUrl)};\n` +
        `const dir = process.argv[2];\n` +
        `try {\n` +
        `  await runStreaming(process.execPath, [dir + '/fake-cdk.mjs', dir], { label: 'cdk deploy', heartbeatMs: 0 });\n` +
        `  console.log('✅ Deployment complete!');\n` +
        `  writeFileSync(dir + '/wrapper-status', 'complete');\n` +
        `} catch (error) {\n` +
        `  console.log('❌ Deployment failed.');\n` +
        `  writeFileSync(dir + '/wrapper-status', error && error.aborted ? 'aborted' : 'failed');\n` +
        `  process.exitCode = 1;\n` +
        `}\n`,
    );
    return { dir, wrapper };
  }

  it('keeps streaming and finishes the deploy after one group SIGTERM', { timeout: 60_000 }, async () => {
    const { dir, wrapper } = scaffold(12, 80);
    // `detached` makes the wrapper a process-group leader, so the test can
    // signal the whole group the way a shell/harness reaps a background job.
    const child = spawn(process.execPath, [wrapper, dir], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.stderr.on('data', (chunk: string) => { err += chunk; });

    try {
      assert.ok(
        await waitFor(() => out.includes('CREATE_IN_PROGRESS'), 20_000),
        `stdout must carry CloudFormation events while deploying, got: ${JSON.stringify(out)}`,
      );

      assert.ok(child.pid, 'wrapper pid');
      process.kill(-child.pid, 'SIGTERM');

      assert.ok(
        await waitFor(() => out.includes('Ignoring SIGTERM'), 10_000),
        'the wrapper must report that it is ignoring the SIGTERM',
      );
      assert.strictEqual(child.exitCode, null, 'the wrapper must still be alive after the SIGTERM');
      assert.strictEqual(child.signalCode, null, 'the wrapper must not have been killed by the SIGTERM');

      assert.ok(
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000),
        'the wrapper should finish on its own',
      );
      assert.ok(existsSync(join(dir, 'cfn-done')), 'the deploy itself must have run to completion');
      assert.strictEqual(child.signalCode, null, `wrapper was killed by a signal; stderr: ${err}`);
      assert.strictEqual(child.exitCode, 0, `wrapper should exit 0; stdout: ${out}\nstderr: ${err}`);
      assert.strictEqual(readFileSync(join(dir, 'wrapper-status'), 'utf-8'), 'complete');
      assert.match(out, /✅ Deployment complete!/);
      assert.ok(out.length > 0, 'stdout must not be empty (issue #222: 0-byte stdout)');
    } finally {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops the deploy when the group SIGTERM is repeated', { timeout: 60_000 }, async () => {
    const { dir, wrapper } = scaffold(200, 80); // long enough to still be mid-deploy
    const child = spawn(process.execPath, [wrapper, dir], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });

    try {
      assert.ok(await waitFor(() => out.includes('CREATE_IN_PROGRESS'), 20_000), 'deploy should be streaming');
      const cdkPid = Number(readFileSync(join(dir, 'cdk.pid'), 'utf-8'));
      assert.ok(cdkPid > 1, 'fake cdk pid');

      assert.ok(child.pid, 'wrapper pid');
      process.kill(-child.pid, 'SIGTERM');
      assert.ok(await waitFor(() => out.includes('Ignoring SIGTERM'), 10_000), 'first SIGTERM is deferred');
      process.kill(-child.pid, 'SIGTERM');

      assert.ok(
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000),
        'the wrapper should exit after the second SIGTERM',
      );
      assert.match(out, /Received SIGTERM while deploying/);
      assert.strictEqual(child.exitCode, 1, `expected a failed exit, stdout: ${out}`);
      assert.strictEqual(readFileSync(join(dir, 'wrapper-status'), 'utf-8'), 'aborted');
      assert.ok(!existsSync(join(dir, 'cfn-done')), 'the aborted deploy must not have completed');
      assert.ok(
        await waitFor(() => {
          try { process.kill(cdkPid, 0); return false; } catch { return true; }
        }, 15_000),
        'the abort must reap the cdk child, not orphan it',
      );
    } finally {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Control: the shape the deploy CLI used before this fix — a blocking
  // `spawnSync` with the child in the parent's process group and no signal
  // handling. It proves the group SIGTERM above really is lethal, so the passing
  // tests are not vacuous: here the wrapper dies (exit 143 / SIGTERM) and takes
  // the in-flight deploy down with it, exactly as reported in issue #222.
  it('demonstrates the old behaviour: a blocking spawnSync deploy is killed mid-flight', { timeout: 60_000 }, async () => {
    const { dir } = scaffold(200, 80);
    const baseline = join(dir, 'baseline.mjs');
    writeFileSync(
      baseline,
      `import { spawnSync } from 'node:child_process';\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `const dir = process.argv[2];\n` +
        `const result = spawnSync(process.execPath, [dir + '/fake-cdk.mjs', dir], { stdio: 'inherit' });\n` +
        `writeFileSync(dir + '/wrapper-status', 'baseline:' + result.status);\n`,
    );
    const child = spawn(process.execPath, [baseline, dir], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });

    try {
      assert.ok(await waitFor(() => out.includes('CREATE_IN_PROGRESS'), 20_000), 'baseline deploy should be running');
      const cdkPid = Number(readFileSync(join(dir, 'cdk.pid'), 'utf-8'));

      assert.ok(child.pid, 'baseline pid');
      process.kill(-child.pid, 'SIGTERM');

      assert.ok(
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 15_000),
        'the unguarded wrapper dies on the first group SIGTERM',
      );
      assert.strictEqual(child.signalCode, 'SIGTERM', 'the old shape is killed by the signal (exit 143)');
      assert.ok(!existsSync(join(dir, 'wrapper-status')), 'it never reports a terminal status');
      assert.ok(!existsSync(join(dir, 'cfn-done')), 'the in-flight deploy is cut short');
      assert.ok(
        await waitFor(() => {
          try { process.kill(cdkPid, 0); return false; } catch { return true; }
        }, 15_000),
        'the deploy child shares the group, so it dies too',
      );
    } finally {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
