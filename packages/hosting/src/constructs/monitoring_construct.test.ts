/**
 * MonitoringConstruct — alarm-wiring assertions.
 *
 * The construct is 177 lines of CDK plumbing with ~5 conditional
 * branches (one per alarm category). What we want from tests:
 *
 *   - When `enabled: false`, NO alarms or topic are created.
 *   - When `enabled: true` with no resources, an SNS topic is created
 *     (so the surfaced ARN output is valid) but no alarms.
 *   - Each prop-driven branch (distribution, ssrFunction, imageFunction,
 *     revalidationDlq) creates exactly the alarms it should — and not
 *     ones it shouldn't.
 *   - Thresholds and metric dimensions are correct (CloudFront metrics
 *     in `us-east-1`, the right namespaces, threshold values).
 *   - BYO SNS topic skips topic creation and reuses the supplied one.
 *   - The auto-created topic is KMS-encrypted and its key policy
 *     grants CloudWatch `kms:Decrypt` + `kms:GenerateDataKey*` —
 *     without that grant alarm notifications are dropped silently.
 *
 * Driven by review feedback on PR #3220 — a 177-line construct with
 * zero tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import {
  Code,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { MonitoringConstruct } from './monitoring_construct.js';

const createStack = (): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-west-2' },
  });
};

const newDistribution = (stack: Stack): Distribution => {
  const bucket = new Bucket(stack, 'OriginBucket');
  return new Distribution(stack, 'TestDist', {
    defaultBehavior: { origin: new S3Origin(bucket) },
  });
};

const newLambda = (stack: Stack, id: string): LambdaFunction => {
  return new LambdaFunction(stack, id, {
    runtime: Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: Code.fromInline('exports.handler = async () => ({})'),
  });
};

void describe('MonitoringConstruct', () => {
  // ---- Disabled path ----

  void describe('when `enabled: false`', () => {
    void it('creates no SNS topic', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', { enabled: false });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SNS::Topic', 0);
    });

    void it('creates no alarms', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', {
        enabled: false,
        // Even with all the resources passed in, disabled = no alarms.
        distribution: newDistribution(stack),
        ssrFunction: newLambda(stack, 'Ssr'),
        imageFunction: newLambda(stack, 'Img'),
        revalidationDlq: new Queue(stack, 'Dlq'),
      });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    });

    void it('exposes empty `alarms` and undefined `topic`', () => {
      const stack = createStack();
      const m = new MonitoringConstruct(stack, 'Monitoring', {
        enabled: false,
      });

      assert.strictEqual(m.topic, undefined);
      assert.strictEqual(m.alarms.length, 0);
    });
  });

  // ---- Enabled path: topic provisioning ----

  void describe('SNS topic provisioning when enabled', () => {
    void it('creates an SNS topic when none is supplied', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', { enabled: true });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    void it('reuses a BYO SNS topic and creates no new one', () => {
      const stack = createStack();
      const userTopic = new Topic(stack, 'UserTopic');
      new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        snsTopic: userTopic,
      });
      // Synthesize once at the end. If the construct created its own
      // topic, the count would be 2.
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    void it('creates no alarms when no monitorable resources are supplied', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', { enabled: true });
      const template = Template.fromStack(stack);

      // Topic exists (so the operator can subscribe later) but no
      // alarms point at it yet.
      template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    });
  });

  // ---- Enabled path: per-resource alarm wiring ----

  void describe('CloudFront 5xx alarm', () => {
    void it('is created when a distribution is supplied', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        distribution: newDistribution(stack),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/CloudFront',
        MetricName: '5xxErrorRate',
        Threshold: 5,
        // CloudFront emits metrics in us-east-1 globally; the
        // dimension MUST stay `Region: 'Global'` regardless of the
        // stack region.
        Dimensions: Match.arrayWith([
          Match.objectLike({ Name: 'Region', Value: 'Global' }),
        ]),
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
      });
    });

    void it('is NOT created when no distribution is supplied', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', { enabled: true });
      const template = Template.fromStack(stack);

      // No alarm at all because no distribution / Lambda / DLQ given.
      template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    });
  });

  void describe('SSR Lambda alarms', () => {
    void it('creates exactly two alarms (errors + throttles) when ssrFunction is supplied', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        ssrFunction: newLambda(stack, 'Ssr'),
      });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::CloudWatch::Alarm', 2);

      // Errors alarm is RATE-based: a CloudWatch math expression
      // `(errors / invocations) * 100`, threshold defaults to 1(%).
      // The alarm has no top-level Namespace/MetricName — those live
      // inside the `Metrics` array (the math expr + its two inputs).
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Threshold: 1,
        Metrics: Match.arrayWith([
          Match.objectLike({
            Expression: '(errors / invocations) * 100',
          }),
        ]),
      });

      // Throttles alarm stays a plain absolute-count metric.
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/Lambda',
        MetricName: 'Throttles',
        Threshold: 1,
      });
    });

    void it('honors a custom ssrErrorRatePercent threshold', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        ssrFunction: newLambda(stack, 'Ssr'),
        ssrErrorRatePercent: 5,
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Threshold: 5,
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: '(errors / invocations) * 100' }),
        ]),
      });
    });
  });

  void describe('Image-opt Lambda alarm', () => {
    void it('is created when imageFunction is supplied', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        imageFunction: newLambda(stack, 'Img'),
      });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Threshold: 5,
      });
    });
  });

  void describe('Revalidation DLQ depth alarm', () => {
    void it('is created when revalidationDlq is supplied', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        revalidationDlq: new Queue(stack, 'Dlq'),
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/SQS',
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Threshold: 1,
        // ANY message in the DLQ is alarm-worthy. If we accidentally
        // raised this to e.g. 10, ISR could silently stall on smaller
        // failure bursts.
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    });
  });

  // ---- Comprehensive wiring ----

  void describe('full prop set', () => {
    void it('creates 5 alarms (1 CF + 2 SSR + 1 image + 1 DLQ) all pointing at the same topic', () => {
      const stack = createStack();
      const m = new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        distribution: newDistribution(stack),
        ssrFunction: newLambda(stack, 'Ssr'),
        imageFunction: newLambda(stack, 'Img'),
        revalidationDlq: new Queue(stack, 'Dlq'),
      });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
      template.resourceCountIs('AWS::SNS::Topic', 1);

      // Construct's `alarms` collection mirrors what's in the template.
      assert.strictEqual(m.alarms.length, 5);

      // Every alarm has an SNS action wired up. Drop into the
      // synthesized JSON because `Template.hasResourceProperties`
      // can't loop-assert against every match.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = template.toJSON() as any;
      const alarmResources: unknown[] = Object.values(json.Resources).filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => r['Type'] === 'AWS::CloudWatch::Alarm',
      );
      for (const alarm of alarmResources) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const props = (alarm as any)['Properties'];
        assert.ok(
          Array.isArray(props['AlarmActions']) &&
            props['AlarmActions'].length === 1,
          'each alarm should reference exactly one SNS action (the alarm topic)',
        );
      }
    });
  });

  // ---- Alarm topic encryption (KMS) ----

  // A CloudWatch alarm publishing to a KMS-encrypted SNS topic calls
  // KMS *directly*; if the key policy has no `cloudwatch.amazonaws.com`
  // statement the action fails with KMSAccessDenied and the
  // notification is dropped silently (the alarm still shows ALARM).
  // These tests are the regression guard for that grant.
  void describe('alarm topic encryption', () => {
    void it('encrypts the auto-created topic with a customer-managed key by default', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', { enabled: true });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::KMS::Key', 1);
      template.hasResourceProperties('AWS::SNS::Topic', {
        KmsMasterKeyId: Match.anyValue(),
      });
    });

    void it('grants cloudwatch.amazonaws.com kms:Decrypt and kms:GenerateDataKey* on the key', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', { enabled: true });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::KMS::Key', {
        KeyPolicy: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Principal: { Service: 'cloudwatch.amazonaws.com' },
              Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
              Resource: '*',
            }),
          ]),
        },
      });
    });

    void it('scopes the CloudWatch grant to this account without hard-failing when aws:SourceAccount is absent', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', { enabled: true });
      const template = Template.fromStack(stack);

      // `IfExists` matters: aws:SourceAccount is only populated on
      // direct service-principal calls, and a hard StringEquals would
      // reintroduce the silent deny this grant exists to prevent.
      template.hasResourceProperties('AWS::KMS::Key', {
        KeyPolicy: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'cloudwatch.amazonaws.com' },
              Condition: {
                StringEqualsIfExists: { 'aws:SourceAccount': '123456789012' },
              },
            }),
          ]),
        },
      });
    });

    void it('keeps the account-root admin statement on the key', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', { enabled: true });
      const template = Template.fromStack(stack);

      // The CloudWatch grant is additive — key administration must
      // still be delegable to IAM in the owning account.
      template.hasResourceProperties('AWS::KMS::Key', {
        KeyPolicy: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 'kms:*',
              Principal: { AWS: Match.anyValue() },
            }),
          ]),
        },
      });
    });

    void it('wires the alarm actions to the encrypted topic', () => {
      const stack = createStack();
      const m = new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        distribution: newDistribution(stack),
      });
      const template = Template.fromStack(stack);

      assert.ok(m.encryptionKey, 'construct should expose the topic key');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = template.toJSON() as any;
      const topicIds = Object.keys(json.Resources).filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (id) => (json.Resources[id] as any)['Type'] === 'AWS::SNS::Topic',
      );
      assert.strictEqual(topicIds.length, 1);
      const encryptedTopicId = topicIds[0] as string;
      assert.ok(
        json.Resources[encryptedTopicId]['Properties']['KmsMasterKeyId'],
        'the topic alarms publish to must be the encrypted one',
      );

      const alarm = Object.values(json.Resources).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => r['Type'] === 'AWS::CloudWatch::Alarm',
      );
      assert.deepStrictEqual(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (alarm as any)['Properties']['AlarmActions'],
        [{ Ref: encryptedTopicId }],
      );
    });

    void it('creates no key for a BYO topic — the caller owns its encryption', () => {
      const stack = createStack();
      const m = new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        snsTopic: new Topic(stack, 'UserTopic'),
      });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::KMS::Key', 0);
      assert.strictEqual(m.encryptionKey, undefined);
    });

    void it('creates no key when monitoring is disabled', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', { enabled: false });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::KMS::Key', 0);
    });
  });

  // ---- Threshold / period regression guards ----

  void describe('alarm thresholds and periods', () => {
    void it('uses 5-minute evaluation periods by default', () => {
      const stack = createStack();
      new MonitoringConstruct(stack, 'Monitoring', {
        enabled: true,
        ssrFunction: newLambda(stack, 'Ssr'),
      });
      const template = Template.fromStack(stack);

      // 5 minutes = 300s. If anyone changes the window, this fires
      // and they have to update the doc-comment on
      // `MonitoringConstruct` too.
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Period: 300,
      });
    });
  });
});

void Duration; // silence unused-import in a few node TS configs
