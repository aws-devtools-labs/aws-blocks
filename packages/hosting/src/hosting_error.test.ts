import { describe, it } from 'node:test';
import assert from 'node:assert';
import { HostingError } from './hosting_error.js';

void describe('HostingError', () => {
  void it('sets code, message, and resolution', () => {
    const error = new HostingError('TestErrorCode', {
      message: 'Something went wrong',
      resolution: 'Do this to fix it',
    });

    assert.strictEqual(error.code, 'TestErrorCode');
    assert.strictEqual(error.message, 'Something went wrong');
    assert.strictEqual(error.resolution, 'Do this to fix it');
  });

  void it('sets name to the error code (matches error code behavior)', () => {
    const error = new HostingError('InvalidBuildIdError', {
      message: 'Bad build ID',
      resolution: 'Fix the build ID',
    });

    assert.strictEqual(error.name, 'InvalidBuildIdError');
  });

  void it('sets cause when provided', () => {
    const cause = new Error('original error');
    const error = new HostingError(
      'WrappedError',
      { message: 'Wrapper', resolution: 'Fix it' },
      cause,
    );

    assert.strictEqual(error.cause, cause);
  });

  void it('does not set cause when not provided', () => {
    const error = new HostingError('NoCauseError', {
      message: 'No cause',
      resolution: 'None needed',
    });

    assert.strictEqual(error.cause, undefined);
    assert.strictEqual(Object.hasOwn(error, 'cause'), false);
  });

  void it('defines cause as a non-enumerable own property', () => {
    const cause = new Error('original error');
    const error = new HostingError(
      'WrappedError',
      { message: 'Wrapper', resolution: 'Fix it' },
      cause,
    );

    const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    assert.ok(descriptor);
    assert.strictEqual(descriptor.enumerable, false);
    assert.strictEqual(descriptor.value, cause);
    assert.ok(!Object.keys(error).includes('cause'));
  });

  void it('does not serialize the wrapped cause', () => {
    const cause = Object.assign(new Error('sdk failure'), {
      $metadata: { requestId: 'SENTINEL_REQUEST_ID' },
    });
    const error = new HostingError(
      'WrappedError',
      { message: 'Wrapper', resolution: 'Fix it' },
      cause,
    );

    const json = JSON.stringify(error);
    assert.ok(!json.includes('SENTINEL_REQUEST_ID'), json);
    assert.ok(!('cause' in { ...error }));
    assert.strictEqual(error.code, 'WrappedError');
    assert.strictEqual(error.resolution, 'Fix it');
  });

  void it('has name "HostingError" when code is HostingError', () => {
    const error = new HostingError('HostingError', {
      message: 'test',
      resolution: 'test',
    });
    assert.strictEqual(error.name, 'HostingError');
  });

  void it('is instanceof Error', () => {
    const error = new HostingError('SomeCode', {
      message: 'msg',
      resolution: 'res',
    });

    assert.ok(error instanceof Error);
    assert.ok(error instanceof HostingError);
  });

  void it('has a proper stack trace', () => {
    const error = new HostingError('StackTraceTest', {
      message: 'has stack',
      resolution: 'none',
    });

    assert.ok(error.stack);
    assert.ok(error.stack.includes('StackTraceTest'));
  });
});
