import { Construct } from 'constructs';
import { Stack, Token } from 'aws-cdk-lib/core';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { HostingError } from '../hosting_error.js';

// ---- Constants ----

/** Default rate limit: requests per 5-minute window per IP. */
const DEFAULT_RATE_LIMIT = 1000;

// ---- Public types ----

/**
 * Props for the WafConstruct.
 */
export type WafConstructProps = {
  /** Whether WAF protection is enabled. */
  enabled: boolean;
  /** Requests per 5-minute window per IP. Must be >= 100. Default: 1000. */
  rateLimit?: number;
  /** Metric name prefix for CloudWatch WAF metrics. */
  metricName?: string;
  /**
   * Skip the us-east-1 region validation for CloudFront-scoped WAF.
   * Only useful if deploying a CloudFront WAF in a non-us-east-1 stack
   * via a cross-region mechanism.
   */
  skipRegionValidation?: boolean;
};

// ---- Construct ----

/**
 * WAFv2 WebACL for CloudFront protection.
 *
 * Creates a CLOUDFRONT-scoped WebACL with:
 * - AWSManagedRulesCommonRuleSet
 * - AWSManagedRulesKnownBadInputsRuleSet
 * - IP-based rate limiting
 *
 * NOTE: WAFv2 WebACLs with scope CLOUDFRONT must be created in us-east-1.
 */
export class WafConstruct extends Construct {
  readonly webAcl?: CfnWebACL;

  /**
   * Create a WAF WebACL for CloudFront protection.
   */
  constructor(scope: Construct, id: string, props: WafConstructProps) {
    super(scope, id);

    if (!props.enabled) {
      return;
    }

    const region = Stack.of(this).region;

    // Validate us-east-1 (required for CloudFront WAF)
    if (
      !props.skipRegionValidation &&
      !Token.isUnresolved(region) &&
      region !== 'us-east-1'
    ) {
      throw new HostingError('WafRegionError', {
        message: `WAF with CloudFront scope must be deployed in us-east-1, but the current region is ${region}.`,
        resolution:
          'Either deploy to us-east-1, disable WAF (waf: { enabled: false }), or use a separate us-east-1 stack for WAF.',
      });
    }

    // Validate rate limit minimum
    if (props.rateLimit !== undefined && props.rateLimit < 100) {
      throw new HostingError('InvalidWafConfigError', {
        message: `WAF rate limit must be at least 100 (got ${props.rateLimit}). This is an AWS WAFv2 requirement.`,
        resolution:
          'Set waf.rateLimit to 100 or higher, or omit it to use the default (1000).',
      });
    }

    const rateLimit = props.rateLimit ?? DEFAULT_RATE_LIMIT;
    const metricPrefix = props.metricName ?? 'hosting';

    this.webAcl = new CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'CLOUDFRONT',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${metricPrefix}WebAcl`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesKnownBadInputsRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimitRule',
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: rateLimit,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
  }
}
