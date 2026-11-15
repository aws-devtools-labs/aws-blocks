import { Construct } from 'constructs';
import { Stack, Token } from 'aws-cdk-lib';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { HostingError } from '../hosting_error.js';

// ---- Constants ----

/** Default rate limit: requests per 5-minute window per IP. */
export const DEFAULT_WAF_RATE_LIMIT = 1000;

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
  /**
   * Web ACL scope. `'REGIONAL'` builds the same rules for an API Gateway
   * stage (no us-east-1 requirement).
   * @default 'CLOUDFRONT'
   */
  scope?: 'CLOUDFRONT' | 'REGIONAL';
  /**
   * A header (name and exact value) that exempts a request from the rate rule
   * (the managed rule groups still inspect it). Used on a REGIONAL web ACL
   * behind CloudFront: requests CloudFront forwards arrive from its edge IPs,
   * so a per-IP limit would throttle every viewer behind one edge together.
   * CloudFront marks them with an origin custom header, which replaces any
   * viewer header of the same name.
   */
  rateLimitExemptHeader?: { name: string; value: string };
  /**
   * Keep sampled requests for the web ACL and every rule. Sampled requests
   * carry the full request headers, and the logging `RedactedFields` don't
   * apply to them, so turn this off on a web ACL that sees a secret header.
   * @default true
   */
  sampledRequests?: boolean;
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
 * With `scope: 'REGIONAL'` the same rules are built for an API Gateway stage
 * in the stack's region.
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
    const scopeName = props.scope ?? 'CLOUDFRONT';

    // Validate us-east-1 (required for CloudFront WAF)
    if (
      scopeName === 'CLOUDFRONT' &&
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

    const rateLimit = props.rateLimit ?? DEFAULT_WAF_RATE_LIMIT;
    const metricPrefix = props.metricName ?? 'hosting';
    const sampled = props.sampledRequests ?? true;

    this.webAcl = new CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: scopeName,
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${metricPrefix}WebAcl`,
        sampledRequestsEnabled: sampled,
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
            sampledRequestsEnabled: sampled,
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
            sampledRequestsEnabled: sampled,
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
              ...(props.rateLimitExemptHeader
                ? {
                    scopeDownStatement: {
                      notStatement: {
                        statement: {
                          byteMatchStatement: {
                            fieldToMatch: { singleHeader: { Name: props.rateLimitExemptHeader.name } },
                            positionalConstraint: 'EXACTLY',
                            searchString: props.rateLimitExemptHeader.value,
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                          },
                        },
                      },
                    },
                  }
                : {}),
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule',
            sampledRequestsEnabled: sampled,
          },
        },
      ],
    });
  }
}
