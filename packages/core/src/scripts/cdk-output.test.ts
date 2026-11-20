// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  attachCdkWatchOutput,
  createCdkOutput,
  createCdkProgressReporter,
  createOutputRing,
  formatRetainedOutput,
} from './cdk-output.js';
import { DeployProcessError, type OutputSink, runStreaming, type SignalRegistry } from './deploy-stream.js';
import { runDestroyWithRetries } from './sandbox.js';

afterEach(() => mock.restoreAll());

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

/** A `node -e` script that prints `stdoutLines`, then `stderrLines`, then exits with `code`. */
function fakeCdk(stdoutLines: string[], stderrLines: string[], code: number): string[] {
  return [
    '-e',
    `for (const l of ${JSON.stringify(stdoutLines)}) console.log(l);` +
      `for (const l of ${JSON.stringify(stderrLines)}) console.error(l);` +
      `process.exitCode = ${code};`,
  ];
}

const DEPLOY_STDOUT = [
  '✨  Synthesis time: 3.2s',
  'MyStack: deploying... [1/1]',
  'MyStack |  0/2 | 10:04:30 AM | UPDATE_IN_PROGRESS   | AWS::CloudFormation::Stack | MyStack User Initiated',
  'MyStack |  0/2 | 10:04:33 AM | CREATE_IN_PROGRESS   | AWS::S3::Bucket | Bucket',
  'MyStack |  1/2 | 10:04:40 AM | CREATE_FAILED        | AWS::S3::Bucket | Bucket Resource handler returned message: "boom"',
];
const DEPLOY_STDERR = ['❌  MyStack failed: Error: The stack named MyStack failed creation'];

describe('createOutputRing', () => {
  it('keeps the most recent lines, oldest first, and counts every push', () => {
    const ring = createOutputRing(3);
    for (const line of ['a', 'b', 'c', 'd', 'e']) ring.push(line);
    assert.deepStrictEqual(ring.lines(), ['c', 'd', 'e']);
    assert.strictEqual(ring.total(), 5);
    ring.clear();
    assert.deepStrictEqual(ring.lines(), []);
  });

  it('frames the dump with a header naming the command, extent and level', () => {
    const ring = createOutputRing(2);
    assert.strictEqual(formatRetainedOutput(ring, 'cdk deploy', 'quiet'), '');
    for (const line of ['one', 'two', 'three']) ring.push(line);
    assert.strictEqual(
      formatRetainedOutput(ring, 'cdk deploy', 'normal'),
      '\n──── cdk deploy output (last 2 of 3 lines, retained because BLOCKS_LOG_LEVEL=normal) ────\n' +
        'two\nthree\n──── end of cdk deploy output ────\n',
    );
  });
});

describe('createCdkProgressReporter', () => {
  it('condenses a production event stream into milestones, a count and a summary', () => {
    const out = collectingSink();
    const err = collectingSink();
    let clock = 0;
    const reporter = createCdkProgressReporter(out, err, { now: () => clock, pipedIntervalMs: 1_000 });
    const feed = (line: string): void => {
      clock += 5_000;
      reporter.line(line, 'stdout');
    };
    feed('✨  Synthesis time: 3.2s');
    feed('(node:123) NodeVersionSupportWarning: noise');
    feed('MyStack |  0/2 | 10:04:30 AM | UPDATE_IN_PROGRESS   | AWS::CloudFormation::Stack | MyStack');
    feed('MyStack |  0/2 | 10:04:33 AM | CREATE_IN_PROGRESS   | AWS::Lambda::Function | Handler');
    feed('MyStack |  1/2 | 10:04:40 AM | CREATE_COMPLETE      | AWS::Lambda::Function | Handler');
    feed('MyStack |  2/2 | 10:04:50 AM | CREATE_COMPLETE      | AWS::S3::Bucket | Bucket');
    feed('Outputs:');
    feed(' ✅  MyStack');
    reporter.finish(true);
    assert.strictEqual(
      out.text(),
      [
        '   Synthesizing app...',
        '   CloudFormation: 2 resources to apply',
        '   CloudFormation... 1/2 resources',
        '   CloudFormation... 2/2 resources',
        '   2 resources applied in 40s',
        '',
      ].join('\n'),
    );
    assert.strictEqual(err.text(), '');
  });

  it('passes failure and rollback lines through verbatim on the stream they came from', () => {
    const out = collectingSink();
    const err = collectingSink();
    const reporter = createCdkProgressReporter(out, err, { verb: 'destroy' });
    reporter.line('Stack | 1 | 10:00:05 AM | DELETE_FAILED | AWS::S3::Bucket | Bucket not empty', 'stderr');
    reporter.line('Stack | 2 | 10:00:06 AM | UPDATE_ROLLBACK_IN_PROGRESS | AWS::CloudFormation::Stack | Stack', 'stdout');
    reporter.line('random chatter', 'stdout');
    reporter.finish(false);
    assert.strictEqual(err.text(), 'Stack | 1 | 10:00:05 AM | DELETE_FAILED | AWS::S3::Bucket | Bucket not empty\n');
    assert.strictEqual(out.text(), 'Stack | 2 | 10:00:06 AM | UPDATE_ROLLBACK_IN_PROGRESS | AWS::CloudFormation::Stack | Stack\n');
  });

  it('prints synth warnings (location, message, construct path, acknowledgement) once each, on their stream', () => {
    const out = collectingSink();
    const err = collectingSink();
    const reporter = createCdkProgressReporter(out, err);
    const warning = [
      'cdk-blocks/index.cdk.ts:33:3',
      "WARNING The 'alb' front door serves the app over plain HTTP (no certificate), so sign-in travels unencrypted.",
      '   app-sandbox/Hosting/Hosting',
      "   Acknowledge with 'Annotation::@aws-cdk-blocks/hosting:PlainHttpFrontDoor'",
    ];
    // `cdk deploy` synthesizes, and a sandbox synthesizes first: the same block arrives twice.
    for (let i = 0; i < 2; i++) {
      for (const line of ['[Blocks] IAM report: cdk.out/app.blocks-iam.json', ...warning, '']) reporter.line(line, 'stderr');
      reporter.line("85 feature flags are not configured. Run 'cdk flags --unstable=flags' to learn more.", 'stderr');
    }
    reporter.line('[Warning at /App/Bucket] Bucket is public [ack: @aws-cdk-blocks/bb-file-bucket:Public]', 'stderr');
    reporter.line('✨  Synthesis time: 0.5s', 'stdout');
    reporter.finish(true);
    assert.strictEqual(
      err.text(),
      [...warning, '[Warning at /App/Bucket] Bucket is public [ack: @aws-cdk-blocks/bb-file-bucket:Public]', ''].join('\n'),
    );
    assert.strictEqual(out.text(), '   Synthesizing app...\n');
  });

  it("keeps each stream's warning state apart: an interleaved line on the other stream neither joins nor splits a warning", () => {
    const out = collectingSink();
    const err = collectingSink();
    const reporter = createCdkProgressReporter(out, err);
    const block = [
      'cdk-blocks/index.cdk.ts:33:3',
      'WARNING Plain HTTP front door.',
      '   app-sandbox/Hosting/Hosting',
      "   Acknowledge with 'Annotation::@aws-cdk-blocks/hosting:PlainHttpFrontDoor'",
    ];
    for (let i = 0; i < 2; i++) {
      reporter.line(block[0], 'stderr');
      reporter.line('  cdk.out/asset.abc/index.mjs  1.2kb', 'stdout'); // esbuild, between location and WARNING
      reporter.line(block[1], 'stderr');
      reporter.line('  cdk.out/asset.def/index.mjs  3.4kb', 'stdout'); // esbuild, inside the warning
      reporter.line(block[2], 'stderr');
      reporter.line(block[3], 'stderr');
      reporter.line('', 'stderr');
    }
    reporter.finish(true);
    assert.strictEqual(err.text(), `${block.join('\n')}\n`);
    assert.strictEqual(out.text(), '');
  });

  it('keeps every source location of a warning raised at several places, including the "and N more" line', () => {
    const err = collectingSink();
    const reporter = createCdkProgressReporter(collectingSink(), err);
    const block = [
      'cdk-blocks/index.cdk.ts:33:3',
      'or cdk-blocks/a.ts:1:1',
      'or cdk-blocks/b.ts:2:2',
      'or cdk-blocks/c.ts:3:3',
      'or cdk-blocks/d.ts:4:4',
      '(and 2 more...)',
      'WARNING Shared warning.',
      '   app/A',
    ];
    for (const line of ['unrelated: 1:2', ...block, '']) reporter.line(line, 'stderr');
    reporter.finish(true);
    assert.strictEqual(err.text(), `${block.join('\n')}\n`);
  });

  it('prints a warning on stdout, ends one at a resource event line, flushes one at finish, and reads CRLF blocks', () => {
    const out = collectingSink();
    const err = collectingSink();
    const reporter = createCdkProgressReporter(out, err);
    reporter.line('WARNING On stdout.\r', 'stdout');
    reporter.line('   app/Stdout\r', 'stdout');
    reporter.line('\r', 'stdout');
    reporter.line('WARNING Before an event.', 'stderr');
    reporter.line('   app/Evented', 'stderr');
    reporter.line('  Stack | 1/3 | 10:00:01 AM | UPDATE_FAILED | AWS::S3::Bucket | Bucket Resource creation failed', 'stderr');
    reporter.line('WARNING Last line.', 'stderr');
    reporter.line('   app/Last', 'stderr');
    reporter.finish(false);
    assert.strictEqual(out.text(), 'WARNING On stdout.\n   app/Stdout\n');
    assert.strictEqual(
      err.text(),
      [
        'WARNING Before an event.',
        '   app/Evented',
        'Stack | 1/3 | 10:00:01 AM | UPDATE_FAILED | AWS::S3::Bucket | Bucket Resource creation failed',
        'WARNING Last line.',
        '   app/Last',
        '',
      ].join('\n'),
    );
  });

  it('ends a warning at a `❌` failure line, prints the failure, and keeps a construct path that names an error', () => {
    const out = collectingSink();
    const err = collectingSink();
    const reporter = createCdkProgressReporter(out, err);
    for (let synth = 0; synth < 2; synth++) {
      reporter.line('WARNING Plain HTTP front door.', 'stderr');
      reporter.line('   app-sandbox/error-pages/Hosting', 'stderr');
      reporter.line(' ❌  app-sandbox failed: Error: boom', 'stderr');
    }
    reporter.finish(false);
    assert.strictEqual(
      err.text(),
      [
        'WARNING Plain HTTP front door.',
        '   app-sandbox/error-pages/Hosting',
        '❌  app-sandbox failed: Error: boom',
        '❌  app-sandbox failed: Error: boom',
        '',
      ].join('\n'),
    );
  });

  it("drops OpenNext's expected wrapper/converter ERROR on a Next.js build, and keeps other OpenNext errors", () => {
    const out = collectingSink();
    const err = collectingSink();
    const reporter = createCdkProgressReporter(out, err);
    for (const line of [
      '\u001b[31mERROR\u001b[39m Wrapper aws-lambda-streaming and converter aws-apigw-v1 are not compatible. For the wrapper aws-lambda-streaming you should only use the following converters: aws-apigw-v2',
      'ERROR Wrapper aws-lambda-streaming and converter aws-apigw-v1 are not compatible.',
      'For the wrapper aws-lambda-streaming you should only use the following converters: aws-apigw-v2',
      'ERROR Could not build the server function',
    ]) {
      reporter.line(line, 'stderr');
    }
    reporter.finish(true);
    assert.strictEqual(err.text(), 'ERROR Could not build the server function\n');
    assert.strictEqual(out.text(), '');
  });

  it('redraws one progress line in place on a TTY and clears it before the next full line', () => {
    const out = collectingSink();
    const reporter = createCdkProgressReporter(out, collectingSink(), { isTty: true, now: () => 0 });
    reporter.line('S | 0/1 | t | CREATE_IN_PROGRESS | AWS::SQS::Queue | Q', 'stdout');
    reporter.note('⏳ heartbeat');
    assert.strictEqual(
      out.text(),
      '   CloudFormation: 1 resource to apply\n\r\x1b[K   CloudFormation... 0/1 resources · 0s\r\x1b[K⏳ heartbeat\n',
    );
  });
});

describe('createCdkOutput', () => {
  it('with BLOCKS_LOG_LEVEL unset, leaves runStreaming uncurated and run() synchronous (runSync)', () => {
    const output = createCdkOutput({ label: 'cdk deploy', level: 'legacy' });
    assert.strictEqual(output.curated, false);
    assert.strictEqual(output.streams, undefined);
    assert.strictEqual(output.run(process.execPath, ['-e', '']), undefined);
    for (const level of ['verbose', 'debug'] as const) {
      assert.strictEqual(createCdkOutput({ label: 'x', level }).streams, undefined);
    }
  });

  it('relays raw output byte for byte through runStreaming when not curated', { timeout: 30_000 }, async () => {
    const out = collectingSink();
    const err = collectingSink();
    const output = createCdkOutput({ label: 'cdk deploy', level: 'legacy', stdout: out, stderr: err });
    await assert.rejects(
      runStreaming(process.execPath, fakeCdk(DEPLOY_STDOUT, DEPLOY_STDERR, 1), {
        stdout: out,
        stderr: err,
        heartbeatMs: 0,
        signalTarget: new EventEmitter() as unknown as SignalRegistry,
        curated: output.streams,
      }),
      DeployProcessError,
    );
    output.printRetained();
    assert.strictEqual(out.text(), `${DEPLOY_STDOUT.join('\n')}\n`);
    assert.strictEqual(err.text(), `${DEPLOY_STDERR.join('\n')}\n`);
  });

  it('at normal, curates a failing deploy and prints the full raw output on failure', { timeout: 30_000 }, async () => {
    const out = collectingSink();
    const err = collectingSink();
    const raw = collectingSink();
    const output = createCdkOutput({ label: 'cdk deploy', level: 'normal', stdout: out, stderr: err, isTty: false });
    await assert.rejects(
      runStreaming(process.execPath, fakeCdk(DEPLOY_STDOUT, DEPLOY_STDERR, 1), {
        stdout: raw,
        stderr: raw,
        heartbeatMs: 0,
        signalTarget: new EventEmitter() as unknown as SignalRegistry,
        curated: output.streams,
      }),
      /exited with code 1/,
    );
    assert.strictEqual(raw.text(), '', 'nothing bypasses the curated sinks');
    assert.strictEqual(
      out.text(),
      `   Synthesizing app...\n   CloudFormation: 2 resources to apply\n${DEPLOY_STDOUT[4]}\n`,
    );
    assert.strictEqual(err.text(), `${DEPLOY_STDERR[0]}\n`);

    output.printRetained();
    const dump = err.text().slice(`${DEPLOY_STDERR[0]}\n`.length);
    assert.match(dump, /^\n──── cdk deploy output \(6 lines, retained because BLOCKS_LOG_LEVEL=normal\) ────\n/);
    for (const line of [...DEPLOY_STDOUT, ...DEPLOY_STDERR]) assert.ok(dump.includes(`${line}\n`), line);
    assert.ok(dump.endsWith('──── end of cdk deploy output ────\n'));
  });

  it('at quiet, shows nothing while a failing child runs, then dumps it', { timeout: 30_000 }, async () => {
    const out = collectingSink();
    const err = collectingSink();
    const output = createCdkOutput({ label: 'cdk destroy', verb: 'destroy', level: 'quiet', stdout: out, stderr: err });
    const args = fakeCdk(['chatter one', 'Stack | 1 | t | DELETE_FAILED | AWS::S3::Bucket | B'], ['Error: bucket not empty'], 3);
    await assert.rejects(Promise.resolve(output.run(process.execPath, args)), (e: Error) => {
      assert.strictEqual(e.message, `${process.execPath} ${args.join(' ')} exited with code 3`);
      return true;
    });
    assert.strictEqual(out.text(), '');
    assert.strictEqual(err.text(), '');
    output.printRetained();
    assert.strictEqual(
      err.text(),
      '\n──── cdk destroy output (3 lines, retained because BLOCKS_LOG_LEVEL=quiet) ────\n' +
        'chatter one\nStack | 1 | t | DELETE_FAILED | AWS::S3::Bucket | B\nError: bucket not empty\n' +
        '──── end of cdk destroy output ────\n',
    );
    output.printRetained();
    assert.ok(err.text().endsWith('──── end of cdk destroy output ────\n'), 'a second dump prints nothing new');
  });

  it('at quiet, a successful run prints nothing at all', { timeout: 30_000 }, async () => {
    const out = collectingSink();
    const err = collectingSink();
    const output = createCdkOutput({ label: 'cdk synth', level: 'quiet', stdout: out, stderr: err });
    await output.run(process.execPath, fakeCdk(['a', 'b'], ['c'], 0));
    assert.strictEqual(out.text() + err.text(), '');
  });

  it('lastRunOutput returns only the most recent run’s retained lines, and none once dumped', { timeout: 30_000 }, async () => {
    const err = collectingSink();
    const output = createCdkOutput({ label: 'cdk destroy', level: 'quiet', stdout: collectingSink(), stderr: err, retainLines: 3 });
    assert.deepStrictEqual(output.lastRunOutput(), []);
    await assert.rejects(Promise.resolve(output.run(process.execPath, fakeCdk(['first a', 'first b'], [], 1))));
    assert.deepStrictEqual(output.lastRunOutput(), ['first a', 'first b']);
    // The second run's lines only, even while the ring still holds the first run's.
    await assert.rejects(Promise.resolve(output.run(process.execPath, fakeCdk(['second'], [], 1))));
    assert.deepStrictEqual(output.lastRunOutput(), ['second']);
    // A run longer than the ring: what the ring still holds.
    await assert.rejects(Promise.resolve(output.run(process.execPath, fakeCdk(['1', '2', '3', '4'], [], 1))));
    assert.deepStrictEqual(output.lastRunOutput(), ['2', '3', '4']);
    output.printRetained();
    assert.deepStrictEqual(output.lastRunOutput(), []);
    assert.deepStrictEqual(createCdkOutput({ label: 'x', level: 'legacy' }).lastRunOutput(), []);
  });
});

describe('attachCdkWatchOutput', () => {
  function fakeWatch(): ChildProcess & { out: PassThrough; err: PassThrough } {
    const out = new PassThrough();
    const err = new PassThrough();
    return Object.assign(new EventEmitter(), { stdout: out, stderr: err, out, err }) as unknown as ChildProcess & {
      out: PassThrough;
      err: PassThrough;
    };
  }
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  function captureConsole(): Array<[string, string]> {
    const calls: Array<[string, string]> = [];
    mock.method(console, 'log', (...a: unknown[]) => calls.push(['log', a.join(' ')]));
    mock.method(console, 'error', (...a: unknown[]) => calls.push(['error', a.join(' ')]));
    return calls;
  }

  it('with BLOCKS_LOG_LEVEL unset, keeps the original chunk relay', async () => {
    const calls = captureConsole();
    const child = fakeWatch();
    attachCdkWatchOutput(child, { level: 'legacy' });
    child.out.write('  Detected change to app.ts\nchatter  \n');
    child.out.write('2024 [START RequestId: abc] Version: $LATEST');
    child.err.write('warn line\n');
    await tick();
    assert.deepStrictEqual(calls, [
      ['log', '[CDK Watch] Detected change to app.ts\nchatter'],
      ['error', '[CDK Watch] warn line'],
    ]);
  });

  it('at normal, shows progress and failures, and dumps the retained lines when a watch deploy fails', async () => {
    const calls = captureConsole();
    const err = collectingSink();
    const child = fakeWatch();
    attachCdkWatchOutput(child, { level: 'normal', stderr: err });
    child.out.write('Detected change to cdk-blocks/index.ts\nbundling chatter\n');
    child.out.write('[START RequestId: abc] Version: $LATEST\n');
    child.err.write('❌ Deployment failed: Error: Resource handler returned message: boom\n');
    await tick();
    assert.deepStrictEqual(calls, [
      ['log', '[CDK Watch] Detected change to cdk-blocks/index.ts'],
      ['error', '[CDK Watch] ❌ Deployment failed: Error: Resource handler returned message: boom'],
    ]);
    assert.match(err.text(), /──── cdk watch output \(3 lines, retained because BLOCKS_LOG_LEVEL=normal\) ────/);
    assert.ok(err.text().includes('bundling chatter\n'));
    assert.ok(!err.text().includes('RequestId'), 'Lambda platform lines are never kept');
  });

  it('at normal, prints a synth warning a watch deploy raises, once, unless the initial deploy already printed it', async () => {
    const calls = captureConsole();
    const child = fakeWatch();
    const printedWarnings = new Set(['WARNING Already printed.\n   app/Old']);
    attachCdkWatchOutput(child, { level: 'normal', stderr: collectingSink(), printedWarnings });
    const fresh = 'cdk-blocks/index.cdk.ts:33:3\nWARNING Plain HTTP front door.\n   app-sandbox/Hosting/Hosting\n';
    child.err.write(`Detected change to cdk-blocks/index.cdk.ts\n${fresh}WARNING Already printed.\n   app/Old\n\n`);
    child.err.write(`${fresh}\n`);
    await tick();
    child.out.end();
    child.err.end();
    await tick();
    assert.deepStrictEqual(calls, [
      ['error', '[CDK Watch] Detected change to cdk-blocks/index.cdk.ts'],
      ['error', '[CDK Watch] cdk-blocks/index.cdk.ts:33:3'],
      ['error', '[CDK Watch] WARNING Plain HTTP front door.'],
      ['error', '[CDK Watch]    app-sandbox/Hosting/Hosting'],
    ]);
  });

  it('at normal, ends a warning at a `❌` failure line and still prints the failure and dumps the retained lines', async () => {
    const calls = captureConsole();
    const err = collectingSink();
    const child = fakeWatch();
    attachCdkWatchOutput(child, { level: 'normal', stderr: err });
    child.err.write('WARNING Plain HTTP front door.\n   app-sandbox/error-pages/Hosting\n');
    child.err.write(' ❌  app-sandbox failed: Error: boom\n');
    await tick();
    assert.deepStrictEqual(calls, [
      ['error', '[CDK Watch] WARNING Plain HTTP front door.'],
      ['error', '[CDK Watch]    app-sandbox/error-pages/Hosting'],
      ['error', '[CDK Watch] ❌  app-sandbox failed: Error: boom'],
    ]);
    assert.match(err.text(), /──── cdk watch output \(3 lines, retained because BLOCKS_LOG_LEVEL=normal\) ────/);
    assert.ok(err.text().includes(' ❌  app-sandbox failed: Error: boom\n'));
  });

  it('at quiet, prints nothing until cdk watch exits non-zero, and not when the sandbox is stopping', async () => {
    const calls = captureConsole();
    const err = collectingSink();
    let stopping = false;
    const child = fakeWatch();
    attachCdkWatchOutput(child, { level: 'quiet', stderr: err, stopping: () => stopping });
    child.out.write('Detected change\nhotswapping Lambda\n');
    await tick();
    assert.deepStrictEqual(calls, []);
    child.emit('exit', 1, null);
    assert.match(err.text(), /cdk watch output \(2 lines/);
    child.out.write('more\n');
    await tick();
    stopping = true;
    const before = err.text();
    child.emit('exit', null, 'SIGTERM');
    assert.strictEqual(err.text(), before);
  });
});

describe('attachCdkWatchOutput — synth failure inside watch', () => {
  /** Emulates `cdk watch`: CDK swallows a synth failure (no ❌) and keeps watching. */
  function fakeWatch(): ChildProcess & { out: PassThrough; err: PassThrough } {
    const out = new PassThrough();
    const err = new PassThrough();
    return Object.assign(new EventEmitter(), { stdout: out, stderr: err, out, err }) as unknown as ChildProcess & {
      out: PassThrough;
      err: PassThrough;
    };
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const SYNTH_CRASH = [
    "Detected change to 'cdk-blocks/index.ts' (type: change). Triggering 'cdk deploy'",
    '/app/cdk-blocks/index.ts:3',
    'SyntaxError: Unexpected token }',
  ];

  it('classifies compound JS error names as failure lines', async () => {
    const { isCdkFailureLine } = await import('./cdk-output.js');
    assert.ok(isCdkFailureLine('SyntaxError: Unexpected token }'));
    assert.ok(isCdkFailureLine('TypeError: x is not a function'));
    assert.ok(!isCdkFailureLine('Detected change to errors.ts'));
  });

  it('at quiet, dumps the failed cycle once output goes idle', async () => {
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    const err = collectingSink();
    const child = fakeWatch();
    attachCdkWatchOutput(child, { level: 'quiet', stderr: err, failureIdleMs: 20 });
    child.err.write(SYNTH_CRASH.join('\n') + '\n');
    await sleep(5);
    assert.strictEqual(err.text(), '', 'not before the idle window');
    await sleep(60);
    assert.match(err.text(), /cdk watch output \(3 lines, retained because BLOCKS_LOG_LEVEL=quiet\)/);
    assert.ok(err.text().includes('SyntaxError: Unexpected token }\n'));
  });

  it('at normal, shows the error line and dumps when the next cycle starts', async () => {
    const calls: string[] = [];
    mock.method(console, 'log', (...a: unknown[]) => calls.push(a.join(' ')));
    mock.method(console, 'error', (...a: unknown[]) => calls.push(a.join(' ')));
    const err = collectingSink();
    const child = fakeWatch();
    attachCdkWatchOutput(child, { level: 'normal', stderr: err, failureIdleMs: 60_000 });
    child.err.write(SYNTH_CRASH.join('\n') + '\n');
    await sleep(5);
    assert.ok(calls.includes('[CDK Watch] SyntaxError: Unexpected token }'));
    assert.strictEqual(err.text(), '');
    child.out.write("Detected change to 'cdk-blocks/index.ts' (type: change). Triggering 'cdk deploy'\n");
    await sleep(5);
    assert.match(err.text(), /cdk watch output \(3 lines/);
    child.emit('exit', null, 'SIGTERM');
  });

  it('does not dump a cycle that succeeds after an error-looking line', async () => {
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    const err = collectingSink();
    const child = fakeWatch();
    attachCdkWatchOutput(child, { level: 'quiet', stderr: err, failureIdleMs: 20 });
    child.out.write("Detected change to 'a.ts'\nwarning: TypeError in a test fixture\n ✅  MyStack\n");
    await sleep(60);
    assert.strictEqual(err.text(), '');
  });

  for (const file of ['error-handler.ts', 'HttpError.ts']) {
    it(`does not dump a successful cycle for a file named like an error (${file})`, async () => {
      mock.method(console, 'log', () => {});
      mock.method(console, 'error', () => {});
      const err = collectingSink();
      const child = fakeWatch();
      attachCdkWatchOutput(child, { level: 'quiet', stderr: err, failureIdleMs: 20 });
      child.out.write(`Detected change to 'cdk-blocks/${file}' (type: change). Triggering 'cdk deploy'\n`);
      // A real hotswap is silent for seconds before its ✅; well past the idle window.
      await sleep(60);
      child.out.write(' ✅  MyStack\n');
      await sleep(5);
      assert.strictEqual(err.text(), '');
    });
  }

  for (const [kind, line] of [
    ['file', "'watch' is observing the file 'src/app/error.tsx' for changes"],
    ['directory', "'watch' is observing directory 'src/routes/error-demo' for changes"],
  ]) {
    for (const level of ['quiet', 'normal'] as const) {
      it(`does not treat the observing line for a ${kind} as a failure (${level})`, async () => {
        const logs: string[] = [];
        mock.method(console, 'log', (m: string) => logs.push(m));
        mock.method(console, 'error', (m: string) => logs.push(m));
        const err = collectingSink();
        const child = fakeWatch();
        attachCdkWatchOutput(child, { level, stderr: err, failureIdleMs: 20 });
        child.out.write(`${line}\nTriggering initial 'cdk deploy'\n`);
        await sleep(60);
        child.out.write(' ✅  MyStack\n');
        await sleep(5);
        assert.strictEqual(err.text(), '');
        assert.ok(!logs.some((m) => m.includes('observing')));
        child.emit('exit', null, 'SIGTERM');
      });
    }
  }

  it('does not treat a queued change during a failed cycle as a new cycle', async () => {
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    const err = collectingSink();
    const child = fakeWatch();
    attachCdkWatchOutput(child, { level: 'quiet', stderr: err, failureIdleMs: 40 });
    child.err.write(SYNTH_CRASH.join('\n') + '\n');
    await sleep(5);
    child.out.write(
      "Detected change to 'cdk-blocks/HttpError.ts' (type: change) while 'cdk deploy' is still running. Will queue for another deployment after this one finishes\n",
    );
    await sleep(5);
    assert.strictEqual(err.text(), '', 'a queued change does not dump early');
    await sleep(80);
    assert.match(err.text(), /cdk watch output \(4 lines/);
  });
});

describe('createCdkOutput — a descendant holding the pipes', { skip: process.platform === 'win32' ? 'POSIX shell' : false }, () => {
  it('at quiet, lets the process exit promptly after the command finishes', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-cdk-pipes-'));
    try {
      const harness = join(dir, 'harness.mjs');
      writeFileSync(
        harness,
        `const { createCdkOutput } = await import(${JSON.stringify(new URL('./cdk-output.js', import.meta.url).href)});
await createCdkOutput({ label: 'cdk synth', level: 'quiet' }).run('sh', ['-c', 'echo synth-done; (sleep 15 &); exit 0']);`,
      );
      const started = Date.now();
      const r = spawnSync(process.execPath, [harness], { encoding: 'utf-8', timeout: 20_000 });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(Date.now() - started < 8000, `exited after ${Date.now() - started}ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runDestroyWithRetries failure dump', () => {
  it('prints the retained output once, just before the final failure, and never on a recovered retry', async () => {
    const events: string[] = [];
    mock.method(console, 'error', (...a: unknown[]) => events.push(a.join(' ')));
    mock.method(console, 'log', () => {});
    let attempts = 0;
    const deps = {
      runDestroy: async () => {
        attempts++;
        throw new Error('cdk destroy failed');
      },
      printRetainedOutput: () => events.push('DUMP'),
      listStacks: () => [],
      emptyBuckets: async () => {},
      sleep: async () => {},
      retryDelays: [0],
    };
    await assert.rejects(runDestroyWithRetries(deps), /cdk destroy failed/);
    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(events, ['DUMP', '\n❌ Destroy failed after retries.']);

    events.length = 0;
    let first = true;
    await runDestroyWithRetries({
      ...deps,
      runDestroy: () => {
        if (first) {
          first = false;
          throw new Error('transient');
        }
      },
    });
    assert.deepStrictEqual(events, []);
  });

  it('stops at once, with no retry, when an operator aborted the destroy', async () => {
    mock.method(console, 'error', () => {});
    mock.method(console, 'log', () => {});
    let attempts = 0;
    const aborted = new DeployProcessError('aborted', { aborted: true, operatorSignal: 'SIGTERM' });
    await assert.rejects(
      runDestroyWithRetries({
        runDestroy: async () => {
          attempts++;
          throw aborted;
        },
        listStacks: () => [],
        emptyBuckets: async () => {},
        sleep: async () => {},
        retryDelays: [0, 0],
      }),
      (error: unknown) => error === aborted,
    );
    assert.strictEqual(attempts, 1);
  });
});

describe('createCdkOutput — deferSignals (a real cdk tree)', { skip: process.platform === 'win32' ? 'POSIX signals' : false }, () => {
  // The sandbox deploy and destroy ran cdk with no signal handling: one SIGTERM (the task runner forwards
  // it at once) killed the runner and left cdk running, unwatched (JA-2).
  it('defers a first SIGTERM, and on a second one stops the whole cdk tree and reports the operator signal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdk-defer-'));
    let cdk = 0;
    let run: ChildProcess | undefined;
    try {
      const pidFile = join(dir, 'cdk.pid');
      // A real process that only waits to be signalled (this test drives real POSIX signals, not a clock).
      const grandchild = join(dir, 'cdk.cjs');
      writeFileSync(grandchild, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
      const harness =
        `const { createCdkOutput } = await import(${JSON.stringify(new URL('./cdk-output.js', import.meta.url).href)});\n` +
        "const out = createCdkOutput({ label: 'cdk deploy', verb: 'deploy', level: 'verbose' });\n" +
        // The shell plays npx/npm: the cdk process is a grandchild, as in the real tree.
        // The paths reach the shell as its positional args, never inside the script, so nothing needs quoting.
        `try { await out.run('/bin/sh', ['-c', '"$0" "$1"', ${JSON.stringify(process.execPath)}, ${JSON.stringify(grandchild)}], { deferSignals: true }); console.log('DONE'); }\n` +
        "catch (e) { console.log('ABORTED ' + JSON.stringify({ aborted: e.aborted, operatorSignal: e.operatorSignal })); process.exitCode = 3; }\n";
      run = spawn(process.execPath, ['--input-type=module', '-e', harness], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      run.stdout?.on('data', (d) => { stdout += d; });
      const exited = new Promise<number | null>((resolve) => run?.once('exit', (code) => resolve(code)));
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const until = async (what: string, check: () => boolean, ms = 10_000) => {
        for (const deadline = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 25))) {
          if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; stdout: ${stdout}`);
        }
      };
      await until('cdk to start', () => existsSync(pidFile) && readFileSync(pidFile, 'utf-8') !== '');
      cdk = Number(readFileSync(pidFile, 'utf-8'));
      run.kill('SIGTERM');
      await until('the deferral notice', () => stdout.includes('Ignoring SIGTERM: the deploy is still running'));
      assert.ok(alive(run.pid ?? 0) && alive(cdk), `a lone SIGTERM stops neither the runner nor cdk; stdout: ${stdout}`);
      // A real wait: a SIGTERM inside the 2 s coalesce window counts as the same delivery, not a repeat.
      await new Promise((r) => setTimeout(r, 2300));
      run.kill('SIGTERM');
      assert.strictEqual(await exited, 3, stdout);
      assert.match(stdout, /ABORTED \{"aborted":true,"operatorSignal":"SIGTERM"\}/);
      await until('cdk to be stopped', () => !alive(cdk));
    } finally {
      // Without the fix, cdk outlives the runner and holds its pipe: reap what is left, so the run ends.
      for (const pid of [run?.pid, cdk]) {
        try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
      run?.stdout?.destroy();
      run?.stderr?.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('destroy output end to end (fake cdk on PATH)', { skip: process.platform === 'win32' ? 'POSIX shell fake' : false }, () => {
  const OUT = ['Stack | 0 | 10:00:00 AM | DELETE_IN_PROGRESS | AWS::CloudFormation::Stack | Stack User Initiated', 'Some CDK chatter line'];
  const ERR = [
    'Stack | 1 | 10:00:05 AM | DELETE_FAILED | AWS::S3::Bucket | Bucket The bucket you tried to delete is not empty',
    '❌  Stack: destroy failed Error: The stack named Stack is in a failed state',
  ];

  /** Run production destroy (two attempts, both failing) in a child process at `level`. */
  function runDestroy(level: string | undefined): { stdout: string; stderr: string; status: number | null } {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-log-level-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const npx = join(bin, 'npx');
      writeFileSync(
        npx,
        [
          '#!/bin/sh',
          'if [ "$2" = "ls" ]; then exit 0; fi',
          ...OUT.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`),
          ...ERR.map((l) => `printf '%s\\n' ${JSON.stringify(l)} >&2`),
          'exit 1',
          '',
        ].join('\n'),
      );
      chmodSync(npx, 0o755);
      const harness = join(dir, 'harness.mjs');
      // A separate process, so its real stdout/stderr bytes (inherited by the
      // fake cdk) can be captured; it imports this build's modules by absolute
      // URL, known only at run time.
      writeFileSync(
        harness,
        `const { productionDestroyDeps } = await import(${JSON.stringify(new URL('./destroy.js', import.meta.url).href)});
const { runDestroyWithRetries } = await import(${JSON.stringify(new URL('./sandbox.js', import.meta.url).href)});
const deps = productionDestroyDeps({ cdkAppPath: '', projectRoot: process.cwd() }, process.env);
try { await runDestroyWithRetries({ ...deps, sleep: async () => {}, retryDelays: [0] }); } catch { process.exitCode = 3; }
`,
      );
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, NODE_OPTIONS: '' };
      delete env.BLOCKS_LOG_LEVEL;
      if (level !== undefined) env.BLOCKS_LOG_LEVEL = level;
      const r = spawnSync(process.execPath, [harness], { cwd: dir, env, encoding: 'utf-8', timeout: 60_000 });
      return { stdout: r.stdout, stderr: r.stderr, status: r.status };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const attemptOut = `${OUT.join('\n')}\n`;
  const attemptErr = `${ERR.join('\n')}\n`;
  const LEGACY_STDOUT = `${attemptOut}\n⏳ Stack deletion failed. Retrying in 0s (waiting for resource cleanup)...\n${attemptOut}`;
  const LEGACY_STDERR = `${attemptErr}${attemptErr}\n❌ Destroy failed after retries.\n`;

  it('is byte-for-byte unchanged with BLOCKS_LOG_LEVEL unset (inherited stdio)', { timeout: 60_000 }, () => {
    const r = runDestroy(undefined);
    assert.strictEqual(r.status, 3);
    assert.strictEqual(r.stdout, LEGACY_STDOUT);
    assert.strictEqual(r.stderr, LEGACY_STDERR);
  });

  it('is the same as legacy at verbose and for an unrecognised value', { timeout: 60_000 }, () => {
    for (const level of ['verbose', 'bogus']) {
      const r = runDestroy(level);
      assert.strictEqual(r.stdout, LEGACY_STDOUT, level);
      assert.strictEqual(r.stderr, LEGACY_STDERR, level);
    }
  });

  it('at quiet, hides everything but the failure, then dumps both attempts before the error', { timeout: 60_000 }, () => {
    const r = runDestroy('quiet');
    assert.strictEqual(r.status, 3);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(
      r.stderr,
      '\n──── cdk destroy output (8 lines, retained because BLOCKS_LOG_LEVEL=quiet) ────\n' +
        `${attemptOut}${attemptErr}${attemptOut}${attemptErr}` +
        '──── end of cdk destroy output ────\n' +
        '\n❌ Destroy failed after retries.\n',
    );
  });

  it('at normal, shows milestones and failure lines, hides chatter, and dumps on failure', { timeout: 60_000 }, () => {
    const r = runDestroy('normal');
    assert.strictEqual(r.status, 3);
    assert.strictEqual(
      r.stdout,
      '   CloudFormation: removing changes\n\n⏳ Stack deletion failed. Retrying in 0s (waiting for resource cleanup)...\n',
    );
    assert.ok(r.stderr.startsWith(`${attemptErr}${attemptErr}\n──── cdk destroy output (8 lines`), r.stderr);
    assert.ok(r.stderr.includes('Some CDK chatter line\n'), 'chatter is retained for the dump');
    assert.ok(r.stderr.endsWith('──── end of cdk destroy output ────\n\n❌ Destroy failed after retries.\n'));
  });
});
