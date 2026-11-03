import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { WafConstruct } from './waf_construct.js';
import { HostingError } from '../hosting_error.js';

// ---- Test helpers ----

const createStack = (): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack');
};

const createEnvStack = (
  region = 'us-east-1',
  account = '123456789012',
): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack', { env: { account, region } });
};

// ================================================================
// WafConstruct — isolated unit tests
// ================================================================

void describe('WafConstruct', () => {
  // ---- Disabled ----

  void describe('enabled: false', () => {
    void it('does not create WebACL when disabled', () => {
      const stack = createStack();
      const waf = new WafConstruct(stack, 'Waf', { enabled: false });
      const template = Template.fromStack(stack);

      assert.strictEqual(waf.webAcl, undefined, 'webAcl should be undefined');
      template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    });
  });

  // ---- Enabled (defaults) ----

  void describe('enabled: true (defaults)', () => {
    void it('creates WebACL with CLOUDFRONT scope', () => {
      const stack = createStack();
      new WafConstruct(stack, 'Waf', { enabled: true });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'CLOUDFRONT',
        DefaultAction: { Allow: {} },
      });
    });

    void it('exposes webAcl property', () => {
      const stack = createStack();
      const waf = new WafConstruct(stack, 'Waf', { enabled: true });

      assert.ok(waf.webAcl, 'Should expose webAcl');
    });
  });

  // ---- Managed rule groups ----

  void describe('managed rule groups', () => {
    void it('includes AWSManagedRulesCommonRuleSet', () => {
      const stack = createStack();
      new WafConstruct(stack, 'Waf', { enabled: true });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'AWSManagedRulesCommonRuleSet',
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesCommonRuleSet',
              },
            },
          }),
        ]),
      });
    });

    void it('includes AWSManagedRulesKnownBadInputsRuleSet', () => {
      const stack = createStack();
      new WafConstruct(stack, 'Waf', { enabled: true });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'AWSManagedRulesKnownBadInputsRuleSet',
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesKnownBadInputsRuleSet',
              },
            },
          }),
        ]),
      });
    });

    void it('has 3 rules total (2 managed + rate limit)', () => {
      const stack = createStack();
      new WafConstruct(stack, 'Waf', { enabled: true });
      const template = Template.fromStack(stack);

      const webAcls = template.findResources('AWS::WAFv2::WebACL');
      const acl = Object.values(webAcls)[0] as Record<
        string,
        Record<string, unknown>
      >;
      const rules = acl.Properties.Rules as unknown[];
      assert.strictEqual(rules.length, 3, 'Should have exactly 3 rules');
    });
  });

  // ---- Rate limiting ----

  void describe('rate limiting', () => {
    void it('creates rate limit rule with default limit of 1000', () => {
      const stack = createStack();
      new WafConstruct(stack, 'Waf', { enabled: true });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'RateLimitRule',
            Action: { Block: {} },
            Statement: {
              RateBasedStatement: {
                Limit: 1000,
                AggregateKeyType: 'IP',
              },
            },
          }),
        ]),
      });
    });

    void it('applies custom rate limit', () => {
      const stack = createStack();
      new WafConstruct(stack, 'Waf', { enabled: true, rateLimit: 500 });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'RateLimitRule',
            Statement: {
              RateBasedStatement: {
                Limit: 500,
              },
            },
          }),
        ]),
      });
    });

    void it('throws HostingError when rate limit is below 100', () => {
      assert.throws(
        () => {
          const stack = createStack();
          new WafConstruct(stack, 'Waf', { enabled: true, rateLimit: 50 });
        },
        (err: unknown) => {
          assert.ok(err instanceof HostingError);
          assert.strictEqual(err.name, 'InvalidWafConfigError');
          assert.ok(err.message.includes('50'));
          assert.ok(err.resolution);
          return true;
        },
      );
    });

    void it('throws HostingError when rate limit is exactly 99', () => {
      assert.throws(
        () => {
          const stack = createStack();
          new WafConstruct(stack, 'Waf', { enabled: true, rateLimit: 99 });
        },
        (err: unknown) => {
          assert.ok(err instanceof HostingError);
          assert.strictEqual(err.name, 'InvalidWafConfigError');
          return true;
        },
      );
    });

    void it('accepts rate limit of exactly 100', () => {
      const stack = createStack();
      const waf = new WafConstruct(stack, 'Waf', {
        enabled: true,
        rateLimit: 100,
      });
      assert.ok(waf.webAcl, 'Should create WebACL with rate limit 100');
    });
  });

  // ---- Custom metric name ----

  void describe('custom metricName', () => {
    void it('uses custom metric name prefix', () => {
      const stack = createStack();
      new WafConstruct(stack, 'Waf', {
        enabled: true,
        metricName: 'myApp',
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        VisibilityConfig: Match.objectLike({
          MetricName: 'myAppWebAcl',
        }),
      });
    });

    void it('uses default metric name prefix when not specified', () => {
      const stack = createStack();
      new WafConstruct(stack, 'Waf', { enabled: true });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        VisibilityConfig: Match.objectLike({
          MetricName: 'hostingWebAcl',
        }),
      });
    });
  });

  // ---- Region validation ----

  void describe('region validation', () => {
    void it('throws HostingError for non-us-east-1 region', () => {
      assert.throws(
        () => {
          const stack = createEnvStack('eu-west-1', '123456789012');
          new WafConstruct(stack, 'Waf', { enabled: true });
        },
        (err: unknown) => {
          assert.ok(err instanceof HostingError);
          assert.strictEqual(err.name, 'WafRegionError');
          assert.ok(err.message.includes('eu-west-1'));
          assert.ok(err.resolution);
          return true;
        },
      );
    });

    void it('succeeds in us-east-1', () => {
      const stack = createEnvStack('us-east-1', '123456789012');
      const waf = new WafConstruct(stack, 'Waf', { enabled: true });
      assert.ok(waf.webAcl, 'Should create WebACL in us-east-1');
    });

    void it('bypasses region check with skipRegionValidation', () => {
      const stack = createEnvStack('eu-west-1', '123456789012');
      const waf = new WafConstruct(stack, 'Waf', {
        enabled: true,
        skipRegionValidation: true,
      });
      assert.ok(waf.webAcl, 'Should create WebACL despite non-us-east-1');
    });

    void it('skips region check when region is an unresolved token', () => {
      // Stack without explicit env → region is a token
      const stack = createStack();
      const waf = new WafConstruct(stack, 'Waf', { enabled: true });
      assert.ok(waf.webAcl, 'Should create WebACL with token region');
    });
  });
});
