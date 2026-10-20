// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  createFrameworkSink,
  FRAMEWORK_SINK_ENV,
  readFrameworkSink,
  registerFrameworkFromSink,
  writeFrameworkSink,
} from './framework-sink.js';
import { Scope } from '../common/index.js';

describe('telemetry framework-sink (synth child -> parent bridge)', () => {
  const prev = process.env[FRAMEWORK_SINK_ENV];
  const prevDisable = process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
  afterEach(() => {
    if (prev === undefined) delete process.env[FRAMEWORK_SINK_ENV];
    else process.env[FRAMEWORK_SINK_ENV] = prev;
    if (prevDisable === undefined) delete process.env.AWS_BLOCKS_DISABLE_TELEMETRY;
    else process.env.AWS_BLOCKS_DISABLE_TELEMETRY = prevDisable;
  });

  it('round-trips the framework the child wrote back to the parent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-sink-'));
    const sink = join(dir, 'framework');
    try {
      process.env[FRAMEWORK_SINK_ENV] = sink;
      writeFrameworkSink('nextjs');
      assert.strictEqual(readFrameworkSink(sink), 'nextjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing when the parent set no sink path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-sink-'));
    const sink = join(dir, 'framework');
    try {
      delete process.env[FRAMEWORK_SINK_ENV];
      writeFrameworkSink('spa');
      assert.strictEqual(existsSync(sink), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads undefined from a sink the child never wrote', () => {
    assert.strictEqual(readFrameworkSink(join(tmpdir(), 'fw-sink-absent-xyz')), undefined);
  });

  it('writes nothing when the user opted out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-sink-'));
    const sink = join(dir, 'framework');
    try {
      process.env[FRAMEWORK_SINK_ENV] = sink;
      process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
      writeFrameworkSink('nextjs');
      assert.strictEqual(existsSync(sink), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the sink inside a fresh private directory, so the path cannot be pre-created', () => {
    const a = createFrameworkSink();
    const b = createFrameworkSink();
    assert.ok(a && b, 'expected a sink path');
    assert.notStrictEqual(dirname(a), dirname(b), 'each run must get its own directory');
    assert.strictEqual(statSync(dirname(a)).mode & 0o777, 0o700, 'directory must not be group/world accessible');
    assert.strictEqual(existsSync(a), false, 'the sink file itself is written by the child');
    rmSync(dirname(a), { recursive: true, force: true });
    rmSync(dirname(b), { recursive: true, force: true });
  });

  it('creates nothing at all when the user opted out', () => {
    process.env.AWS_BLOCKS_DISABLE_TELEMETRY = '1';
    const before = readdirSync(tmpdir()).filter((e) => e.startsWith('blocks-framework-')).length;

    assert.strictEqual(createFrameworkSink(), undefined);
    assert.strictEqual(
      readdirSync(tmpdir()).filter((e) => e.startsWith('blocks-framework-')).length,
      before,
      'an opted-out run must not create even an empty directory',
    );
  });

  it('removes the directory when the command exits without running its own cleanup', () => {
    // A thrown error is the abort shape a deploy hits most often; the exit hook has to
    // cover it, because registerFrameworkFromSink never runs on that path.
    // Specifier comes from import.meta.url, not cwd: the workspace test runs from
    // packages/core against dist, where a cwd-relative path would not resolve.
    const sinkModule = new URL('./framework-sink.js', import.meta.url).href;
    const script = [
      `import { createFrameworkSink } from ${JSON.stringify(sinkModule)};`,
      "process.stdout.write(createFrameworkSink() ?? '');",
      "throw new Error('simulated abort');",
    ].join('\n');
    // The child is expected to exit non-zero, which makes execFileSync throw; the
    // path it printed before aborting is on the error.
    let out = '';
    try {
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      out = String((error as { stdout?: string }).stdout ?? '');
    }

    assert.ok(out.length > 0, 'child should have reported a sink path');
    assert.strictEqual(existsSync(dirname(out)), false, 'exit hook must remove the directory');
  });

  it('refuses to write through a symlink pre-created at the sink path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-sink-'));
    const victim = join(dir, 'victim');
    const sink = join(dir, 'framework');
    try {
      symlinkSync(victim, sink);
      process.env[FRAMEWORK_SINK_ENV] = sink;
      writeFrameworkSink('nextjs');
      assert.strictEqual(existsSync(victim), false, 'O_EXCL must reject an existing path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the first framework when several constructs write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-sink-'));
    const sink = join(dir, 'framework');
    try {
      process.env[FRAMEWORK_SINK_ENV] = sink;
      writeFrameworkSink('nextjs');
      writeFrameworkSink('astro');
      assert.strictEqual(readFileSync(sink, 'utf-8'), 'nextjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers the framework and removes the sink directory', () => {
    Scope._resetRegistry();
    const sink = createFrameworkSink();
    assert.ok(sink, 'expected a sink path');
    process.env[FRAMEWORK_SINK_ENV] = sink;
    writeFrameworkSink('sveltekit');

    registerFrameworkFromSink(sink);

    assert.strictEqual(Scope._getRegisteredFramework(), 'sveltekit');
    assert.strictEqual(existsSync(dirname(sink)), false, 'sink directory must be removed');
    Scope._resetRegistry();
  });

  it('does nothing when no sink was created', () => {
    Scope._resetRegistry();
    registerFrameworkFromSink(undefined);
    assert.strictEqual(Scope._getRegisteredFramework(), undefined);
  });

  it('never removes a directory it did not create', () => {
    const outer = mkdtempSync(join(tmpdir(), 'fw-sink-outer-'));
    const victimDir = join(outer, 'precious');
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(join(victimDir, 'data.txt'), 'important');
    try {
      registerFrameworkFromSink(join(victimDir, 'framework'));
      assert.strictEqual(existsSync(victimDir), true, 'a caller-supplied path must not be removed');
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
