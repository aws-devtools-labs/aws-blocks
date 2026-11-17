// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'aws-blocks';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isLocal = ENV === 'local';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CapturedEntry {
  level: string;
  message: string;
  timestamp: string;
  logger: string;
  [key: string]: unknown;
}

interface LogResult {
  stdout: CapturedEntry[];
  stderr: CapturedEntry[];
}

export function loggingTests(getApi: () => typeof apiType) {

  describe('Logger BB', () => {

    describe('structured JSON output', () => {
      test('API calls produce structured JSON log entries', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestAllLevels();
        const all = [...result.stdout, ...result.stderr];

        assert.ok(all.length > 0, 'Expected at least one log entry');

        for (const entry of all) {
          assert.ok(entry.level, 'Entry must have level');
          assert.ok(entry.message, 'Entry must have message');
          assert.ok(entry.timestamp, 'Entry must have timestamp');
          assert.ok(entry.logger, 'Entry must have logger name');
          assert.ok(!isNaN(Date.parse(entry.timestamp)), 'timestamp must be valid ISO 8601');
        }
      });

      test('log entries contain correct logger name', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestAllLevels();
        const all = [...result.stdout, ...result.stderr];
        const appEntries = all.filter(e => e.logger === 'app-log');
        assert.ok(appEntries.length > 0, 'Expected entries from "app-log" logger');
      });
    });

    describe('log levels', () => {
      test('info-level logger emits info, warn, error but not debug', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestAllLevels();
        const all = [...result.stdout, ...result.stderr];
        const levels = all.map(e => e.level);

        assert.ok(levels.includes('info'), 'Should include info');
        assert.ok(levels.includes('warn'), 'Should include warn');
        assert.ok(levels.includes('error'), 'Should include error');
        assert.ok(!levels.includes('debug'), 'Should NOT include debug (level=info)');
      });

      test('debug-level logger emits all levels', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestDebugLevel();
        const all = [...result.stdout, ...result.stderr];
        const levels = all.map(e => e.level);

        assert.ok(levels.includes('debug'), 'Should include debug');
        assert.ok(levels.includes('info'), 'Should include info');
        assert.ok(levels.includes('warn'), 'Should include warn');
        assert.ok(levels.includes('error'), 'Should include error');
      });

      test('warn-level logger emits only warn and error', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestWarnLevel();
        const all = [...result.stdout, ...result.stderr];
        const levels = all.map(e => e.level);

        assert.ok(levels.includes('warn'), 'Should include warn');
        assert.ok(levels.includes('error'), 'Should include error');
        assert.ok(!levels.includes('debug'), 'Should NOT include debug');
        assert.ok(!levels.includes('info'), 'Should NOT include info');
      });

      test('error-level entries are written to stderr', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestAllLevels();

        const errorInStderr = result.stderr.filter(e => e.level === 'error');
        assert.ok(errorInStderr.length > 0, 'Error entries should appear in stderr');

        const nonErrorInStderr = result.stderr.filter(e => e.level !== 'error');
        assert.strictEqual(nonErrorInStderr.length, 0, 'Only error entries should be in stderr');
      });

      test('non-error entries are written to stdout', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestAllLevels();

        const nonErrorInStdout = result.stdout.filter(e => e.level !== 'error');
        assert.ok(nonErrorInStdout.length > 0, 'Non-error entries should appear in stdout');

        const errorInStdout = result.stdout.filter(e => e.level === 'error');
        assert.strictEqual(errorInStdout.length, 0, 'Error entries should NOT be in stdout');
      });
    });

    describe('defaultContext', () => {
      test('entries include defaultContext fields', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestDefaultContext();
        const all = [...result.stdout, ...result.stderr];
        const serviceEntries = all.filter(e => e.logger === 'service-log');
        assert.ok(serviceEntries.length > 0, 'Expected entries from "service-log" logger');

        for (const entry of serviceEntries) {
          assert.strictEqual(entry.service, 'comprehensive-test', 'Should include service from defaultContext');
          assert.strictEqual(entry.version, '0.2.5', 'Should include version from defaultContext');
          assert.strictEqual(entry.env, 'local', 'Should include env from defaultContext');
        }
      });

      test('context from call-site merges with defaultContext', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestDefaultContext();
        const all = [...result.stdout, ...result.stderr];
        const serviceEntries = all.filter(e => e.logger === 'service-log');
        const withMethod = serviceEntries.find(e => e.method === 'GET');
        assert.ok(withMethod, 'Should have entry with method from call-site context');
        assert.strictEqual(withMethod.service, 'comprehensive-test', 'defaultContext persists alongside call-site context');
      });
    });

    describe('child loggers', () => {
      test('child logger inherits parent context', async () => {
        const api = getApi();
        const result = await api.logTestChildLoggers();
        const all = [...result.stdout, ...result.stderr];
        const childEntries = all.filter((e: CapturedEntry) => e.requestId === result.requestId);
        assert.ok(childEntries.length >= 2, 'Should have entries from request-scoped child');

        for (const entry of childEntries) {
          assert.strictEqual(entry.userId, 'user-abc123', 'Child entries should include parent context');
        }
      });

      test('nested child merges all ancestor context', async () => {
        const api = getApi();
        const result = await api.logTestChildLoggers();
        const all = [...result.stdout, ...result.stderr];
        const dbEntries = all.filter((e: CapturedEntry) => e.component === 'database' && e.requestId === result.requestId);
        assert.ok(dbEntries.length > 0, 'Should have entries from nested database child');

        for (const entry of dbEntries) {
          assert.strictEqual(entry.requestId, result.requestId, 'Should inherit requestId from grandparent');
          assert.strictEqual(entry.userId, 'user-abc123', 'Should inherit userId from parent');
          assert.strictEqual(entry.pool, 'primary', 'Should have own context');
        }
      });

      test('separate child loggers have independent context', async () => {
        const api = getApi();
        const result = await api.logTestChildLoggers();
        const all = [...result.stdout, ...result.stderr];
        const authEntries = all.filter((e: CapturedEntry) => e.component === 'auth');
        assert.ok(authEntries.length > 0, 'Should have entries from auth child');

        for (const entry of authEntries) {
          assert.strictEqual(entry.requestId, undefined, 'Auth child should NOT inherit request-scoped context');
        }
      });
    });

    describe('invocation request id', () => {
      test('lines carry no awsRequestId locally', { skip: !isLocal && 'local dev server only' }, async () => {
        const api = getApi();
        const result: LogResult = await api.logTestAllLevels();
        const all = [...result.stdout, ...result.stderr];
        assert.ok(all.length > 0, 'Expected log entries');
        for (const entry of all) assert.strictEqual(entry.awsRequestId, undefined);
      });

      test('every line of one call carries the same invocation id, and calls differ', { skip: isLocal && 'deployed Lambda only' }, async () => {
        const api = getApi();
        const idsOf = (r: LogResult) => new Set([...r.stdout, ...r.stderr].map((e) => e.awsRequestId));
        const first = idsOf(await api.logTestAllLevels());
        const second = idsOf(await api.logTestAllLevels());
        assert.strictEqual(first.size, 1, 'one invocation logs one id');
        assert.strictEqual(second.size, 1, 'one invocation logs one id');
        const [a] = first;
        const [b] = second;
        assert.match(String(a), UUID, 'the id is the Lambda awsRequestId');
        assert.match(String(b), UUID, 'the id is the Lambda awsRequestId');
        assert.notStrictEqual(a, b, 'separate calls carry separate ids');
      });

      test("an app's own requestId context field sits beside the invocation id", { skip: isLocal && 'deployed Lambda only' }, async () => {
        const api = getApi();
        const result = await api.logTestChildLoggers();
        const all = [...result.stdout, ...result.stderr];
        const ids = new Set(all.map((e: CapturedEntry) => e.awsRequestId));
        assert.strictEqual(ids.size, 1, 'request-scoped and other child loggers share the invocation id');
        assert.match(String([...ids][0]), UUID);
        const reqEntries = all.filter((e: CapturedEntry) => e.requestId === result.requestId);
        assert.ok(reqEntries.length > 0, 'the app-chosen requestId is kept');
      });
    });

    describe('error object serialization', () => {
      test('Error objects are serialized with name/message/stack', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestErrorObjects();
        const all = [...result.stdout, ...result.stderr];
        const withErr = all.filter(e => e.err && typeof e.err === 'object');
        assert.ok(withErr.length > 0, 'Should have entries with serialized errors');

        const firstErr = withErr[0].err as { name: string; message: string; stack: string };
        assert.ok(firstErr.name, 'Serialized error should have name');
        assert.ok(firstErr.message, 'Serialized error should have message');
        assert.ok(firstErr.stack, 'Serialized error should have stack');
      });

      test('Error with custom properties includes request context', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestErrorObjects();
        const all = [...result.stdout, ...result.stderr];
        const httpErrEntry = all.find(e => e.message === 'HTTP error');
        assert.ok(httpErrEntry, 'Should have HTTP error entry');
        assert.ok(httpErrEntry.request, 'Should have request context alongside error');
        assert.deepStrictEqual(httpErrEntry.request, { method: 'GET', url: '/missing' });
      });

      test('TypeError is properly serialized', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestErrorObjects();
        const all = [...result.stdout, ...result.stderr];
        const typeErrEntry = all.find(e => e.message === 'TypeError caught');
        assert.ok(typeErrEntry, 'Should have TypeError entry');
        const err = typeErrEntry.err as { name: string; message: string };
        assert.strictEqual(err.name, 'TypeError', 'Should preserve TypeError name');
      });
    });

    describe('serialization edge cases', () => {
      test('circular references do not crash and produce valid JSON', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestEdgeCases();
        const all = [...result.stdout, ...result.stderr];
        const circularEntry = all.find(e => e.message === 'Circular ref test');
        assert.ok(circularEntry, 'Circular ref test should produce a log entry');
        // The context `{ name: 'test', self: <circular> }` is spread into the entry.
        // The nested self-reference becomes [Circular].
        const self = circularEntry.self as { name: string; self: string };
        assert.strictEqual(self.self, '[Circular]', 'Nested circular ref should become [Circular]');
      });

      test('BigInt values are serialized as strings', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestEdgeCases();
        const all = [...result.stdout, ...result.stderr];
        const bigIntEntry = all.find(e => e.message === 'BigInt test');
        assert.ok(bigIntEntry, 'BigInt test should produce a log entry');
        assert.strictEqual(bigIntEntry.bigValue, '9007199254740991', 'BigInt should be converted to string');
      });

      test('mixed types are serialized correctly', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestEdgeCases();
        const all = [...result.stdout, ...result.stderr];
        const mixedEntry = all.find(e => e.message === 'Mixed types');
        assert.ok(mixedEntry, 'Mixed types test should produce a log entry');
        assert.strictEqual(mixedEntry.str, 'hello');
        assert.strictEqual(mixedEntry.num, 42);
        assert.strictEqual(mixedEntry.bool, true);
        assert.strictEqual(mixedEntry.nil, null);
        assert.deepStrictEqual(mixedEntry.arr, [1, 2, 3]);
        assert.deepStrictEqual(mixedEntry.nested, { deep: { value: 'ok' } });
      });

      test('app does not crash on edge cases', async () => {
        const api = getApi();
        const result: LogResult = await api.logTestEdgeCases();
        assert.ok(result.stdout.length > 0 || result.stderr.length > 0, 'Should produce output without crashing');
      });
    });

  });

}
