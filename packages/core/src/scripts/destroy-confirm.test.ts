// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { S3Client } from '@aws-sdk/client-s3';
import { type DestroyPrompt, isYes, runProductionDestroy, terminalPrompt } from './destroy.js';

// `npm run destroy` asks before it deletes several top-level stacks, but only
// when someone can answer (stdin and stderr are terminals) and the caller did
// not pass `force`. Every other run (CI, scripts, a single-stack app) deletes
// with `cdk destroy --all --force` as before. The fake `npx` records each CDK
// command and, like CDK, writes a manifest with FAKE_STACKS top-level stacks
// into the `--output` directory. POSIX shell script, so skipped on Windows.

const skip = process.platform === 'win32';
let root: string;
let bin: string;
let log: string;
let projectRoot: string;

before(() => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'bb-destroy-confirm-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  log = join(root, 'cdk.log');
  const manifest =
    'n=$FAKE_STACKS; [ -z "$n" ] && n=1; i=1; arts=; while [ $i -le $n ]; do ' +
    '[ -n "$arts" ] && arts="$arts,"; ' +
    'arts="$arts\\"s$i\\":{\\"type\\":\\"aws:cloudformation:stack\\",\\"environment\\":\\"aws://000000000000/us-east-1\\",\\"properties\\":{\\"stackName\\":\\"stack-$i\\"}}"; ' +
    'i=$((i+1)); done; /bin/mkdir -p "$a"; echo "{\\"version\\":\\"22.0.0\\",\\"artifacts\\":{$arts}}" > "$a/manifest.json"';
  writeFileSync(
    join(bin, 'npx'),
    `#!/bin/sh\necho "$*" >> "${log}"\n` +
      `prev=\nfor a in "$@"; do if [ "$prev" = --output ]; then ${manifest}; fi; prev=$a; done\n` +
      // FAKE_FAIL_FIRST_DESTROY: the first `cdk destroy` exits 1, later ones succeed.
      `case "$*" in *" destroy "*) if [ -n "$FAKE_FAIL_FIRST_DESTROY" ] && [ ! -e "${root}/failed-once" ]; then ` +
      `: > "${root}/failed-once"; exit 1; fi;; esac\nexit 0\n`,
  );
  chmodSync(join(bin, 'npx'), 0o755);
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  if (skip) return;
  rmSync(log, { force: true });
  rmSync(join(root, 'failed-once'), { force: true });
  projectRoot = mkdtempSync(join(root, 'project-'));
});

/** Clients whose every call fails as "does not exist": the retry's AWS checks find nothing. */
const clients = {
  cfnFor: () =>
    ({
      send: async () => {
        throw new Error('Stack does not exist');
      },
    }) as unknown as CloudFormationClient,
  s3: { send: async () => ({}) } as unknown as S3Client,
};

function prompt(isTTY: boolean, answer: boolean) {
  const questions: string[] = [];
  const p: DestroyPrompt = {
    isTTY,
    ask: async (question) => {
      questions.push(question);
      return answer;
    },
  };
  return { p, questions };
}

/** Run `runProductionDestroy` with the fake CDK; returns the CDK commands it ran and the console output. */
async function run(
  p: DestroyPrompt,
  { stacks, force, failFirst }: { stacks: number; force?: boolean; failFirst?: boolean },
): Promise<{ commands: string[]; out: string; result: string }> {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => {
    lines.push(a.join(' '));
  };
  let result: string;
  try {
    result = await runProductionDestroy(
      { cdkAppPath: join(projectRoot, 'index.cdk.ts'), projectRoot, force },
      { PATH: `${bin}:/usr/bin:/bin`, FAKE_STACKS: String(stacks), FAKE_FAIL_FIRST_DESTROY: failFirst ? '1' : '' },
      clients,
      p,
      { sleep: async () => {} },
    );
  } finally {
    Object.assign(console, orig);
  }
  const commands = existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [];
  return { commands, out: lines.join('\n'), result };
}

const isDestroy = (c: string) => c.startsWith('cdk destroy ');
const isSynth = (c: string) => c.startsWith('cdk synth ');

describe('npm run destroy asks before deleting several stacks, on a terminal only', { skip }, () => {
  it('on a terminal with several top-level stacks: lists them, asks once, then deletes with --force', async () => {
    const { p, questions } = prompt(true, true);
    const { commands, out, result } = await run(p, { stacks: 2 });
    assert.strictEqual(result, 'destroyed');
    assert.strictEqual(questions.length, 1);
    assert.match(questions[0], /stack-1 \(us-east-1\)/);
    assert.match(questions[0], /stack-2 \(us-east-1\)/);
    assert.ok(isSynth(commands[0]), `synthesizes first: ${commands.join(' | ')}`);
    assert.match(commands[0], /--output \.blocks-sandbox\/destroy\.out/);
    // Same projectRoot context as the destroy, so the listed stacks are the app's production stacks.
    assert.ok(commands[0].includes(`--context projectRoot=${projectRoot}`), commands[0]);
    assert.strictEqual(commands.filter(isDestroy).length, 1);
    assert.match(commands.filter(isDestroy)[0], /--all --force/);
    // ...and it deletes from the assembly it listed, without building the app again.
    assert.match(commands.filter(isDestroy)[0], /--app \.blocks-sandbox\/destroy\.out(\s|$)/);
    assert.match(out, /Production stacks destroyed!/);
    assert.ok(!existsSync(join(projectRoot, '.blocks-sandbox', 'destroy.out')));
  });

  it('a declined prompt deletes nothing: no destroy, no retry, no success message, the assembly is removed', async () => {
    const { p, questions } = prompt(true, false);
    const { commands, out, result } = await run(p, { stacks: 2 });
    // Reported to `destroy`, which exits 1, so `npm run destroy && ...` stops.
    assert.strictEqual(result, 'cancelled');
    assert.strictEqual(questions.length, 1);
    assert.deepStrictEqual(commands.filter(isDestroy), []);
    assert.doesNotMatch(out, /destroyed/);
    assert.doesNotMatch(out, /Emptying/);
    assert.match(out, /cancelled/i);
    assert.ok(!existsSync(join(projectRoot, '.blocks-sandbox', 'destroy.out')));
  });

  it('once confirmed, a retry is not asked again and keeps --force', async () => {
    const { p, questions } = prompt(true, true);
    const { commands, out } = await run(p, { stacks: 2, failFirst: true });
    assert.strictEqual(questions.length, 1);
    const destroys = commands.filter(isDestroy);
    assert.strictEqual(destroys.length, 2, commands.join(' | '));
    for (const d of destroys) assert.match(d, /--all --force/);
    assert.match(out, /Production stacks destroyed on retry!/);
  });

  it('asks when the stacks cannot be read (fails closed)', async () => {
    const { p, questions } = prompt(true, false);
    const { commands } = await run(p, { stacks: 0 });
    assert.strictEqual(questions.length, 1);
    assert.match(questions[0], /Could not list the stacks/);
    assert.deepStrictEqual(commands.filter(isDestroy), []);
  });

  it('a yes when the stacks cannot be read deletes by synthesizing the app again, not from the unreadable assembly', async () => {
    const { p } = prompt(true, true);
    const { commands } = await run(p, { stacks: 0 });
    const destroys = commands.filter(isDestroy);
    assert.strictEqual(destroys.length, 1);
    assert.match(destroys[0], /--all --force/);
    assert.doesNotMatch(destroys[0], /--app/);
  });

  it('on a terminal with one top-level stack: no question, deletes with --force as before', async () => {
    const { p, questions } = prompt(true, false);
    const { commands, out } = await run(p, { stacks: 1 });
    assert.strictEqual(questions.length, 0);
    assert.strictEqual(commands.filter(isDestroy).length, 1);
    assert.match(commands.filter(isDestroy)[0], /--all --force/);
    assert.match(out, /Production stacks destroyed!/);
  });

  it('without a terminal (CI, scripts): no synth, no question, deletes with --force', async () => {
    const { p, questions } = prompt(false, false);
    const { commands, result } = await run(p, { stacks: 2 });
    assert.strictEqual(result, 'destroyed');
    assert.strictEqual(questions.length, 0);
    assert.deepStrictEqual(commands.filter(isSynth), []);
    assert.strictEqual(commands.length, 1);
    assert.match(commands[0], /^cdk destroy --all --force/);
    assert.doesNotMatch(commands[0], /--app/);
  });

  it('with force: true on a terminal: no synth, no question, deletes with --force', async () => {
    const { p, questions } = prompt(true, false);
    const { commands } = await run(p, { stacks: 2, force: true });
    assert.strictEqual(questions.length, 0);
    assert.deepStrictEqual(commands.filter(isSynth), []);
    assert.strictEqual(commands.length, 1);
    assert.match(commands[0], /^cdk destroy --all --force/);
  });
});

/** A stream that reports `isTTY` like a terminal (or not), for {@link terminalPrompt}. */
function stream(isTTY: boolean): PassThrough & { isTTY?: boolean } {
  return Object.assign(new PassThrough(), isTTY ? { isTTY: true } : {});
}

// The question is written to stderr, so `npm run destroy > log` (or `| tee`)
// still shows it on the terminal; and it is only asked when both stdin and
// stderr are terminals, so `2>&1 | tee log` never waits on a question that
// went into the file.
describe('terminalPrompt', () => {
  it('can ask only when both stdin and stderr are terminals', () => {
    assert.strictEqual(terminalPrompt({ input: stream(true), output: stream(true) }).isTTY, true);
    assert.strictEqual(terminalPrompt({ input: stream(true), output: stream(false) }).isTTY, false);
    assert.strictEqual(terminalPrompt({ input: stream(false), output: stream(true) }).isTTY, false);
  });

  it('defaults to stdin and stderr, never stdout', () => {
    const { isTTY: stdinTTY } = process.stdin;
    const { isTTY: stdoutTTY } = process.stdout;
    const { isTTY: stderrTTY } = process.stderr;
    try {
      Object.assign(process.stdin, { isTTY: true });
      Object.assign(process.stdout, { isTTY: true });
      Object.assign(process.stderr, { isTTY: undefined });
      assert.strictEqual(terminalPrompt().isTTY, false);
      Object.assign(process.stderr, { isTTY: true });
      Object.assign(process.stdout, { isTTY: undefined });
      assert.strictEqual(terminalPrompt().isTTY, true);
    } finally {
      Object.assign(process.stdin, { isTTY: stdinTTY });
      Object.assign(process.stdout, { isTTY: stdoutTTY });
      Object.assign(process.stderr, { isTTY: stderrTTY });
    }
  });

  it('writes the question to the output stream and reads the answer from the input stream', async () => {
    const input = stream(false);
    const output = stream(false);
    let written = '';
    output.on('data', (chunk) => {
      written += String(chunk);
    });
    const answer = terminalPrompt({ input, output }).ask('Delete them? (y/N) ');
    input.write('yes\n');
    assert.strictEqual(await answer, true);
    assert.match(written, /Delete them\? \(y\/N\) /);
  });

  it('a closed input (Ctrl-D) is a no', async () => {
    const input = stream(false);
    const answer = terminalPrompt({ input, output: stream(false) }).ask('Delete them? (y/N) ');
    input.end();
    assert.strictEqual(await answer, false);
  });
});

describe('isYes', () => {
  it('accepts y and yes in any case, with surrounding spaces', () => {
    for (const a of ['y', 'Y', 'yes', 'YES', ' Yes ']) assert.strictEqual(isYes(a), true, a);
  });

  it('treats everything else as no', () => {
    for (const a of ['', 'n', 'no', 'yep', 'yy', 'sure', 'y es', 'ok']) assert.strictEqual(isYes(a), false, a);
  });
});
