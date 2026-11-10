// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers that lock the CloudFront door's server (SSR) origin — an API
 * Gateway REST API — to the distribution: the origin-verify secret and the
 * resource policy that requires it, the stage's access logs, and the stage's
 * REGIONAL web ACL.
 *
 * @module
 * @internal
 */

import { createHash } from 'node:crypto';
import { ArnFormat, Fn, Names, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnAccount, type Stage } from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnLoggingConfiguration, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { WafConstruct } from './waf_construct.js';

/** Default retention of the server origin's access logs and web ACL logs. */
export const SERVER_ORIGIN_LOG_RETENTION = RetentionDays.ONE_MONTH;

/**
 * Header CloudFront adds to every server-origin request it forwards, so the
 * stage web ACL's per-IP rate rule (when there is one) skips them (they come
 * from CloudFront edge IPs). Same name as `@aws-blocks/core`'s API marker.
 */
export const SERVER_ORIGIN_MARKER_HEADER = 'x-blocks-front-door';

/**
 * The marker value: the UUID part of the stack's `AWS::StackId`. CloudFormation
 * assigns it at stack creation, so it is stable across deploys and not
 * derivable from the stack name or construct path. It only exempts requests
 * from the rate rule; the managed rule groups still inspect them, and the
 * resource policy still requires the origin-verify secret.
 */
export const serverOriginMarkerValue = (scope: Construct): string =>
  Fn.select(2, Fn.split('/', Stack.of(scope).stackId));

/**
 * The origin-verify value of earlier releases: SHA-256 of the stack name, the
 * construct path and a version suffix. Only used, when the app asks for it, to
 * keep accepting that value for one deploy while the distribution moves to the
 * random secret (`serverOrigin.acceptLegacyVerifyHeader`).
 */
export const legacyOriginVerifyValue = (scope: Construct): string =>
  createHash('sha256')
    .update(Stack.of(scope).stackName)
    .update(scope.node.path)
    .update('origin-verify-v1')
    .digest('hex');

/**
 * A random origin-verify secret, generated once by Secrets Manager, and the
 * `{{resolve:secretsmanager:…}}` dynamic reference that reads it at deploy
 * time. A new `rotation` gives the secret a new construct id, so the next
 * deploy creates a new secret (a new value) and updates every resource that
 * references it in the same deploy.
 *
 * Alphanumeric only, 64 characters.
 */
export const createOriginVerifySecret = (
  scope: Construct,
  id: string,
  description: string,
  rotation = 0,
): { secret: Secret; value: string } => {
  const secret = new Secret(scope, rotation === 0 ? id : `${id}R${rotation}`, {
    description,
    generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
  });
  return { secret, value: secret.secretValue.unsafeUnwrap() };
};

/**
 * Resource policy: ALLOW `execute-api:Invoke` to anyone, DENY any request
 * whose `Referer` is not one of `accepted` (the secret CloudFront sends as an
 * origin custom header). Direct calls to the stage URL get a 403 from API
 * Gateway before the Lambda runs.
 */
export const originVerifyPolicy = (accepted: readonly string[]): iam.PolicyDocument =>
  new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ['execute-api:Invoke'],
        resources: ['execute-api:/*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['execute-api:Invoke'],
        resources: ['execute-api:/*'],
        conditions: {
          StringNotEquals: {
            'aws:Referer': accepted.length === 1 ? accepted[0] : [...accepted],
          },
        },
      }),
    ],
  });

/**
 * Global registry key for the per-stack API Gateway CloudWatch Logs account
 * resource. The same `Symbol.for` key `@aws-blocks/core` uses, so a stack gets
 * one `AWS::ApiGateway::Account` whichever package asks first.
 */
const ACCOUNT_KEY = Symbol.for('BLOCKS_APIGATEWAY_ACCOUNT');

/**
 * Ensure the account-level API Gateway CloudWatch Logs role exists on `stack`,
 * creating it at most once per stack (shared with `@aws-blocks/core`, which
 * creates the same resources under the same ids). REST API access logging
 * needs it; a stage that logs must depend on the returned account so a
 * clean-account first deploy applies the setting before creating the stage.
 *
 * `AWS::ApiGateway::Account` is an account/region-level setting: a second
 * stack in the same account and region that also creates it repoints it on
 * deploy and, on teardown, leaves it pointing at a deleted role.
 */
export const ensureApiGatewayAccount = (stack: Stack): CfnAccount => {
  const registry = stack as unknown as Record<symbol, CfnAccount | undefined>;
  const existing = registry[ACCOUNT_KEY];
  if (existing) return existing;
  const role = new iam.Role(stack, 'BlocksApiGatewayCloudWatchRole', {
    assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
    ],
  });
  const account = new CfnAccount(stack, 'BlocksApiGatewayAccount', { cloudWatchRoleArn: role.roleArn });
  registry[ACCOUNT_KEY] = account;
  return account;
};

/**
 * Headers the server-origin web ACL's logs redact: the origin-verify secret
 * (`referer`) and the viewer's credentials (`cookie`, `authorization`), which
 * CloudFront forwards to the server origin.
 */
export const SERVER_ORIGIN_WAF_REDACTED_HEADERS = ['referer', 'cookie', 'authorization'] as const;

/**
 * The server-origin web ACL's logging filter: keep the requests a rule
 * blocked or counted, drop the rest.
 */
export const SERVER_ORIGIN_WAF_LOGGING_FILTER = {
  DefaultBehavior: 'DROP',
  Filters: [
    {
      Behavior: 'KEEP',
      Requirement: 'MEETS_ANY',
      Conditions: [{ ActionCondition: { Action: 'BLOCK' } }, { ActionCondition: { Action: 'COUNT' } }],
    },
  ],
} as const;

/**
 * A REGIONAL web ACL with the distribution's rules (AWS managed common and
 * known-bad-inputs rule groups, then the per-IP rate limit), associated with
 * each server-origin stage, with its logs in a CloudWatch log group
 * (`aws-waf-logs-…`, the prefix AWS WAF requires) that keeps only the
 * blocked and counted requests.
 */
export class ServerOriginWaf extends Construct {
  private readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: { rateLimit: number; logRetention: RetentionDays }) {
    super(scope, id);
    const waf = new WafConstruct(this, 'Waf', {
      enabled: true,
      scope: 'REGIONAL',
      rateLimit: props.rateLimit,
      metricName: 'hostingServerOrigin',
      rateLimitExemptHeader: { name: SERVER_ORIGIN_MARKER_HEADER, value: serverOriginMarkerValue(this) },
      // Sampled requests carry every header unredacted, including the
      // origin-verify secret in `Referer`; the logs below cover visibility.
      sampledRequests: false,
    });
    const webAcl = waf.webAcl;
    if (!webAcl) throw new Error('ServerOriginWaf: the web ACL was not created.');
    this.webAclArn = webAcl.attrArn;

    // AWS WAF only delivers to log groups named `aws-waf-logs-*`, so this one
    // is named; DESTROY keeps the name free for a re-created stack.
    const logGroupName = `aws-waf-logs-${Names.uniqueResourceName(this, { maxLength: 200, separator: '-' })}`;
    const logGroup = new LogGroup(this, 'Logs', {
      logGroupName,
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const logging = new CfnLoggingConfiguration(this, 'Logging', {
      resourceArn: webAcl.attrArn,
      // WAF takes the log group ARN without the `:*` suffix `logGroupArn` carries.
      logDestinationConfigs: [
        Stack.of(this).formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: logGroupName,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      // The origin-verify secret travels in `Referer`, and the server origin
      // gets the viewer's cookies and `Authorization`; keep them out of the logs.
      redactedFields: SERVER_ORIGIN_WAF_REDACTED_HEADERS.map((Name) => ({ singleHeader: { Name } })),
      // Keep only the requests a rule blocked or counted: those are what this
      // ACL's logs are for, and allowed requests (every uncached SSR request)
      // would add a log record and ingestion cost per request.
      loggingFilter: SERVER_ORIGIN_WAF_LOGGING_FILTER,
    });
    logging.node.addDependency(logGroup);
  }

  /**
   * Associate the web ACL with a REST API stage. The association's id comes
   * from the REST API's id, so it stays the same whichever other stages exist
   * (switching compute types never repoints one association at another stage).
   */
  associate(stage: Stage): void {
    const assoc = new CfnWebACLAssociation(this, `Association${stage.restApi.node.id}`, {
      resourceArn: stage.stageArn,
      webAclArn: this.webAclArn,
    });
    assoc.node.addDependency(stage);
  }
}
