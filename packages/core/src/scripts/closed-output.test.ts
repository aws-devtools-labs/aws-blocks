// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ignoreClosedOutput } from './log.js';
import { stopSandboxProcesses } from './sandbox.js';
import type { AwaitableChild } from './process-tree.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hasScript = process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;

/**
 * A script that, once its output reader is gone, keeps logging the way a
 * runner's cleanup does, then records that it survived. `guarded` installs
 * {@link ignoreClosedOutput} first.
 */
function writeProbe(dir: string, guarded: boolean): { probe: string; marker: string } {
  const marker = join(dir, 'marker.txt');
  const probe = join(dir, 'probe.mjs');
  writeFileSync(
    probe,
    `
import { appendFileSync } from 'node:fs';
import { ignoreClosedOutput } from ${JSON.stringify(pathToFileURL(join(__dirname, 'log.js')).href)};
${guarded ? 'ignoreClosedOutput();' : ''}
process.on('SIGHUP', () => console.error('Ignoring SIGHUP'));
process.on('exit', (code) => appendFileSync(${JSON.stringify(marker)}, 'exit ' + code + '\\n'));
appendFileSync(${JSON.stringify(marker)}, 'started\\n');
let ticks = 0;
const timer = setInterval(() => {
  console.log('tick ' + ticks);
  console.error('tick ' + ticks);
  if (++ticks === 20) {
    clearInterval(timer);
    appendFileSync(${JSON.stringify(marker)}, 'survived\\n');
  }
}, 50);
`,
  );
  return { probe, marker };
}

async function runWithClosedPipes(guarded: boolean): Promise<{ code: number | null; marker: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'closed-output-'));
  try {
    const { probe, marker } = writeProbe(dir, guarded);
    const child = spawn(process.execPath, [probe], { stdio: ['ignore', 'pipe', 'pipe'] });
    // The reader goes away at once, as `tee` does on the Ctrl-C that also reaches the runner.
    child.stdout.destroy();
    child.stderr.destroy();
    const [code] = (await once(child, 'exit')) as [number | null];
    return { code, marker: readFileSync(marker, 'utf-8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runWithHungUpTerminal(guarded: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'closed-output-'));
  try {
    const { probe, marker } = writeProbe(dir, guarded);
    const quoted = `'${process.execPath.replace(/'/g, "'\\''")}' '${probe.replace(/'/g, "'\\''")}'`;
    const pty = spawn('script', ['-qfec', quoted, '/dev/null'], { stdio: ['ignore', 'ignore', 'ignore'] });
    // The probe runs under the pty, not as our child: watch its marker file. A
    // short poll is the only signal across the pty boundary.
    const markerHas = async (text: string): Promise<string> => {
      for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
        let body = '';
        try { body = readFileSync(marker, 'utf-8'); } catch { /* not written yet */ }
        if (body.includes(text)) return body;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail(`the probe never wrote ${JSON.stringify(text)}`);
    };
    await markerHas('started');
    // Close the terminal: the probe gets SIGHUP, and its next writes fail with EIO.
    pty.kill('SIGKILL');
    return await markerHas('exit ');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ignoreClosedOutput', () => {
  it('keeps the process running when stdout and stderr are closed pipes (EPIPE)', async () => {
    const guarded = await runWithClosedPipes(true);
    assert.strictEqual(guarded.code, 0);
    assert.match(guarded.marker, /survived/);
    // Control: without it, the first write to the closed pipe kills the process.
    const unguarded = await runWithClosedPipes(false);
    assert.notStrictEqual(unguarded.code, 0);
    assert.doesNotMatch(unguarded.marker, /survived/);
  });

  it('keeps the process running after its terminal hangs up (EIO)', { skip: !hasScript && 'needs util-linux script' }, async () => {
    assert.match(await runWithHungUpTerminal(true), /survived/);
    assert.doesNotMatch(await runWithHungUpTerminal(false), /survived/);
  });

  it('rethrows any other stream error, and installs one listener per stream', () => {
    const stream = new EventEmitter();
    ignoreClosedOutput([stream]);
    ignoreClosedOutput([stream]);
    assert.strictEqual(stream.listenerCount('error'), 1);
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.throws(
      () => stream.emit('error', Object.assign(new Error('bad fd'), { code: 'EBADF' })),
      /bad fd/,
    );
  });
});

describe('stopSandboxProcesses', () => {
  it('reaps both watch processes before it prints anything', async () => {
    const events: string[] = [];
    const cdkWatch = { pid: 101 } as AwaitableChild;
    const devServer = { pid: 102 } as AwaitableChild;
    await stopSandboxProcesses(
      { cdkWatch, devServer },
      async (child, graceMs) => {
        events.push(`terminate ${child.pid} ${graceMs}`);
        await Promise.resolve(); // reaping is asynchronous
        events.push(`reaped ${child.pid}`);
      },
      () => events.push('report'),
    );
    assert.deepStrictEqual(events.slice(0, 2).sort(), ['terminate 101 2000', 'terminate 102 6000']);
    assert.strictEqual(events.at(-1), 'report');
    assert.strictEqual(events.indexOf('report'), 4, 'the report comes after both reaps');
  });
});
