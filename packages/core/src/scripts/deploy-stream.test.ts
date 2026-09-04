// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, type TestContext } from 'node:test';
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
  SIGNAL_COALESCE_MS,
  type OutputSink,
  type SignalRegistry,
} from './deploy-stream.js';
import { isUpdatableStackStatus, shouldRevertDrift } from './deploy.js';

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

/** How many relayed lines mention `needle` — one signal must log one line. */
function countLines(text: string, needle: string): number {
  return text.split('\n').filter((line) => line.includes(needle)).length;
}

/** Read an env switch without treating `''`, `'0'` or `'false'` as "on". */
function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

// ── signal policy ───────────────────────────────────────────────────────────
// The "decouple the CLI lifecycle from the in-flight deploy" rule, asserted
// directly: which signals abandon a converging CloudFormation deploy and which
// only warn.
describe('decideSignalResponse — a converging deploy is not abandoned by one signal', () => {
  it('defers the first SIGTERM and explains how to force an abort', () => {
    const { action, message } = decideSignalResponse('SIGTERM', null);
    assert.strictEqual(action, 'defer');
    assert.match(message, /Ignoring SIGTERM/);
    assert.match(message, /send SIGTERM again to abort/i);
  });

  // One `kill -TERM -<pgid>` reaches this process twice under `npm run deploy`:
  // the group delivers it, then tsx relays it to its child ~50ms later (measured
  // on a real deploy). Reading that second delivery as "the operator insisted"
  // aborted deploys that nobody asked to stop.
  it('coalesces a duplicate delivery of the same SIGTERM instead of aborting', () => {
    const { action, coalesced } = decideSignalResponse('SIGTERM', 50);
    assert.strictEqual(action, 'defer');
    assert.strictEqual(coalesced, true);
  });

  it('still coalesces at the edge of the window and aborts past it', () => {
    assert.strictEqual(decideSignalResponse('SIGTERM', SIGNAL_COALESCE_MS - 1).action, 'defer');
    assert.strictEqual(decideSignalResponse('SIGTERM', SIGNAL_COALESCE_MS).action, 'abort');
  });

  it('aborts on a deliberate second SIGTERM so an operator is never stuck', () => {
    const { action, message } = decideSignalResponse('SIGTERM', 5_000);
    assert.strictEqual(action, 'abort');
    assert.match(message, /SIGTERM/);
  });

  it('always defers SIGHUP — a closed terminal must not kill a backgrounded deploy', () => {
    assert.strictEqual(decideSignalResponse('SIGHUP', null).action, 'defer');
    assert.strictEqual(decideSignalResponse('SIGHUP', 60_000).action, 'defer');
  });

  it('aborts on the first SIGINT — Ctrl-C is unambiguous intent', () => {
    const { action, message } = decideSignalResponse('SIGINT', null);
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
  const args = buildCdkDeployArgs({ projectRoot: '/app', outputsFile: '.blocks-sandbox/outputs.json', revertDrift: true });

  it('sends CDK logs to stdout instead of stderr', () => {
    assert.ok(args.includes('--ci'), `expected --ci in: ${args.join(' ')}`);
  });

  it('asks for per-event progress rather than the TTY progress bar', () => {
    assert.strictEqual(args[args.indexOf('--progress') + 1], 'events');
  });

  it('reconciles hotswap/dev-loop drift on an UPDATE deploy (revertDrift: true)', () => {
    assert.ok(args.includes('--revert-drift'), `expected --revert-drift in: ${args.join(' ')}`);
  });

  it('omits --revert-drift on a first/CREATE deploy (revertDrift: false)', () => {
    // REVERT_DRIFT is a CloudFormation deployment mode valid only on UPDATE
    // change sets; CFN rejects it on CREATE. So a fresh deploy must not carry it.
    const createArgs = buildCdkDeployArgs({ projectRoot: '/app', outputsFile: '.blocks-sandbox/outputs.json', revertDrift: false });
    assert.ok(!createArgs.includes('--revert-drift'), `first/CREATE deploy must not use --revert-drift: ${createArgs.join(' ')}`);
    // Gating the drift flag must not disturb the observability contract.
    assert.ok(createArgs.includes('--ci'), `expected --ci in: ${createArgs.join(' ')}`);
    assert.strictEqual(createArgs[createArgs.indexOf('--progress') + 1], 'events');
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
    // Past the coalescing window, so this reads as a deliberate second request
    // rather than a duplicate delivery of the first.
    await new Promise((r) => setTimeout(r, SIGNAL_COALESCE_MS + 250));
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

  // The shape that broke a real deploy: `npm run deploy` is npm -> sh -> tsx ->
  // node, so one `kill -TERM -<pgid>` lands on this process twice (group
  // delivery, then tsx's relay). Both deliveries must count as one request.
  it('survives a duplicate SIGTERM delivery and logs the deferral once', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-stream-'));
    try {
      const marker = join(dir, 'child-finished');
      const script = join(dir, 'dup.mjs');
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
        'child should be mid-run before the signals',
      );
      signals.emit('SIGTERM');
      await new Promise((r) => setTimeout(r, 50)); // tsx relays about this fast
      signals.emit('SIGTERM');

      await run; // resolves ⇒ the duplicate delivery did not abandon the deploy
      const deferrals = countLines(stdout.text(), 'Ignoring SIGTERM');
      assert.strictEqual(deferrals, 1, `expected one deferral line, got ${deferrals}`);
      assert.doesNotMatch(stdout.text(), /Received SIGTERM while deploying/);
      assert.ok(existsSync(marker), 'the deploy must have run to completion');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A hangup is delivered twice for the same reason a SIGTERM is (the group hangs
  // up, then a wrapper relays it), and it used to print the deferral line once per
  // delivery. One hangup is one line; a later hangup is a new event and reports
  // again rather than being muted for the rest of a multi-minute deploy.
  it('logs one line for a duplicated SIGHUP and reports a later one again', { timeout: 30_000 }, async () => {
    const stdout = collectingSink();
    const signals = new EventEmitter();
    const run = runStreaming(
      process.execPath,
      ['-e', `console.log('working'); setTimeout(() => {}, ${SIGNAL_COALESCE_MS * 2 + 2_000});`],
      { stdout, stderr: collectingSink(), heartbeatMs: 0, signalTarget: signals as unknown as SignalRegistry },
    );

    assert.ok(await waitFor(() => stdout.text().includes('working'), 15_000), 'child should be running');
    signals.emit('SIGHUP');
    await new Promise((r) => setTimeout(r, 50)); // a relay arrives about this fast
    signals.emit('SIGHUP');
    assert.ok(await waitFor(() => stdout.text().includes('Ignoring SIGHUP'), 5_000), 'the hangup is deferred');
    assert.strictEqual(
      countLines(stdout.text(), 'Ignoring SIGHUP'),
      1,
      `one hangup must log one line, got: ${JSON.stringify(stdout.text())}`,
    );

    await new Promise((r) => setTimeout(r, SIGNAL_COALESCE_MS + 250));
    signals.emit('SIGHUP'); // outside the window ⇒ a genuinely new hangup
    assert.ok(
      await waitFor(() => countLines(stdout.text(), 'Ignoring SIGHUP') === 2, 5_000),
      `a later hangup must be reported too, got: ${JSON.stringify(stdout.text())}`,
    );

    await run; // resolves ⇒ no number of hangups abandons the deploy
  });

  // Each signal gets its own deferral window. A SIGHUP used to share the SIGTERM's
  // window, so a hangup landing just after a deferred SIGTERM was swallowed with
  // no line at all — and the operator lost the one hint that it had been ignored.
  it('reports a SIGHUP that lands right after a deferred SIGTERM, and still defers', { timeout: 30_000 }, async () => {
    const stdout = collectingSink();
    const signals = new EventEmitter();
    const run = runStreaming(process.execPath, ['-e', "console.log('working'); setTimeout(() => {}, 2500);"], {
      stdout,
      stderr: collectingSink(),
      heartbeatMs: 0,
      signalTarget: signals as unknown as SignalRegistry,
    });

    assert.ok(await waitFor(() => stdout.text().includes('working'), 15_000), 'child should be running');
    signals.emit('SIGTERM');
    assert.ok(await waitFor(() => stdout.text().includes('Ignoring SIGTERM'), 5_000), 'first SIGTERM is deferred');
    signals.emit('SIGHUP');
    assert.ok(
      await waitFor(() => stdout.text().includes('Ignoring SIGHUP'), 5_000),
      'the SIGHUP must be reported, not swallowed by the SIGTERM window',
    );

    await run; // resolves ⇒ neither signal abandoned the deploy
    assert.doesNotMatch(stdout.text(), /Received SIG(TERM|HUP) while deploying/);
  });

  // The stream contract from the failure side: progress goes to stdout, but the
  // reason a deploy failed stays on stderr (the CDK CLI keeps error level there
  // even under `--ci`) and the runner never merges the two.
  it('keeps a deploy failure reason on stderr while progress stays on stdout', { timeout: 30_000 }, async () => {
    const reason =
      'ProbeStack | CREATE_FAILED | AWS::S3::Bucket | Assets Resource handler returned message: "bucket already exists" (HandlerErrorCode: AlreadyExists)';
    const stdout = collectingSink();
    const stderr = collectingSink();

    await assert.rejects(
      () =>
        runStreaming(
          process.execPath,
          [
            '-e',
            "console.log('ProbeStack | CREATE_IN_PROGRESS | AWS::S3::Bucket | Assets');" +
              `console.error(${JSON.stringify(reason)});` +
              'process.exit(1);',
          ],
          { stdout, stderr, heartbeatMs: 0, signalTarget: new EventEmitter() as unknown as SignalRegistry },
        ),
      (error: unknown) => {
        assert.ok(error instanceof DeployProcessError);
        assert.strictEqual(error.exitCode, 1);
        assert.strictEqual(error.aborted, false);
        return true;
      },
    );

    assert.match(stderr.text(), /Resource handler returned message/, 'the failure reason belongs on stderr');
    assert.doesNotMatch(stdout.text(), /Resource handler returned message/, 'and must not be duplicated onto stdout');
    assert.match(stdout.text(), /CREATE_IN_PROGRESS/, 'progress still streams to stdout');
  });
});

// ── the root cause, verified against the real CDK CLI ───────────────────────
// `buildCdkDeployArgs` passing `--ci` is load-bearing, so the routing is checked
// against the actual CLI rather than trusted: a `cdk deploy` writes NOTHING to
// stdout by default (every line goes to stderr) and writes to stdout once CI mode
// is on, while the reason a deploy failed stays on stderr either way.
//
// The probe is hermetic. It deploys a pre-synthesized assembly pinned to the
// all-zeros account with every CI marker and credential source stripped from the
// child's environment, so the CLI stops at the same credential check on every
// machine: no credentials, no network calls, no mutation, the same two streams
// every run.
//
// Being hermetic is what lets it be mandatory, and mandatory is the point: a
// probe that quietly skips reads as "covered" while asserting nothing. So there
// is no environmental skip left. It fails when the CDK CLI cannot be resolved
// while the probe is required, fails (never skips) when the CLI stops anywhere
// other than the credential check, and prints CDK_ROUTING_PROBE_EXECUTED — which
// the last test in this block asserts, and which pr-checks.yml re-checks through
// BLOCKS_CDK_PROBE_MARKER so a probe that stops running fails the build.
describe('the real CDK CLI: --ci moves logs to stdout and keeps failures on stderr', () => {
  const cdkBin = (() => {
    try {
      return createRequire(import.meta.url).resolve('aws-cdk/bin/cdk');
    } catch {
      return undefined;
    }
  })();

  /** Printed on stdout (and written to `BLOCKS_CDK_PROBE_MARKER`) once the probe ran. */
  const PROBE_MARKER = 'CDK_ROUTING_PROBE_EXECUTED';

  // CI must run this probe, so a CDK CLI it cannot resolve is a failure there,
  // not a skip. `BLOCKS_SKIP_CDK_PROBE=1` is the one explicit, greppable way to
  // opt a runner out on purpose.
  const probeRequired =
    (envFlag(process.env.CI) || envFlag(process.env.BLOCKS_REQUIRE_CDK_PROBE)) &&
    !envFlag(process.env.BLOCKS_SKIP_CDK_PROBE);

  // The line the CLI stops on: the hermetic environment has no credentials for
  // the all-zeros account, so every probe run reaches exactly this.
  const FAILURE_REASON =
    /Need to perform AWS calls for account 000000000000, but no credentials have been configured/;

  // CI markers (the CDK CLI derives its CI default from them) plus every
  // credential source, so neither the flag under test nor the stop point can be
  // decided by the environment this suite happens to run in.
  const STRIPPED_ENV = [
    'CI',
    'GITHUB_ACTIONS',
    'CONTINUOUS_INTEGRATION',
    'BUILD_NUMBER',
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_ROLE_ARN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  ];

  interface ProbeRun {
    stdout: string;
    stderr: string;
    status: number | null;
  }

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

  /**
   * argv for one probe deploy. The flag under test *replaces* the `--ci` that
   * {@link buildCdkDeployArgs} already adds instead of being appended after it,
   * so a probe never argues with itself over two conflicting CI flags.
   */
  function probeArgv(assembly: string, ciFlag: '--ci' | '--no-ci'): string[] {
    const deployArgs = buildCdkDeployArgs({
      projectRoot: assembly,
      outputsFile: join(assembly, 'outputs.json'),
      // Exercise the UPDATE-deploy argv so the probe still carries --revert-drift
      // and proves the pinned CLI parses it.
      revertDrift: true,
    })
      .slice(1) // drop the leading `cdk`: the CLI entry point is invoked directly
      .filter((arg) => arg !== '--ci');
    return [...deployArgs, ciFlag, 'ProbeStack', '--app', assembly];
  }

  function probeDeploy(assembly: string, ciFlag: '--ci' | '--no-ci'): ProbeRun {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AWS_EC2_METADATA_DISABLED: 'true',
      // Point the shared config/credentials files at paths that do not exist so a
      // developer's ~/.aws profile cannot carry the probe past the credential check.
      AWS_SHARED_CREDENTIALS_FILE: join(assembly, 'no-credentials'),
      AWS_CONFIG_FILE: join(assembly, 'no-config'),
    };
    for (const key of STRIPPED_ENV) delete env[key];
    const result = spawnSync(process.execPath, [cdkBin as string, ...probeArgv(assembly, ciFlag)], {
      encoding: 'utf-8',
      env,
      timeout: 120_000,
    });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
  }

  function cdkVersion(): string {
    try {
      const manifest = createRequire(import.meta.url).resolve('aws-cdk/package.json');
      return JSON.parse(readFileSync(manifest, 'utf-8')).version;
    } catch {
      return 'unknown';
    }
  }

  let probes: { withCi: ProbeRun; withoutCi: ProbeRun } | undefined;
  let executionMarker: string | undefined;

  /**
   * Run both probe deploys once (they only read the CLI's behaviour) and prove
   * they got where they were meant to. Returns `undefined` only when there is no
   * CDK CLI to probe *and* the probe is not required — the single skip left.
   */
  function probeOnce(t: TestContext): { withCi: ProbeRun; withoutCi: ProbeRun } | undefined {
    if (!cdkBin) {
      assert.ok(
        !probeRequired,
        'the real-CDK stream-routing probe is required here but aws-cdk could not be resolved — run `npm ci` at the repo root, or set BLOCKS_SKIP_CDK_PROBE=1 to opt this runner out on purpose',
      );
      t.skip('aws-cdk CLI is not installed in this workspace');
      return undefined;
    }
    if (!probes) {
      const assembly = writeProbeAssembly();
      try {
        probes = { withCi: probeDeploy(assembly, '--ci'), withoutCi: probeDeploy(assembly, '--no-ci') };
      } finally {
        rmSync(assembly, { recursive: true, force: true });
      }
    }
    // Stopping anywhere other than the credential check means the CLI changed or
    // the environment leaked credentials, and either invalidates the probe. This
    // used to skip, which is exactly how a probe rots into a no-op.
    for (const [flag, run] of [
      ['--ci', probes.withCi],
      ['--no-ci', probes.withoutCi],
    ] as const) {
      assert.match(
        run.stderr,
        FAILURE_REASON,
        `the ${flag} probe never reached the credential check (exit ${run.status}). stdout: ${JSON.stringify(run.stdout.slice(0, 400))} stderr: ${JSON.stringify(run.stderr.slice(0, 400))}`,
      );
    }
    if (!executionMarker) {
      executionMarker =
        `${PROBE_MARKER} aws-cdk@${cdkVersion()} ` +
        `--ci{stdout:${probes.withCi.stdout.length}B,stderr:${probes.withCi.stderr.length}B} ` +
        `--no-ci{stdout:${probes.withoutCi.stdout.length}B,stderr:${probes.withoutCi.stderr.length}B}`;
      console.log(executionMarker);
      const markerFile = process.env.BLOCKS_CDK_PROBE_MARKER;
      if (markerFile) writeFileSync(markerFile, `${executionMarker}\n`);
    }
    return probes;
  }

  it('sends every deploy log line to stderr by default, and to stdout with --ci', { timeout: 180_000 }, (t) => {
    const probe = probeOnce(t);
    if (!probe) return;
    assert.strictEqual(
      probe.withoutCi.stdout,
      '',
      'the CDK default routes every log line to stderr — this is the 0-byte stdout in issue #222',
    );
    assert.notStrictEqual(probe.withoutCi.stderr, '', 'the log output still exists, just on the wrong stream');
    assert.notStrictEqual(
      probe.withCi.stdout,
      '',
      '--ci must move the deploy log (CloudFormation progress included) onto stdout',
    );
  });

  // The other half of the stream contract this fix tightens: moving progress onto
  // stdout must not drag the failure reason along with it. The CDK io host routes
  // error level to stderr whatever CI mode says, so a caller grepping stderr for
  // why a deploy failed still finds it there under `--ci`.
  it('keeps a genuine deploy failure reason on stderr under --ci', { timeout: 180_000 }, (t) => {
    const probe = probeOnce(t);
    if (!probe) return;
    assert.notStrictEqual(probe.withCi.status, 0, 'the probe deploy must really have failed');
    assert.match(probe.withCi.stderr, FAILURE_REASON, 'the failure reason must stay on stderr under --ci');
    assert.doesNotMatch(
      probe.withCi.stdout,
      FAILURE_REASON,
      '--ci must not move the failure reason onto stdout — stderr stays the place to grep for it',
    );
    // Same failure under the default routing: stderr carries the reason *and* the
    // progress that `--ci` lifts onto stdout.
    assert.match(probe.withoutCi.stderr, FAILURE_REASON);
  });

  it('probes with exactly one CI flag on the argv', () => {
    for (const flag of ['--ci', '--no-ci'] as const) {
      const argv = probeArgv('/probe-assembly', flag);
      assert.deepStrictEqual(
        argv.filter((arg) => arg === '--ci' || arg === '--no-ci'),
        [flag],
        `the probe argv must carry only the flag under test: ${argv.join(' ')}`,
      );
    }
  });

  // ── the flag this change adds ──────────────────────────────────────────────
  // `--revert-drift` is why this module was touched, and the cheap unit test above
  // (`args.includes('--revert-drift')`) only proves the argv *carries* the flag —
  // an unknown option would sail past `includes` and only fail at deploy time.
  // `probeArgv` is built from the production `buildCdkDeployArgs`, so `--revert-drift`
  // already rides on every probe run: reaching FAILURE_REASON therefore means the
  // pinned CLI parsed the whole argv, the flag included, and stopped at the
  // credential check rather than rejecting an option. This sibling makes that
  // guarantee explicit and adds the negative — the run must NOT have been rejected
  // as an unknown option/argument, which is exactly how an older CLI without
  // `--revert-drift` (below the pinned `^2.1138.0` floor) would fail.
  it('the pinned CDK CLI accepts --revert-drift (parsed, not just present in argv)', { timeout: 180_000 }, (t) => {
    const probe = probeOnce(t);
    if (!probe) return;
    assert.ok(
      probeArgv('/probe-assembly', '--ci').includes('--revert-drift'),
      'the probe must exercise the production argv, which carries --revert-drift',
    );
    // argv carries the flag + run reaches the credential check + no unknown-option error ⇒ the pinned CLI accepted --revert-drift.
    for (const [flag, run] of [
      ['--ci', probe.withCi],
      ['--no-ci', probe.withoutCi],
    ] as const) {
      // Reaching the credential check proves the CLI parsed the whole argv,
      // `--revert-drift` included, without rejecting an option.
      assert.match(
        run.stderr,
        FAILURE_REASON,
        `the ${flag} probe (carrying --revert-drift) never reached the credential check (exit ${run.status}). stderr: ${JSON.stringify(run.stderr.slice(0, 400))}`,
      );
      // The negative the presence test cannot make: an older/other CLI that did
      // not know `--revert-drift` would have died here instead of at credentials.
      assert.doesNotMatch(
        run.stderr,
        /Unknown (option|argument)|Unrecognized/i,
        `the pinned CDK CLI rejected an option on the ${flag} probe — --revert-drift is unavailable on this CLI. stderr: ${JSON.stringify(run.stderr.slice(0, 400))}`,
      );
    }
  });

  // Guards the guard. If the probe ever stops executing — a dropped dependency, a
  // reordered CI step, an early return sneaking back in — this fails instead of
  // the suite quietly shrinking to nothing.
  it('leaves a greppable marker proving the probe executed', (t) => {
    if (!cdkBin && !probeRequired) return t.skip('aws-cdk CLI is not installed in this workspace');
    assert.ok(
      executionMarker?.startsWith(PROBE_MARKER),
      `the real-CDK stream-routing probe did not run: expected a ${PROBE_MARKER} line on stdout`,
    );
  });
});

// ── revert-drift gating: which stack statuses are an UPDATE ─────────────────
// The finding this revision fixes: `--revert-drift` is valid only on an UPDATE
// change set, but several statuses resolve in DescribeStacks yet still deploy as
// CREATE (REVIEW_IN_PROGRESS = never executed; ROLLBACK_COMPLETE = failed create,
// must be recreated; DELETE_* = gone/going). `isUpdatableStackStatus` must reject
// exactly those and accept every genuinely-created, deployable state.
describe('isUpdatableStackStatus — only an UPDATE-bound status enables --revert-drift', () => {
  it('rejects statuses whose next deploy is really a CREATE', () => {
    // No stack row at all → definitely a CREATE.
    assert.strictEqual(isUpdatableStackStatus(undefined), false);
    // Change set created but never executed → never successfully created.
    assert.strictEqual(isUpdatableStackStatus('REVIEW_IN_PROGRESS'), false);
    // Failed initial create → CFN requires delete-then-recreate.
    assert.strictEqual(isUpdatableStackStatus('ROLLBACK_COMPLETE'), false);
    // A ROLLBACK_FAILED initial create is likewise a failed creation CDK
    // deletes-and-recreates → next deploy is a CREATE, so not updatable.
    assert.strictEqual(isUpdatableStackStatus('ROLLBACK_FAILED'), false);
    // Gone or going → not deployable as an UPDATE.
    assert.strictEqual(isUpdatableStackStatus('DELETE_IN_PROGRESS'), false);
    assert.strictEqual(isUpdatableStackStatus('DELETE_COMPLETE'), false);
  });

  it('accepts genuinely-created, deployable states', () => {
    assert.strictEqual(isUpdatableStackStatus('CREATE_COMPLETE'), true);
    assert.strictEqual(isUpdatableStackStatus('UPDATE_COMPLETE'), true);
    assert.strictEqual(isUpdatableStackStatus('UPDATE_ROLLBACK_COMPLETE'), true);
    // UPDATE_ROLLBACK_* are UPDATE-type failures, not a failed CREATE — the
    // broadened startsWith('ROLLBACK_') exclusion must NOT catch them.
    assert.strictEqual(isUpdatableStackStatus('UPDATE_ROLLBACK_FAILED'), true);
    assert.strictEqual(isUpdatableStackStatus('IMPORT_COMPLETE'), true);
  });
});

// ── revert-drift gating is fail-safe against stack-NAME resolution too ──────
// The regression from PR #489: gating --revert-drift meant the production path
// began resolving the stack name via getStackName(), which THROWS when the
// committed .blocks/config.json has no stackId (e.g. a telemetry-only test-app
// config). That throw is at the call site — OUTSIDE productionStackIsUpdatable's
// try/catch, which only wraps DescribeStacks — so it killed the whole prod
// deploy before any `cdk deploy` ran. shouldRevertDrift wraps the name
// resolution too, so ANY gate error (name resolution included) yields false and
// the deploy proceeds. The injectable resolver is the cast-free unit seam: a
// throwing resolver exercises exactly that branch without touching AWS.
describe('shouldRevertDrift — a stack-name resolution throw is non-fatal', () => {
  it('returns false (never rejects) when the stack-name resolver throws', async () => {
    let called = false;
    const throwingResolver = (): string => {
      called = true;
      throw new Error('.blocks/config.json not found or missing stackId — telemetry-only config');
    };
    // Must resolve to false, not reject: a throw here previously aborted the deploy.
    const result = await shouldRevertDrift('/some/project/root', throwingResolver);
    assert.strictEqual(result, false, 'a throwing stack-name resolver must yield revertDrift=false, not a rejection');
    assert.ok(called, 'the injected resolver must have been the throw source (no real AWS/getStackName call)');
    // Note: the success branch (resolver returns a name) deliberately hits
    // DescribeStacks and is left to integration coverage — this unit test proves
    // only the throw→false branch and never touches AWS/network.
  });
});

interface FakeDeployOptions {
  /** How many CloudFormation-shaped event lines the fake cdk prints. */
  ticks: number;
  /** Gap between those lines, so a test can keep the deploy mid-flight. */
  tickMs: number;
  /**
   * When set, the fake cdk fails after its last tick instead of completing: it
   * prints this reason on *stderr* — where the real CDK CLI keeps error level,
   * `--ci` or not — and exits 1.
   */
  failWith?: string;
}

/**
 * Write a fake CDK CLI plus the deploy wrapper that runs it through
 * {@link runStreaming}.
 *
 * The wrapper mirrors the entrypoint the templates generate
 * (`deploy(...).catch((error) => { console.error(error); process.exit(1); })`):
 * the ❌ verdict goes to stdout so a stdout-only capture can tell a failed deploy
 * from a killed process, and the error itself goes to stderr.
 */
function scaffoldFakeDeploy({ ticks, tickMs, failWith }: FakeDeployOptions): { dir: string; wrapper: string } {
  const dir = mkdtempSync(join(tmpdir(), 'blocks-deploy-'));
  const moduleUrl = new URL('./deploy-stream.js', import.meta.url).href;
  const lastTick = failWith
    ? `    console.error(${JSON.stringify(failWith)});\n` + `    process.exit(1);\n`
    : `    writeFileSync(dir + '/cfn-done', 'ok');\n` +
      `    console.log('ProbeStack | CREATE_COMPLETE | AWS::CloudFormation::Stack | ProbeStack');\n` +
      `    return;\n`;
  writeFileSync(
    join(dir, 'fake-cdk.mjs'),
    `import { writeFileSync } from 'node:fs';\n` +
      `const dir = process.argv[2];\n` +
      `writeFileSync(dir + '/cdk.pid', String(process.pid));\n` +
      `let n = 0;\n` +
      `const tick = () => {\n` +
      `  n += 1;\n` +
      `  console.log('ProbeStack | ' + n + '/${ticks} | CREATE_IN_PROGRESS | AWS::Lambda::Function | Handler' + n);\n` +
      `  if (n >= ${ticks}) {\n` +
      lastTick +
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
      `  console.log('\\n❌ Deployment failed.');\n` +
      `  console.error(error);\n` +
      `  writeFileSync(dir + '/wrapper-status', error && error.aborted ? 'aborted' : 'failed');\n` +
      `  process.exitCode = 1;\n` +
      `}\n`,
  );
  return { dir, wrapper };
}

// ── a failed deploy keeps its reason on stderr ──────────────────────────────
// The exact contract this fix tightens, end to end and platform-independent:
// moving CloudFormation progress onto stdout must not move the *reason* a deploy
// failed with it. The reason (and the error object) stay on stderr; only the
// human-facing ❌ verdict is on stdout, which is a deliberate change — grepping
// stderr for "Deployment failed" no longer finds it, grepping for the reason
// still does.
describe('a failed deploy reports its reason on stderr and its verdict on stdout', () => {
  it('splits the CDK failure reason (stderr) from the ❌ verdict (stdout)', { timeout: 60_000 }, async () => {
    const { dir, wrapper } = scaffoldFakeDeploy({
      ticks: 3,
      tickMs: 40,
      failWith:
        'ProbeStack | CREATE_FAILED | AWS::S3::Bucket | Assets Resource handler returned message: "bucket already exists" (HandlerErrorCode: AlreadyExists)',
    });
    // No `detached` here: this asserts the stream contract, not signal handling,
    // so it runs on every platform including Windows.
    const child = spawn(process.execPath, [wrapper, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.stderr.on('data', (chunk: string) => { err += chunk; });

    try {
      // 'close' (not 'exit') so both pipes are fully drained before asserting.
      const code = await new Promise<number | null>((resolve) => child.once('close', resolve));

      assert.strictEqual(code, 1, `a failed deploy must exit non-zero; stdout: ${out}\nstderr: ${err}`);
      assert.match(err, /Resource handler returned message/, 'the failure reason must land on stderr');
      assert.doesNotMatch(out, /Resource handler returned message/, 'the failure reason must not move to stdout');
      assert.match(err, /DeployProcessError/, "the entrypoint's console.error(error) puts the error on stderr");
      assert.match(out, /❌ Deployment failed\./, 'the verdict is on stdout so a stdout-only capture sees it');
      assert.doesNotMatch(err, /❌ Deployment failed\./, 'the verdict is no longer on stderr (see the changeset)');
      assert.match(out, /CREATE_IN_PROGRESS/, 'progress still streams to stdout');
      assert.strictEqual(readFileSync(join(dir, 'wrapper-status'), 'utf-8'), 'failed');
      assert.ok(!existsSync(join(dir, 'cfn-done')), 'the failing deploy must not report completion');
    } finally {
      if (child.pid) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
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
//
// Process groups and OS-delivered SIGTERM/SIGHUP are POSIX-only, which is why
// this whole block is — and why the signal resilience is documented as POSIX-only
// rather than universal.
describe('a backgrounded deploy survives the group SIGTERM that killed it before', { skip: posixOnly }, () => {

  // The mechanism behind every case below, asserted directly: on POSIX the CDK
  // CLI is spawned into its own process group, which is what stops a reap aimed
  // at the parent shell from reaching it. Windows has no equivalent.
  it('spawns the CDK CLI into its own process group', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-pgid-'));
    try {
      const pidFile = join(dir, 'child.pid');
      const gate = join(dir, 'may-exit');
      const script = join(dir, 'report-pid.mjs');
      writeFileSync(
        script,
        `import { existsSync, writeFileSync } from 'node:fs';\n` +
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
          `const wait = () => existsSync(${JSON.stringify(gate)}) ? process.exit(0) : setTimeout(wait, 25);\n` +
          `wait();\n`,
      );

      const run = runStreaming(process.execPath, [script], {
        stdout: collectingSink(),
        stderr: collectingSink(),
        heartbeatMs: 0,
        signalTarget: new EventEmitter() as unknown as SignalRegistry,
      });

      assert.ok(await waitFor(() => existsSync(pidFile), 15_000), 'child should report its pid');
      const childPid = Number(readFileSync(pidFile, 'utf-8'));
      // A process group whose id is the child's pid exists only if the child
      // leads it — i.e. it was spawned detached, not into this process's group,
      // so a signal sent to our group cannot reach it.
      assert.doesNotThrow(
        () => process.kill(-childPid, 0),
        `the child must lead its own process group (pid ${childPid})`,
      );

      writeFileSync(gate, 'go');
      await run;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps streaming and finishes the deploy after one group SIGTERM', { timeout: 60_000 }, async () => {
    const { dir, wrapper } = scaffoldFakeDeploy({ ticks: 12, tickMs: 80 });
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
    // 200 ticks: long enough that the deploy is still mid-flight when signalled.
    const { dir, wrapper } = scaffoldFakeDeploy({ ticks: 200, tickMs: 80 });
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
      // Wait out the coalescing window so this is read as a deliberate repeat
      // rather than a duplicate delivery of the first signal.
      await new Promise((r) => setTimeout(r, SIGNAL_COALESCE_MS + 250));
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

  // The real-world delivery shape, with real OS signals: `npm run deploy` puts
  // npm, sh and tsx in the group alongside the deploy CLI, and tsx relays the
  // SIGTERM it receives to its child, so the CLI is signalled twice in quick
  // succession. Two group SIGTERMs ~50ms apart reproduce that, and the deploy
  // must still finish (a real deploy against AWS aborted here before the
  // coalescing window existed).
  it('finishes the deploy when one reap delivers SIGTERM twice in quick succession', { timeout: 60_000 }, async () => {
    const { dir, wrapper } = scaffoldFakeDeploy({ ticks: 14, tickMs: 80 });
    const child = spawn(process.execPath, [wrapper, dir], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });

    try {
      assert.ok(await waitFor(() => out.includes('CREATE_IN_PROGRESS'), 20_000), 'deploy should be streaming');
      assert.ok(child.pid, 'wrapper pid');

      process.kill(-child.pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 50));
      process.kill(-child.pid, 'SIGTERM'); // the wrapper relay, not a second request

      assert.ok(
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000),
        'the wrapper should finish on its own',
      );
      assert.doesNotMatch(out, /Received SIGTERM while deploying/, 'a duplicate delivery must not abort');
      assert.ok(existsSync(join(dir, 'cfn-done')), 'the deploy itself must have run to completion');
      assert.strictEqual(child.exitCode, 0, `wrapper should exit 0; stdout: ${out}`);
      assert.strictEqual(readFileSync(join(dir, 'wrapper-status'), 'utf-8'), 'complete');
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
    const { dir } = scaffoldFakeDeploy({ ticks: 200, tickMs: 80 });
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
