import { describe, it } from 'node:test';
import assert from 'node:assert';
import { QuotaBudget, AWS_DEFAULT_QUOTAS } from './quota_budget.js';
import { HostingError } from '../hosting_error.js';

void describe('QuotaBudget', () => {
  void it('uses AWS defaults when no overrides are supplied', () => {
    const b = new QuotaBudget();
    assert.strictEqual(b.limit('cacheBehaviors'), AWS_DEFAULT_QUOTAS.cacheBehaviors);
    assert.strictEqual(b.limit('edgeFunctions'), AWS_DEFAULT_QUOTAS.edgeFunctions);
    assert.strictEqual(b.limit('headerPolicies'), AWS_DEFAULT_QUOTAS.headerPolicies);
  });

  void it('honors per-quota overrides and leaves others at default', () => {
    const b = new QuotaBudget({ cacheBehaviors: 50 });
    assert.strictEqual(b.limit('cacheBehaviors'), 50);
    assert.strictEqual(b.limit('edgeFunctions'), AWS_DEFAULT_QUOTAS.edgeFunctions);
  });

  void it('tracks used / remaining / canFit as consumption accrues', () => {
    const b = new QuotaBudget({ cacheBehaviors: 5 });
    b.consume('cacheBehaviors', 'route:/a', 2);
    b.consume('cacheBehaviors', 'route:/b', 1);
    assert.strictEqual(b.used('cacheBehaviors'), 3);
    assert.strictEqual(b.remaining('cacheBehaviors'), 2);
    assert.ok(b.canFit('cacheBehaviors', 2));
    assert.ok(!b.canFit('cacheBehaviors', 3));
  });

  void it('remaining never goes negative', () => {
    const b = new QuotaBudget({ cacheBehaviors: 2 });
    b.consume('cacheBehaviors', 'x', 5);
    assert.strictEqual(b.remaining('cacheBehaviors'), 0);
  });

  void it('assertWithinLimits is a no-op when everything fits', () => {
    const b = new QuotaBudget({ cacheBehaviors: 10 });
    b.consume('cacheBehaviors', 'route:/a', 9);
    assert.doesNotThrow(() => b.assertWithinLimits());
  });

  void it('assertWithinLimits throws TooManyRoutesError for over-budget behaviors', () => {
    const b = new QuotaBudget({ cacheBehaviors: 3 });
    b.consume('cacheBehaviors', 'route:/a', 2);
    b.consume('cacheBehaviors', 'route:/b', 2);
    assert.throws(
      () => b.assertWithinLimits(),
      (e: unknown) => {
        assert.ok(e instanceof HostingError);
        assert.strictEqual(e.name, 'TooManyRoutesError');
        return true;
      },
    );
  });

  void it('maps each quota kind to its own error code', () => {
    const headerBudget = new QuotaBudget({ headerPolicies: 1 });
    headerBudget.consume('headerPolicies', 'policy:a', 2);
    assert.throws(
      () => headerBudget.assertWithinLimits(),
      (e: unknown) => {
        assert.strictEqual((e as HostingError).name, 'TooManyHeaderPoliciesError');
        return true;
      },
    );

    const edgeBudget = new QuotaBudget({ edgeFunctions: 1 });
    edgeBudget.consume('edgeFunctions', 'edge', 2);
    assert.throws(
      () => edgeBudget.assertWithinLimits(),
      (e: unknown) => {
        assert.strictEqual((e as HostingError).name, 'TooManyEdgeRoutesError');
        return true;
      },
    );
  });

  void it('error message includes a per-consumer breakdown grouped by prefix', () => {
    const b = new QuotaBudget({ cacheBehaviors: 2 });
    b.consume('cacheBehaviors', 'route:/a', 1);
    b.consume('cacheBehaviors', 'route:/b', 1);
    b.consume('cacheBehaviors', 'header:/c', 1);
    try {
      b.assertWithinLimits();
      assert.fail('expected throw');
    } catch (e) {
      const msg = (e as HostingError).message;
      // route consumers collapse to one "route" line summing to 2.
      assert.match(msg, /route: 2/);
      assert.match(msg, /header: 1/);
    }
  });

  void it('records consumers for diagnostics', () => {
    const b = new QuotaBudget();
    b.consume('cacheBehaviors', 'route:/a', 1);
    assert.deepStrictEqual(
      b.consumers('cacheBehaviors').map((c) => c.label),
      ['route:/a'],
    );
  });
});
