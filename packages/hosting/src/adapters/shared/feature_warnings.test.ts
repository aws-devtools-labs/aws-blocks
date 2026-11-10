import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  warnIfVercelCron,
  warnUnschedulableCron,
  warnUnsupportedWebSocket,
} from './feature_warnings.js';

/**
 * The WebSocket and cron warnings are shared across all three adapters
 * (Next/Nitro/Astro). Policy: WARN, never throw — neither feature is widely
 * supported on serverless SSR, but the rest of the app deploys fine.
 */
void describe('shared feature warnings', () => {
  let tmpDir: string;
  let stderrChunks: string[];
  let restoreStderr: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-feature-warn-'));
    stderrChunks = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    restoreStderr = () => {
      process.stderr.write = original;
    };
  });
  afterEach(() => {
    restoreStderr?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void describe('warnUnsupportedWebSocket', () => {
    void it('warns (does not throw) with the supplied detail', () => {
      assert.doesNotThrow(() =>
        warnUnsupportedWebSocket('Nitro WebSocket support'),
      );
      const out = stderrChunks.join('');
      assert.ok(out.includes('Nitro WebSocket support'));
      assert.ok(out.includes('WebSocket'));
      assert.ok(out.includes('⚠️'), 'must be a warning, not an error');
    });
  });

  void describe('warnUnschedulableCron', () => {
    void it('warns (does not throw) with the supplied detail', () => {
      assert.doesNotThrow(() =>
        warnUnschedulableCron('Nitro `scheduledTasks` are declared'),
      );
      const out = stderrChunks.join('');
      assert.ok(out.includes('scheduledTasks'));
      assert.ok(out.includes('NEVER'));
    });
  });

  void describe('warnIfVercelCron', () => {
    void it('warns when vercel.json declares crons', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'vercel.json'),
        JSON.stringify({
          crons: [{ path: '/api/cron', schedule: '0 0 * * *' }],
        }),
      );
      warnIfVercelCron(tmpDir);
      const out = stderrChunks.join('');
      assert.ok(
        out.includes('cron') && out.includes('NEVER fire'),
        `expected cron warning; stderr: ${out}`,
      );
    });

    void it('does not warn when vercel.json has no crons', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'vercel.json'),
        JSON.stringify({ crons: [] }),
      );
      warnIfVercelCron(tmpDir);
      assert.strictEqual(stderrChunks.join('').includes('cron'), false);
    });

    void it('does not warn (or throw) when vercel.json is absent', () => {
      assert.doesNotThrow(() => warnIfVercelCron(tmpDir));
      assert.strictEqual(stderrChunks.join('').includes('cron'), false);
    });

    void it('does not throw on an unparseable vercel.json', () => {
      fs.writeFileSync(path.join(tmpDir, 'vercel.json'), '{ not valid json');
      assert.doesNotThrow(() => warnIfVercelCron(tmpDir));
    });
  });
});
