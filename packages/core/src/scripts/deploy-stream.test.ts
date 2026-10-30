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
  parseCdkEventLine,
  describeConvergingResource,
  createResourceTracker,
  extractHostingUrlFromLine,
  createDenialMonitor,
  formatDenialNotice,
  type CdkOutputStream,
  type DenialMonitor,
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
  const args = buildCdkDeployArgs({ projectRoot: '/app', outputsFile: '.blocks-sandbox/outputs.json' });

  it('sends CDK logs to stdout instead of stderr', () => {
    assert.ok(args.includes('--ci'), `expected --ci in: ${args.join(' ')}`);
  });

  it('asks for per-event progress rather than the TTY progress bar', () => {
    assert.strictEqual(args[args.indexOf('--progress') + 1], 'events');
  });

  it('selects every stack so multi-stack apps deploy without a stack-selector error', () => {
    assert.ok(args.includes('--all'), `expected --all in: ${args.join(' ')}`);
  });

  it('keeps the sandbox-only speedups out of the production deploy', () => {
    // A production deploy must keep a reviewable change set and full
    // stabilization with rollback: the sandbox speedups must never appear here,
    // even if someone later "aligns" the two arg builders.
    assert.ok(!args.includes('--method'), `production deploy must not use --method: ${args.join(' ')}`);
    assert.ok(!args.includes('--express'), `production deploy must not use --express: ${args.join(' ')}`);
    assert.ok(!args.includes('--hotswap'), `production deploy must not use --hotswap: ${args.join(' ')}`);
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

  // The pure helpers (parseCdkEventLine / describeConvergingResource /
  // extractHostingUrlFromLine) are unit-tested above, but their WIRING inside
  // runStreaming — onHostingUrl firing at most once and the idle heartbeat
  // naming the converging resource — was previously only exercised by hand.
  // This drives a real child that emits CDK-event-shaped lines then idles, and
  // asserts both behaviours end to end.
  it('fires onHostingUrl once and names the converging resource in the heartbeat', { timeout: 30_000 }, async () => {
    const stdout = collectingSink();
    const hostingUrls: string[] = [];
    // The child prints a hosting-URL Outputs line and an IN_PROGRESS event for a
    // resource that never COMPLETEs, then goes silent long enough for the
    // heartbeat to fire while that resource is still "current".
    const script = [
      `console.log('Probe.HostingDistributionUrl = https://d123.cloudfront.net');`,
      `console.log('Probe | CREATE_IN_PROGRESS | AWS::CloudFront::Distribution | HostingDistribution');`,
      `setTimeout(() => {}, 900);`,
    ].join('\n');
    await runStreaming(process.execPath, ['-e', script], {
      stdout,
      stderr: collectingSink(),
      heartbeatMs: 150,
      onHostingUrl: (url) => hostingUrls.push(url),
      signalTarget: new EventEmitter() as unknown as SignalRegistry,
    });

    // (a) onHostingUrl fired exactly once, with the URL.
    assert.deepStrictEqual(hostingUrls, ['https://d123.cloudfront.net']);
    // (b) the heartbeat named the converging resource rather than a bare tick.
    assert.match(stdout.text(), /waiting on HostingDistribution \(AWS::CloudFront::Distribution\)/);
  });

  // A second hosting-URL line must NOT re-fire the one-shot callback.
  it('does not re-fire onHostingUrl when the URL appears again in the stream', { timeout: 30_000 }, async () => {
    const hostingUrls: string[] = [];
    const script = [
      `console.log('Probe.HostingDistributionUrl = https://d123.cloudfront.net');`,
      `console.log('Probe.HostingDistributionUrl = https://d123.cloudfront.net');`,
    ].join('\n');
    await runStreaming(process.execPath, ['-e', script], {
      stdout: collectingSink(),
      stderr: collectingSink(),
      heartbeatMs: 0,
      onHostingUrl: (url) => hostingUrls.push(url),
      signalTarget: new EventEmitter() as unknown as SignalRegistry,
    });
    assert.deepStrictEqual(hostingUrls, ['https://d123.cloudfront.net'], 'the URL is reported at most once');
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
   * so a probe never argues with itself over two conflicting CI flags. `--all`
   * is likewise dropped: the probe selects its own single stack (`ProbeStack`)
   * explicitly, and the CDK CLI rejects `--all` together with a named stack.
   */
  function probeArgv(assembly: string, ciFlag: '--ci' | '--no-ci'): string[] {
    const deployArgs = buildCdkDeployArgs({
      projectRoot: assembly,
      outputsFile: join(assembly, 'outputs.json'),
    })
      .slice(1) // drop the leading `cdk`: the CLI entry point is invoked directly
      .filter((arg) => arg !== '--ci' && arg !== '--all');
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

// ── Converging-resource attribution (Part A: name what the deploy waits on) ──
// The heartbeat used to print a bare "CloudFormation is converging"; these cover
// the pure pieces that let it say WHICH resource instead.

describe('parseCdkEventLine — reads a `cdk deploy --progress events` line', () => {
  it('parses the STATUS | TYPE | LOGICALID triple from a padded CDK line', (t: TestContext) => {
    const event = parseCdkEventLine(
      'ProbeStack | CREATE_IN_PROGRESS | AWS::CloudFront::Distribution | HostingDistribution',
    );
    t.assert.deepStrictEqual(event, {
      status: 'CREATE_IN_PROGRESS',
      resourceType: 'AWS::CloudFront::Distribution',
      logicalId: 'HostingDistribution',
    });
  });

  it('parses a COMPLETE transition too', (t: TestContext) => {
    const event = parseCdkEventLine('Foo | CREATE_COMPLETE | AWS::Lambda::Function | Handler');
    t.assert.strictEqual(event?.status, 'CREATE_COMPLETE');
    t.assert.strictEqual(event?.logicalId, 'Handler');
  });

  it('parses UPDATE_*, DELETE_* and ROLLBACK statuses', (t: TestContext) => {
    t.assert.strictEqual(
      parseCdkEventLine('S | UPDATE_IN_PROGRESS | AWS::DynamoDB::Table | T')?.status,
      'UPDATE_IN_PROGRESS',
    );
    t.assert.strictEqual(
      parseCdkEventLine('S | DELETE_COMPLETE | AWS::S3::Bucket | B')?.status,
      'DELETE_COMPLETE',
    );
    t.assert.strictEqual(
      parseCdkEventLine('S | UPDATE_ROLLBACK_COMPLETE | AWS::Lambda::Function | Fn')?.status,
      'UPDATE_ROLLBACK_COMPLETE',
    );
  });

  it('returns null for a non-event line (banner, summary, blank)', (t: TestContext) => {
    t.assert.strictEqual(parseCdkEventLine('✨  Deployment time: 421s'), null);
    t.assert.strictEqual(parseCdkEventLine(''), null);
    t.assert.strictEqual(parseCdkEventLine('🌐 Frontend URL: https://x.cloudfront.net'), null);
  });
});

// The single-line cases above are hand-written. The whole feature depends on
// the exact shape of real `cdk deploy --progress events --ci` stdout (column
// spacing, timestamp/locale prefix, the Outputs URL line), which is
// CDK-CLI-version-dependent. This fixture is a transcript captured from an
// actual `--progress events --ci` deploy of a hosting-enabled stack, run
// through the parser + tracker + hosting-URL matcher exactly as runStreaming
// feeds them. If a CDK bump shifts the format, this fails here rather than
// silently disabling the heartbeat and the early URL in production.
describe('the real --progress events --ci transcript: parser + tracker + URL over a captured run', () => {
  // Trimmed from a real `cdk deploy --progress events --ci` run; line shape,
  // spacing and the Outputs URL line are as CDK emitted them.
  const TRANSCRIPT = [
    'ProbeStack: deploying... [1/1]',
    'ProbeStack | 0/6 | 1:23:45 PM | REVIEW_IN_PROGRESS      | AWS::CloudFormation::Stack | ProbeStack',
    'ProbeStack | 0/6 | 1:23:47 PM | CREATE_IN_PROGRESS      | AWS::DynamoDB::Table       | DataTable',
    'ProbeStack | 1/6 | 1:23:58 PM | CREATE_COMPLETE         | AWS::DynamoDB::Table       | DataTable',
    'ProbeStack | 1/6 | 1:24:01 PM | CREATE_IN_PROGRESS      | AWS::CloudFront::Distribution | HostingDistribution',
    'ProbeStack | 2/6 | 1:27:44 PM | CREATE_COMPLETE         | AWS::CloudFront::Distribution | HostingDistribution',
    '',
    'Outputs:',
    'ProbeStack.HostingDistributionUrl = https://d111abcdef8.cloudfront.net',
    'ProbeStack.ApiUrl = https://abc123.execute-api.us-east-1.amazonaws.com/',
    '',
    '✨  Deployment time: 241.3s',
  ];

  it('parses each real CDK event line to its STATUS | TYPE | LOGICALID triple', (t: TestContext) => {
    const events = TRANSCRIPT.map(parseCdkEventLine).filter((e) => e !== null);
    // Five event lines in the transcript; the banner/Outputs/blank lines are not events.
    t.assert.strictEqual(events.length, 5, 'exactly the CloudFormation event lines parse');
    t.assert.deepStrictEqual(events[events.length - 1], {
      status: 'CREATE_COMPLETE',
      resourceType: 'AWS::CloudFront::Distribution',
      logicalId: 'HostingDistribution',
    });
  });

  it('the tracker names the converging resource then clears it when the transcript settles', (t: TestContext) => {
    const tracker = createResourceTracker();
    const names: string[] = [];
    for (const line of TRANSCRIPT) {
      tracker.observe(line);
      const cur = tracker.current();
      if (cur) names.push(describeConvergingResource(cur));
    }
    // The DynamoDB table then the CloudFront distribution are each named while
    // converging; after the final CREATE_COMPLETE nothing is left converging.
    t.assert.ok(names.some((n) => n.includes('DataTable')), 'the table is named while it converges');
    t.assert.ok(
      names.some((n) => n.includes('HostingDistribution (AWS::CloudFront::Distribution)')),
      'the distribution is named while it converges',
    );
    t.assert.strictEqual(tracker.current(), null, 'nothing is converging once the deploy settles');
  });

  it('extracts the hosting URL from the real Outputs line', (t: TestContext) => {
    const urls = TRANSCRIPT.map(extractHostingUrlFromLine).filter((u) => u !== null);
    t.assert.deepStrictEqual(urls, ['https://d111abcdef8.cloudfront.net']);
  });
});

describe('describeConvergingResource — the heartbeat name', () => {
  it('renders `LogicalId (AWS::Type)`', (t: TestContext) => {
    t.assert.strictEqual(
      describeConvergingResource({
        status: 'CREATE_IN_PROGRESS',
        resourceType: 'AWS::CloudFront::Distribution',
        logicalId: 'HostingDistribution',
      }),
      'HostingDistribution (AWS::CloudFront::Distribution)',
    );
  });

  it('flags a rolling-back resource with a warning instead of a neutral name', (t: TestContext) => {
    t.assert.strictEqual(
      describeConvergingResource({
        status: 'UPDATE_ROLLBACK_IN_PROGRESS',
        resourceType: 'AWS::CloudFront::Distribution',
        logicalId: 'HostingDistribution',
      }),
      '⚠️ HostingDistribution (AWS::CloudFront::Distribution) rolling back',
    );
  });
});

describe('createResourceTracker — what is converging right now', () => {
  it('reports the resource that entered *_IN_PROGRESS', (t: TestContext) => {
    const tracker = createResourceTracker();
    tracker.observe('S | CREATE_IN_PROGRESS | AWS::CloudFront::Distribution | Dist');
    t.assert.strictEqual(tracker.current()?.logicalId, 'Dist');
  });

  it('clears the current resource when it reaches *_COMPLETE', (t: TestContext) => {
    const tracker = createResourceTracker();
    tracker.observe('S | CREATE_IN_PROGRESS | AWS::CloudFront::Distribution | Dist');
    tracker.observe('S | CREATE_COMPLETE | AWS::CloudFront::Distribution | Dist');
    t.assert.strictEqual(tracker.current(), null);
  });

  it('advances to the next in-progress resource (the serialized-GSI case)', (t: TestContext) => {
    const tracker = createResourceTracker();
    tracker.observe('S | CREATE_IN_PROGRESS | Custom::GsiManager | gsiresource');
    t.assert.strictEqual(tracker.current()?.logicalId, 'gsiresource');
    tracker.observe('S | CREATE_IN_PROGRESS | AWS::CloudFront::Distribution | Dist');
    t.assert.strictEqual(tracker.current()?.logicalId, 'Dist');
  });

  it('ignores non-event lines without dropping the current resource', (t: TestContext) => {
    const tracker = createResourceTracker();
    tracker.observe('S | CREATE_IN_PROGRESS | AWS::CloudFront::Distribution | Dist');
    tracker.observe('some banner line');
    t.assert.strictEqual(tracker.current()?.logicalId, 'Dist');
  });

  it('tracks and clears an UPDATE_* transition like a CREATE_*', (t: TestContext) => {
    const tracker = createResourceTracker();
    tracker.observe('S | UPDATE_IN_PROGRESS | AWS::DynamoDB::Table | Table');
    t.assert.strictEqual(tracker.current()?.logicalId, 'Table');
    tracker.observe('S | UPDATE_COMPLETE | AWS::DynamoDB::Table | Table');
    t.assert.strictEqual(tracker.current(), null);
  });

  it('tracks and clears a DELETE_* transition', (t: TestContext) => {
    const tracker = createResourceTracker();
    tracker.observe('S | DELETE_IN_PROGRESS | AWS::S3::Bucket | Bucket');
    t.assert.strictEqual(tracker.current()?.logicalId, 'Bucket');
    tracker.observe('S | DELETE_COMPLETE | AWS::S3::Bucket | Bucket');
    t.assert.strictEqual(tracker.current(), null);
  });

  it('does NOT clear on UPDATE_ROLLBACK_COMPLETE — a rollback is not a clean settle', (t: TestContext) => {
    const tracker = createResourceTracker();
    tracker.observe('S | UPDATE_IN_PROGRESS | AWS::CloudFront::Distribution | Dist');
    // Ends in `_COMPLETE`, but it is a rollback: the resource failed and was
    // reverted. The heartbeat must keep surfacing it, not read it as success.
    tracker.observe('S | UPDATE_ROLLBACK_COMPLETE | AWS::CloudFront::Distribution | Dist');
    t.assert.strictEqual(tracker.current()?.logicalId, 'Dist');
    t.assert.strictEqual(tracker.current()?.status, 'UPDATE_ROLLBACK_COMPLETE');
  });

  it('keeps naming a resource that entered ROLLBACK_IN_PROGRESS', (t: TestContext) => {
    const tracker = createResourceTracker();
    tracker.observe('S | UPDATE_ROLLBACK_IN_PROGRESS | AWS::Lambda::Function | Fn');
    t.assert.strictEqual(tracker.current()?.logicalId, 'Fn');
  });
});

describe('extractHostingUrlFromLine — surface the URL early', () => {
  it('recognizes a CDK Outputs hosting-url line (= form)', (t: TestContext) => {
    t.assert.strictEqual(
      extractHostingUrlFromLine('Foo.HostingDistributionUrl = https://d123.cloudfront.net'),
      'https://d123.cloudfront.net',
    );
  });

  it('recognizes the : form and trims trailing punctuation', (t: TestContext) => {
    t.assert.strictEqual(
      extractHostingUrlFromLine('HostingCdnDistributionUrl: https://d456.cloudfront.net.'),
      'https://d456.cloudfront.net',
    );
  });

  it('returns null for an unrelated line', (t: TestContext) => {
    t.assert.strictEqual(extractHostingUrlFromLine('📡 API URL: https://api.example.com'), null);
    t.assert.strictEqual(extractHostingUrlFromLine('CREATE_COMPLETE'), null);
  });
});

// ── authorization failures in the CDK output ────────────────────────────────
// Shapes from a real `cdk deploy --ci --progress events` run that an SCP stopped
// (identifiers replaced with documented example values). CloudFormation events
// go to stdout; the CDK CLI's error block goes to stderr, hard-wrapped mid-phrase.
const EXEC_ROLE = 'arn:aws:sts::123456789012:assumed-role/cdk-hnb659fds-cfn-exec-role-123456789012-us-east-1/AWSCloudFormation';
const SCP_ARN = 'arn:aws:organizations::777788889999:policy/o-exampleorgid/service_control_policy/p-examplepolicyid123';
const APIGW_SCP_FAILED =
  `my-app-prod |  0/72 | 7:46:36 PM | CREATE_FAILED           | AWS::ApiGateway::RestApi             | DefaultCompute/API (DefaultComputeAPI5E5CE44A) ` +
  `Resource handler returned message: "User: ${EXEC_ROLE} is not authorized to perform: apigateway:POST on resource: ` +
  `arn:aws:apigateway:us-east-1::/restapis with an explicit deny in a service control policy: ${SCP_ARN} ` +
  '(Service: ApiGateway, Status Code: 403, Request ID: 11111111-2222-3333-4444-555555555555) (SDK Attempt Count: 1)" ' +
  '(RequestToken: 66666666-7777-8888-9999-000000000000, HandlerErrorCode: GeneralServiceException)';
const KMS_DENIED_FAILED =
  `my-app-prod |  0/72 | 7:46:36 PM | CREATE_FAILED           | AWS::KMS::Key                        | Hosting/Hosting/Monitoring/AlarmTopicKey (HostingMonitoringAlarmTopicKey7A846590) ` +
  `Resource handler returned message: "Access denied for operation 'CreateKey'." (RequestToken: 66666666-7777-8888-9999-000000000000, HandlerErrorCode: AccessDenied)`;
const CANCELLED_FAILED =
  'my-app-prod |  0/72 | 7:46:36 PM | CREATE_FAILED           | AWS::Lambda::LayerVersion            | BlocksConfigDeployment/AwsCliLayer (BlocksConfigDeploymentAwsCliLayerD22C54E8) Resource creation cancelled';
const ORDINARY_FAILED =
  'my-app-prod |  0/72 | 7:46:36 PM | CREATE_FAILED           | AWS::S3::Bucket                      | BlocksConfigBucket (BlocksConfigBucket439874BD) Resource handler returned message: "my-app-bucket already exists (Service: S3, Status Code: 409)"';
const STACK_ROLLBACK =
  'my-app-prod |  0/72 | 7:46:46 PM | ROLLBACK_IN_PROGRESS    | AWS::CloudFormation::Stack           | my-app-prod The following resource(s) failed to create: [DefaultComputeAPI5E5CE44A, HostingMonitoringAlarmTopicKey7A846590]';
const PROD_EVENTS = [
  'my-app-prod: creating CloudFormation changeset...',
  'my-app-prod |  0/72 | 7:46:32 PM | CREATE_IN_PROGRESS      | AWS::CloudFormation::Stack           | my-app-prod User Initiated',
  'my-app-prod |  0/72 | 7:46:35 PM | CREATE_IN_PROGRESS      | AWS::ApiGateway::RestApi             | DefaultCompute/API (DefaultComputeAPI5E5CE44A) ',
];
const ROLLBACK_EVENTS = [
  STACK_ROLLBACK,
  'my-app-prod |  0/72 | 7:46:47 PM | DELETE_IN_PROGRESS      | AWS::S3::Bucket                      | BlocksConfigBucket (BlocksConfigBucket439874BD) ',
  'my-app-prod | 22/72 | 7:49:00 PM | ROLLBACK_COMPLETE       | AWS::CloudFormation::Stack           | my-app-prod ',
];
const WRAPPED_DEPLOYMENT_ERROR = [
  '❌  my-app-prod failed to deploy',
  '‣ DeploymentError: Resource updates failed:',
  'my-app-prod/DefaultCompute/API/Resource  (AWS::ApiGateway::RestApi DefaultComputeAPI5E5CE44A)',
  '  Resource handler returned message: "User:',
  `  ${EXEC_ROLE} is not`,
  '  authorized to perform: apigateway:POST on resource: arn:aws:apigateway:us-east-1::/restapis with an explicit deny in a',
  `  service control policy: ${SCP_ARN}`,
  '  (Service: ApiGateway, Status Code: 403, Request ID: 11111111-2222-3333-4444-555555555555) (SDK Attempt Count: 1)"',
  '  (RequestToken: 66666666-7777-8888-9999-000000000000, HandlerErrorCode: GeneralServiceException)',
  'Source Location: ...aws-cdk-lib, BlocksStack.create in @aws-blocks/core...',
  '',
  '   (only the most recent 500 CloudTrail events in the window were checked)',
  '   CloudTrail delivery can lag up to 15 minutes behind the failure; re-run `cdk diagnose` in a few minutes to check for additional control-plane errors (e.g. AccessDenied).',
  '',
];
// An ordinary failure, followed by the same CDK notes that name AccessDenied as an example.
const ORDINARY_DEPLOYMENT_ERROR = [
  '❌  my-app-prod failed to deploy',
  '‣ DeploymentError: Resource updates failed:',
  'my-app-prod/BlocksConfigBucket/Resource  (AWS::S3::Bucket BlocksConfigBucket439874BD)',
  '  Resource handler returned message: "my-app-bucket already exists (Service: S3, Status Code: 409)"',
  '',
  '   CloudTrail delivery can lag up to 15 minutes behind the failure; re-run `cdk diagnose` in a few minutes to check for additional',
  '   control-plane errors (e.g. AccessDenied).',
  'Could not query CloudTrail for control-plane errors: the lookup role is missing the `cloudtrail:LookupEvents` permission. Grant it to surface errors (e.g. AccessDenied) that resource logs may not show.',
];

/** Feed lines to a fresh monitor; returns each report with the index of the line that caused it. */
function monitorTranscript(
  lines: ReadonlyArray<string | [CdkOutputStream, string]>,
): { reports: Array<{ kind: string; at: number }>; monitor: DenialMonitor } {
  const reports: Array<{ kind: string; at: number }> = [];
  let at = -1;
  const monitor = createDenialMonitor((kind) => reports.push({ kind, at }));
  for (const entry of lines) {
    at += 1;
    const [stream, line] = typeof entry === 'string' ? (['stdout', entry] as const) : entry;
    monitor.observe(line, stream);
  }
  return { reports, monitor };
}

describe('createDenialMonitor — explain an authorization failure while CDK is still running', () => {
  it('reports an explicit SCP deny at its CREATE_FAILED event, before the rollback, and only once', () => {
    const lines = [...PROD_EVENTS, KMS_DENIED_FAILED, APIGW_SCP_FAILED, CANCELLED_FAILED, ...ROLLBACK_EVENTS];
    const { reports } = monitorTranscript([
      ...lines,
      ...WRAPPED_DEPLOYMENT_ERROR.map((line): [CdkOutputStream, string] => ['stderr', line]),
    ]);
    // The KMS failure names no policy; the API Gateway one does. Only the explicit
    // deny is reported, at its own event, not after rollback or in the final block.
    assert.deepStrictEqual(reports, [{ kind: 'organization-policy', at: lines.indexOf(APIGW_SCP_FAILED) }]);
  });

  it('reports a denial without policy evidence once the stack fails, not at the resource event', () => {
    const lines = [...PROD_EVENTS, KMS_DENIED_FAILED, CANCELLED_FAILED, ...ROLLBACK_EVENTS];
    const { reports } = monitorTranscript(lines);
    // Held until the stack-level failure, so that a later explicit deny of the same
    // attempt is not preceded by advice to check IAM permissions.
    assert.deepStrictEqual(reports, [{ kind: 'denied', at: lines.indexOf(STACK_ROLLBACK) }]);
  });

  it('reads the hard-wrapped DeploymentError block on stderr when no event named the deny', () => {
    const { reports } = monitorTranscript(
      WRAPPED_DEPLOYMENT_ERROR.map((line): [CdkOutputStream, string] => ['stderr', line]),
    );
    // The phrase completes on the line that starts "service control policy".
    assert.deepStrictEqual(reports, [{ kind: 'organization-policy', at: 6 }]);
  });

  it('keeps each stream’s wrapped lines together while the other stream interleaves', () => {
    const entries: Array<[CdkOutputStream, string]> = [];
    for (const line of WRAPPED_DEPLOYMENT_ERROR) {
      entries.push(['stderr', line]);
      entries.push(['stdout', '⏳ [cdk deploy] still running after 2m 00s — CloudFormation is converging (pid 4242)']);
    }
    assert.deepStrictEqual(
      monitorTranscript(entries).reports.map((r) => r.kind),
      ['organization-policy'],
    );
  });

  it('reads colored output and lines with CR redraws', () => {
    const colored = APIGW_SCP_FAILED.replace('CREATE_FAILED', '\u001b[31mCREATE_FAILED\u001b[39m').replace(
      'explicit deny',
      '\u001b[1mexplicit deny\u001b[22m',
    );
    assert.deepStrictEqual(monitorTranscript([colored]).reports.map((r) => r.kind), ['organization-policy']);
    const redrawn = `my-app-prod: deploying... [1/1]\r${APIGW_SCP_FAILED}`;
    assert.deepStrictEqual(monitorTranscript([redrawn]).reports.map((r) => r.kind), ['organization-policy']);
  });

  it('reports nothing for an ordinary failure, even next to the CDK notes that mention AccessDenied', () => {
    const { reports, monitor } = monitorTranscript([
      ...PROD_EVENTS,
      ORDINARY_FAILED,
      ...ROLLBACK_EVENTS,
      ...ORDINARY_DEPLOYMENT_ERROR.map((line): [CdkOutputStream, string] => ['stderr', line]),
    ]);
    monitor.failed();
    assert.deepStrictEqual(reports, []);
  });

  it('ignores denial wording outside a failure: progress, app logs and successful events', () => {
    const { reports, monitor } = monitorTranscript([
      'my-app-prod |  1/72 | 7:46:40 PM | CREATE_COMPLETE         | AWS::IAM::Role                       | AccessDeniedHandlerRole',
      ['stderr', '[/aws/lambda/my-app-handler] 10:00:00 AM AccessDeniedException: User is not authorized to perform: s3:GetObject'],
      ['stderr', 'Bundling asset AccessDenied/Handler/Code/Stage...'],
    ]);
    monitor.failed();
    assert.deepStrictEqual(reports, []);
  });

  it('ignores app log lines that look like deployment output', () => {
    const appLog = `[/aws/lambda/handler] 10:00:00 AM ${APIGW_SCP_FAILED}`;
    const { reports, monitor } = monitorTranscript([appLog, ['stderr', appLog]]);
    monitor.failed();
    assert.deepStrictEqual(reports, [], 'a logged event line is not a deploy failure');
    // A logged "Invoking 'cdk deploy' again" does not start a new attempt either.
    const { reports: once } = monitorTranscript([
      APIGW_SCP_FAILED,
      ['stderr', "[/aws/lambda/handler] 10:00:01 AM Invoking 'cdk deploy' again"],
      APIGW_SCP_FAILED,
    ]);
    assert.deepStrictEqual(once.map((r) => r.kind), ['organization-policy']);
  });

  it('classifies only the reason of a failed event, not its type, logical ID or construct path', () => {
    const { reports, monitor } = monitorTranscript([
      'my-app-prod |  0/72 | 7:46:36 PM | CREATE_FAILED           | AWS::S3::Bucket                      | AccessDenied (AccessDeniedABC12345) bucket already exists',
      'my-app-prod |  0/72 | 7:46:36 PM | CREATE_FAILED           | AWS::S3::Bucket                      | Logs/AccessDeniedLogs (AccessDeniedLogs1A2B3C4D) Resource creation cancelled',
    ]);
    monitor.failed();
    assert.deepStrictEqual(reports, []);
  });

  it('does not read the stack name in the CDK failure banner as evidence', () => {
    const { reports, monitor } = monitorTranscript(
      [
        '❌  AccessDenied-prod failed to deploy',
        '‣ ValidationError: Template format error: Unrecognized resource types: [AWS::Example::Thing]',
        '',
        '❌  AccessDenied-prod failed: ValidationError: Template format error',
      ].map((line): [CdkOutputStream, string] => ['stderr', line]),
    );
    monitor.failed();
    assert.deepStrictEqual(reports, []);
    // An older CDK CLI puts the error on the banner line: that part is still read.
    const { reports: older } = monitorTranscript([
      ['stderr', `❌  AccessDenied-prod failed: AccessDenied: User: ${EXEC_ROLE} is not authorized to perform: cloudformation:CreateStack with an explicit deny in a service control policy`],
    ]);
    assert.deepStrictEqual(older.map((r) => r.kind), ['organization-policy']);
  });

  it('leaves resource headings and source locations of the error block out', () => {
    const { reports, monitor } = monitorTranscript(
      [
        '❌  my-app-prod failed to deploy',
        '‣ DeploymentError: Resource updates failed:',
        'my-app-prod/AccessDenied/Resource  (AWS::S3::Bucket AccessDeniedABC12345)',
        '  Resource handler returned message: "my-app-bucket already exists (Service: S3, Status Code: 409)"',
        'Source Location: ...aws-cdk-lib, new AccessDenied in @aws-blocks/core...',
        '                 <anonymous> (/home/user/AccessDenied/aws-blocks/index.cdk.ts:24:3)',
        '',
      ].map((line): [CdkOutputStream, string] => ['stderr', line]),
    );
    monitor.failed();
    assert.deepStrictEqual(reports, []);
  });

  it('reports a pending denial when the caller learns that the deploy failed', () => {
    const s3Denied = ORDINARY_FAILED.replace(
      'my-app-bucket already exists (Service: S3, Status Code: 409)',
      'Access Denied (Service: S3, Status Code: 403)',
    );
    const { reports, monitor } = monitorTranscript([s3Denied]);
    assert.strictEqual(reports.length, 0, 'held: the attempt has not failed yet');
    monitor.failed();
    assert.deepStrictEqual(reports.map((r) => r.kind), ['denied']);
    monitor.failed();
    assert.strictEqual(reports.length, 1, 'once per attempt');
  });

  it('reports an explicit deny that follows a reported denial, then nothing more', () => {
    const { reports } = monitorTranscript([
      KMS_DENIED_FAILED,
      STACK_ROLLBACK,
      APIGW_SCP_FAILED,
      APIGW_SCP_FAILED,
      KMS_DENIED_FAILED,
    ]);
    assert.deepStrictEqual(reports.map((r) => r.kind), ['denied', 'organization-policy']);
  });

  it('reports once per `cdk watch` deployment, and again for the next one', () => {
    const attempt = [
      ['stderr', "Detected change to 'aws-blocks/index.ts' (type: change). Triggering 'cdk deploy'"],
      ['stderr', 'my-app-sandbox: deploying... [1/1]'],
      ['stderr', APIGW_SCP_FAILED],
      ['stderr', APIGW_SCP_FAILED],
      ['stderr', '❌  my-app-sandbox failed to deploy'],
      ['stderr', `‣ AccessDenied: User: ${EXEC_ROLE} is not authorized to perform: lambda:CreateFunction with an explicit deny in a service control policy`],
    ] as Array<[CdkOutputStream, string]>;
    const { reports } = monitorTranscript([
      ['stderr', "Triggering initial 'cdk deploy'"],
      ['stderr', 'my-app-sandbox: deploying... [1/1]'],
      ...attempt,
      ...attempt,
      ['stderr', "Detected file changes during deployment. Invoking 'cdk deploy' again"],
      ['stderr', APIGW_SCP_FAILED],
    ]);
    assert.deepStrictEqual(reports.map((r) => r.kind), ['organization-policy', 'organization-policy', 'organization-policy']);
  });

  it('does not read an expired token in `cdk watch` as a denial, and still reports a later one', () => {
    const { reports } = monitorTranscript([
      ['stderr', "Triggering initial 'cdk deploy'"],
      ['stderr', '❌  my-app-sandbox failed to deploy'],
      ['stderr', '‣ ExpiredToken: The security token included in the request is expired'],
      ['stderr', "Detected change to 'aws-blocks/index.ts' (type: change). Triggering 'cdk deploy'"],
      ['stderr', '❌  my-app-sandbox failed to deploy'],
      ['stderr', '‣ ExpiredTokenException: The security token included in the request is expired'],
      ['stderr', "Detected change to 'aws-blocks/index.ts' (type: change). Triggering 'cdk deploy'"],
      ['stderr', APIGW_SCP_FAILED],
    ]);
    assert.deepStrictEqual(reports, [{ kind: 'organization-policy', at: 7 }]);
  });
});

describe('createDenialMonitor — credential failures in the CDK output', () => {
  /** Feed stderr lines; returns the denial kinds and the credential failures reported. */
  const credentialTranscript = (lines: string[]) => {
    const denials: string[] = [];
    const credentials: string[] = [];
    const monitor = createDenialMonitor((kind) => denials.push(kind), {
      onCredentialFailure: ({ errorName, failure }) => credentials.push(`${errorName} ${failure}`),
    });
    for (const line of lines) monitor.observe(line, 'stderr');
    monitor.failed();
    return { denials, credentials };
  };

  // Shapes from the CDK CLI 2.1146 bundle and the AWS SDK credential providers it bundles.
  for (const [name, lines, expected] of [
    ['an error block cause', ['❌  my-app-prod failed to deploy', '‣ ExpiredToken: The security token included in the request is expired'], 'ExpiredToken expired'],
    ['a failed asset upload', ['my-app-sandbox: fail: The security token included in the request is expired'], 'ExpiredToken expired'],
    ['a failed role assumption', ['my-app-sandbox: fail: Assuming role failed: ExpiredToken'], 'ExpiredToken expired'],
    // The aws login provider wraps a refresh that its sign-in service denied; the
    // recovery is to sign in again, not an IAM change.
    [
      'a denied aws login refresh in a failed asset upload',
      ['my-app-sandbox: fail: Failed to refresh token: AccessDeniedException: Access denied. Please re-authenticate using `aws login`'],
      'CredentialsProviderError expired',
    ],
    [
      'a denied aws login refresh in the error block, wrapped',
      [
        '❌  my-app-prod failed to deploy',
        '‣ CredentialsProviderError: Failed to refresh token: AccessDeniedException: User is not authorized to perform this',
        '  operation. Please re-authenticate using `aws login`',
        '',
      ],
      'CredentialsProviderError expired',
    ],
    ['an invalid token', ['my-app-sandbox: fail: The security token included in the request is invalid.'], 'InvalidClientTokenId rejected'],
    ['an unrecognized client', ['❌  my-app-prod failed to deploy', '‣ UnrecognizedClientException: The security token included in the request is invalid.'], 'UnrecognizedClientException rejected'],
    [
      'an expired IAM Identity Center session',
      ['my-app-sandbox: fail: The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.'],
      'CredentialsProviderError expired',
    ],
    [
      'an expired SSO token',
      ['❌  my-app-prod failed to deploy', "‣ TokenProviderError: Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile."],
      'TokenProviderError expired',
    ],
    ['an expired aws login session', ['my-app-sandbox: fail: Your session has expired. Please reauthenticate.'], 'CredentialsProviderError expired'],
    [
      'a failed aws login refresh',
      ['my-app-sandbox: fail: Failed to refresh token: Error: network. Please re-authenticate using aws login'],
      'CredentialsProviderError expired',
    ],
  ] as const) {
    it(`reports ${name}, and no denial`, () => {
      assert.deepStrictEqual(credentialTranscript([...lines]), { denials: [], credentials: [expected] });
    });
  }

  it('reports once per attempt, again after a new watch deployment, and not from app logs', () => {
    const expired = 'my-app-sandbox: fail: The security token included in the request is expired';
    assert.deepStrictEqual(
      credentialTranscript([
        "Triggering initial 'cdk deploy'",
        '[/aws/lambda/handler] 10:00:00 AM ExpiredToken: The security token included in the request is expired',
        expired,
        expired,
        "Detected change to 'aws-blocks/index.ts' (type: change). Triggering 'cdk deploy'",
        expired,
      ]).credentials,
      ['ExpiredToken expired', 'ExpiredToken expired'],
    );
  });

  it('does not give a denial credential guidance, and reports a failed asset upload that AWS denied', () => {
    const result = credentialTranscript([
      `my-app-sandbox: fail: User: ${EXEC_ROLE} is not authorized to perform: s3:PutObject with an explicit deny in a service control policy`,
    ]);
    assert.deepStrictEqual(result, { denials: ['organization-policy'], credentials: [] });
  });

  it('gives no credential guidance for a name or a code that is not a credential error', () => {
    const collision =
      'my-app-prod |  0/9 | 7:46:36 PM | CREATE_FAILED           | AWS::DynamoDB::Table                 | Tokens (TokensTable1A2B3C4D) ' +
      'Resource handler returned message: "Resource of type AWS::DynamoDB::Table with identifier ExpiredToken already exists"';
    assert.deepStrictEqual(credentialTranscript([collision]), { denials: [], credentials: [] });
    assert.deepStrictEqual(
      credentialTranscript(["my-app-sandbox: fail: ENOENT: no such file or directory, open '/app/ExpiredToken/asset.zip'"]),
      { denials: [], credentials: [] },
    );
    // EC2 also returns RequestExpired for a clock that is more than 15 minutes off.
    assert.deepStrictEqual(
      credentialTranscript(['❌  my-app-prod failed to deploy', '‣ RequestExpired: Request has expired.']),
      { denials: [], credentials: [] },
    );
  });

  it('keeps an ordinary resource denial a denial', () => {
    const s3Denied =
      'my-app-prod |  0/9 | 7:46:36 PM | CREATE_FAILED           | AWS::S3::Bucket                      | Assets (Assets1A2B3C4D) ' +
      'Resource handler returned message: "Access Denied (Service: S3, Status Code: 403)"';
    assert.deepStrictEqual(credentialTranscript([s3Denied]), { denials: ['denied'], credentials: [] });
  });

  it('lets an explicit deny win over the aws login sign-in instruction that wraps it', () => {
    // Signing in again cannot get past an Organizations policy.
    const wrapped =
      'my-app-sandbox: fail: Failed to refresh token: AccessDeniedException: User: ' +
      `${EXEC_ROLE} is not authorized to perform: signin:CreateOAuth2Token with an explicit deny in a service control policy. ` +
      'Please re-authenticate using `aws login`';
    assert.deepStrictEqual(credentialTranscript([wrapped]), { denials: ['organization-policy'], credentials: [] });
  });

  it('reports only the explicit deny of an error block whose earlier cause is a sign-in instruction', () => {
    const result = credentialTranscript([
      '❌  my-app-prod failed to deploy',
      '‣ CredentialsProviderError: Failed to refresh token: TimeoutError: timed out. Please re-authenticate using `aws login`',
      `‣ AccessDenied: User: ${EXEC_ROLE} is not authorized to perform: cloudformation:CreateStack with an explicit deny`,
      '  in a resource control policy',
      '',
    ]);
    assert.deepStrictEqual(result, { denials: ['organization-policy'], credentials: [] });
  });
});

describe('formatDenialNotice — what the deploy commands print', () => {
  it('names the command and adds the guidance, without details from the failure', () => {
    const notice = formatDenialNotice('organization-policy', 'deploy');
    assert.match(notice, /`npm run deploy`/);
    assert.match(notice, /AWS Organizations policy/);
    assert.match(notice, /Signing in again or adding IAM permissions does not change that/);
    assert.doesNotMatch(notice, /arn:|\d{12}|o-[a-z0-9]{10}|p-[a-z0-9]{8}/);
    assert.doesNotMatch(notice, /limit|budget|spend|destroy|retry|try again/i);
    assert.match(formatDenialNotice('denied', 'sandbox'), /`npm run sandbox`[\s\S]*permissions/);
  });
});

describe('runStreaming — onDenial', () => {
  const noSignals = (): SignalRegistry => new EventEmitter() as unknown as SignalRegistry;

  it('reports an explicit deny split across chunks while the child still runs', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-denial-'));
    try {
      const gate = join(dir, 'seen-by-parent');
      const script = join(dir, 'deny.mjs');
      const half = Math.floor(APIGW_SCP_FAILED.length / 2);
      // The event line arrives in two chunks, split inside the explicit-deny phrase's
      // line, and the child then waits: the report must not wait for the exit.
      writeFileSync(
        script,
        `import { existsSync } from 'node:fs';\n` +
          `const line = ${JSON.stringify(APIGW_SCP_FAILED)};\n` +
          `process.stdout.write(line.slice(0, ${half}));\n` +
          // A real pause between the writes, in the child, so that the pipe delivers two chunks.
          `setTimeout(() => process.stdout.write(line.slice(${half}) + '\\r\\n'), 100);\n` +
          `const wait = () => existsSync(${JSON.stringify(gate)}) ? done() : setTimeout(wait, 25);\n` +
          `const done = () => { process.stderr.write(${JSON.stringify(WRAPPED_DEPLOYMENT_ERROR.join('\n'))}); process.exitCode = 1; };\n` +
          `wait();\n`,
      );
      const stdout = collectingSink();
      const stderr = collectingSink();
      const kinds: string[] = [];
      const run = runStreaming(process.execPath, [script], {
        stdout,
        stderr,
        heartbeatMs: 0,
        signalTarget: noSignals(),
        onDenial: (kind) => kinds.push(kind),
      });
      assert.ok(await waitFor(() => kinds.length > 0, 15_000), 'reported while the child is alive');
      assert.deepStrictEqual(kinds, ['organization-policy']);
      writeFileSync(gate, 'go');
      await assert.rejects(run, (error: unknown) => error instanceof DeployProcessError && error.exitCode === 1);
      assert.deepStrictEqual(kinds, ['organization-policy'], 'the final error block does not repeat it');
      // The output itself is relayed as before: whole lines, unchanged.
      assert.strictEqual(stdout.text(), `${APIGW_SCP_FAILED}\n`);
      // The block ends with a newline, so nothing is added to it.
      assert.strictEqual(stderr.text(), WRAPPED_DEPLOYMENT_ERROR.join('\n'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a trailing stderr line without a newline', { timeout: 30_000 }, async () => {
    const kinds: string[] = [];
    const script = `process.stderr.write('❌  my-app-prod failed to deploy\\n‣ AccessDenied: ' + ${JSON.stringify(
      `User: ${EXEC_ROLE} is not authorized to perform: cloudformation:CreateStack with an explicit deny in a resource control policy`,
    )}); process.exitCode = 1;`;
    await assert.rejects(
      runStreaming(process.execPath, ['-e', script], {
        stdout: collectingSink(),
        stderr: collectingSink(),
        heartbeatMs: 0,
        signalTarget: noSignals(),
        onDenial: (kind) => kinds.push(kind),
      }),
      DeployProcessError,
    );
    assert.deepStrictEqual(kinds, ['organization-policy']);
  });

  it('reports a denial without policy evidence when the deploy exits non-zero', { timeout: 30_000 }, async () => {
    const kinds: string[] = [];
    await assert.rejects(
      runStreaming(process.execPath, ['-e', `console.log(${JSON.stringify(KMS_DENIED_FAILED)}); process.exitCode = 2;`], {
        stdout: collectingSink(),
        stderr: collectingSink(),
        heartbeatMs: 0,
        signalTarget: noSignals(),
        onDenial: (kind) => kinds.push(kind),
      }),
      (error: unknown) => error instanceof DeployProcessError && error.exitCode === 2,
    );
    assert.deepStrictEqual(kinds, ['denied']);
  });

  it('reports nothing for an ordinary failure or a successful deploy', { timeout: 30_000 }, async () => {
    const kinds: string[] = [];
    const options = {
      stdout: collectingSink(),
      stderr: collectingSink(),
      heartbeatMs: 0,
      signalTarget: noSignals(),
      onDenial: (kind: string) => kinds.push(kind),
    };
    const failing = [ORDINARY_FAILED, STACK_ROLLBACK].map((l) => `console.log(${JSON.stringify(l)});`).join('') +
      ORDINARY_DEPLOYMENT_ERROR.map((l) => `console.error(${JSON.stringify(l)});`).join('') +
      'process.exitCode = 1;';
    await assert.rejects(runStreaming(process.execPath, ['-e', failing], options), DeployProcessError);
    await runStreaming(process.execPath, ['-e', `console.log(${JSON.stringify(PROD_EVENTS[1])});`], options);
    assert.deepStrictEqual(kinds, []);
  });
});
