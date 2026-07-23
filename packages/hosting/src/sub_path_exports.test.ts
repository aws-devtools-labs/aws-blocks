import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

void describe('sub-path exports', () => {
  void it('resolves ./constructs', () => {
    assert.ok(require.resolve('@aws-blocks/hosting/constructs'));
  });

  void it('resolves ./adapters', () => {
    assert.ok(require.resolve('@aws-blocks/hosting/adapters'));
  });

  void it('resolves ./error', () => {
    assert.ok(require.resolve('@aws-blocks/hosting/error'));
  });

  void it('resolves ./secret', () => {
    assert.ok(require.resolve('@aws-blocks/hosting/secret'));
  });

  void it('resolves main entry', () => {
    assert.ok(require.resolve('@aws-blocks/hosting'));
  });
});
