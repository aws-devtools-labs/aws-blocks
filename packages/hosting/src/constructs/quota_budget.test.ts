import { describe, it } from 'node:test';
import assert from 'node:assert';
import { QuotaBudget, AWS_DEFAULT_QUOTAS } from './quota_budget.js';

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
    assert.strictEqual(b.limit('headerPolicies'), AWS_DEFAULT_QUOTAS.headerPolicies);
  });

  void it('honors all three overrides at once', () => {
    const b = new QuotaBudget({
      cacheBehaviors: 40,
      edgeFunctions: 30,
      headerPolicies: 200,
    });
    assert.strictEqual(b.limit('cacheBehaviors'), 40);
    assert.strictEqual(b.limit('edgeFunctions'), 30);
    assert.strictEqual(b.limit('headerPolicies'), 200);
  });
});
