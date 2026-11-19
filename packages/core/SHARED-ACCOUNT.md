# Running many apps in one AWS account: the platform's side

The platform's part of [Running many apps in one AWS account](./README.md#running-many-apps-in-one-aws-account-a-shared-platform): the three shared IAM policies, the pipeline, the project template, and adopting `defaults.appIdentity` in an existing app. What each app sets (`defaults.appIdentity` and `defaults.permissionsBoundary`) is in the README section.

**3–5. The platform's policies.** The platform writes these three policies and owns them: AWS CDK Blocks never creates, changes or reads them. All three are shared: one of each per account, created once, never edited per app. Each one is keyed on the calling role's `app` tag (`${aws:PrincipalTag/app}`, which IAM resolves at request time), so the same document confines every app to its own names and tags:

| Policy | Attached to | What it does |
|---|---|---|
| `apps-boundary` | every role the app creates (`defaults.permissionsBoundary`) | caps what the app's code can do at runtime |
| `apps-exec` | each app's CDK bootstrap CloudFormation execution role | caps what the app's deploy can create and change |
| `apps-deploy-guard` | each app's CDK bootstrap deploy role | keeps the app's deploy on its own stacks and its own execution role |

Each app gets its own CDK bootstrap, tagged with its id, so the two roles in it carry the `app` tag the shared policies read:

```bash
cdk bootstrap aws://APPS_ACCOUNT/us-east-1 --qualifier appa --toolkit-stack-name CDKToolkit-appa --tags app=appa \
  --cloudformation-execution-policies arn:aws:iam::APPS_ACCOUNT:policy/apps-exec
```

CloudFormation propagates the stack tag to the bootstrap's roles. A role's `app` tag is what the policies trust, so no one may set it any other way: a session tag `app` would override it, and CDK's default bootstrap template allows `sts:TagSession` on its roles for principals in the account. Remove `sts:TagSession` from the deploy role's trust policy in the platform's bootstrap template (see [the deploy guard](#the-deploy-guard)).

The examples below use account `APPS_ACCOUNT` (replace it, and `aws` in the ARNs for another partition) and, where a command needs an id, app `appa`. Review them and test them on a deployed app in a sandbox account before relying on them.

## The shared permissions boundary

One managed policy for every app in the account, created once as `apps-boundary` and set as each app's `defaults.permissionsBoundary`. It's an allow-list: a service it has no statement for is denied, and IAM, Organizations and STS role assumption are never allowed:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OwnParameters",
      "Effect": "Allow",
      "Action": "ssm:*",
      "Resource": [
        "arn:aws:ssm:*:*:parameter/${aws:PrincipalTag/app}",
        "arn:aws:ssm:*:*:parameter/${aws:PrincipalTag/app}-*",
        "arn:aws:ssm:*:*:parameter/${aws:PrincipalTag/app}/*",
        "arn:aws:ssm:*:*:parameter/cdk/exports/${aws:PrincipalTag/app}",
        "arn:aws:ssm:*:*:parameter/cdk/exports/${aws:PrincipalTag/app}-*",
        "arn:aws:ssm:*:*:parameter/cdk/exports/${aws:PrincipalTag/app}/*",
        "arn:aws:ssm:*:*:parameter/cdk/EdgeFunctionArn/*/${aws:PrincipalTag/app}/*",
        "arn:aws:ssm:*:*:parameter/blocks/${aws:PrincipalTag/app}/*"
      ]
    },
    {
      "Sid": "OwnHostingSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:*",
      "Resource": [
        "arn:aws:secretsmanager:*:*:secret:blocks/${aws:PrincipalTag/app}/*"
      ]
    },
    {
      "Sid": "OwnTables",
      "Effect": "Allow",
      "Action": "dynamodb:*",
      "Resource": [
        "arn:aws:dynamodb:*:*:table/${aws:PrincipalTag/app}-*",
        "arn:aws:dynamodb:*:*:table/${aws:PrincipalTag/app}-*/*"
      ]
    },
    {
      "Sid": "OwnQueues",
      "Effect": "Allow",
      "Action": "sqs:*",
      "Resource": [
        "arn:aws:sqs:*:*:${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnBuckets",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::${aws:PrincipalTag/app}-*",
        "arn:aws:s3:::${aws:PrincipalTag/app}-*/*"
      ]
    },
    {
      "Sid": "ReadOwnCdkAssets",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::cdk-${aws:PrincipalTag/app}-assets-*",
        "arn:aws:s3:::cdk-${aws:PrincipalTag/app}-assets-*/*"
      ]
    },
    {
      "Sid": "OwnFunctions",
      "Effect": "Allow",
      "Action": "lambda:*",
      "Resource": [
        "arn:aws:lambda:*:*:function:${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnLogs",
      "Effect": "Allow",
      "Action": "logs:*",
      "Resource": [
        "arn:aws:logs:*:*:log-group:${aws:PrincipalTag/app}-*",
        "arn:aws:logs:*:*:log-group:/aws/lambda/${aws:PrincipalTag/app}-*",
        "arn:aws:logs:*:*:log-group:/aws/rds/cluster/${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "AgentCoreRuntimeLogsWriteOnly",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": [
        "arn:aws:logs:*:*:log-group:/aws/bedrock-agentcore/runtimes/*"
      ]
    },
    {
      "Sid": "OwnStacksRead",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStacks",
        "cloudformation:GetTemplate"
      ],
      "Resource": [
        "arn:aws:cloudformation:*:*:stack/${aws:PrincipalTag/app}/*",
        "arn:aws:cloudformation:*:*:stack/${aws:PrincipalTag/app}-*/*"
      ]
    },
    {
      "Sid": "OwnSchedules",
      "Effect": "Allow",
      "Action": "scheduler:*",
      "Resource": [
        "arn:aws:scheduler:*:*:schedule/*/${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnEvents",
      "Effect": "Allow",
      "Action": "events:*",
      "Resource": [
        "arn:aws:events:*:*:rule/${aws:PrincipalTag/app}-*",
        "arn:aws:events:*:*:event-bus/${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnDatabases",
      "Effect": "Allow",
      "Action": [
        "rds-data:*",
        "rds:*"
      ],
      "Resource": [
        "arn:aws:rds:*:*:cluster:${aws:PrincipalTag/app}-*",
        "arn:aws:rds:*:*:db:${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnVectorBuckets",
      "Effect": "Allow",
      "Action": "s3vectors:*",
      "Resource": [
        "arn:aws:s3vectors:*:*:bucket/${aws:PrincipalTag/app}-*",
        "arn:aws:s3vectors:*:*:bucket/${aws:PrincipalTag/app}-*/index/*"
      ]
    },
    {
      "Sid": "OwnTaggedResources",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:*",
        "states:*",
        "cognito-idp:*",
        "kms:*",
        "bedrock:*",
        "bedrock-agentcore:*",
        "dsql:*",
        "cloudfront:*",
        "cloudfront-keyvaluestore:*"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/app": "${aws:PrincipalTag/app}"
        }
      }
    },
    {
      "Sid": "AgentCoreDefaultDirectory",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:GetWorkloadAccessToken",
        "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
        "bedrock-agentcore:GetWorkloadAccessTokenForUserId"
      ],
      "Resource": "arn:aws:bedrock-agentcore:*:*:workload-identity-directory/default"
    },
    {
      "Sid": "AwsOwnedModelsRead",
      "Effect": "Allow",
      "Action": [
        "bedrock:GetFoundationModel",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*"
      ]
    },
    {
      "Sid": "ManagedKeysViaService",
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey*",
        "kms:DescribeKey"
      ],
      "Resource": "*",
      "Condition": {
        "StringLike": {
          "kms:ViaService": [
            "ssm.*.amazonaws.com",
            "secretsmanager.*.amazonaws.com",
            "dynamodb.*.amazonaws.com",
            "s3.*.amazonaws.com",
            "sqs.*.amazonaws.com"
          ]
        }
      }
    },
    {
      "Sid": "ResourcelessActions",
      "Effect": "Allow",
      "Action": [
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
        "xray:GetSamplingRules",
        "xray:GetSamplingTargets",
        "cloudwatch:PutMetricData",
        "logs:DescribeLogGroups",
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface",
        "ec2:AssignPrivateIpAddresses",
        "ec2:UnassignPrivateIpAddresses",
        "ec2:DescribeSubnets",
        "ec2:DescribeVpcs",
        "ec2:DescribeSecurityGroups",
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ListFoundationModels",
        "bedrock:ListInferenceProfiles",
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:SendBulkEmail"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ApisAccountWide",
      "Effect": "Allow",
      "Action": [
        "execute-api:Invoke",
        "execute-api:ManageConnections"
      ],
      "Resource": "arn:aws:execute-api:*:*:*/*"
    }
  ]
}
```

What each group of statements is for:

- **By name prefix** (`OwnParameters` to `OwnVectorBuckets`): resources named under the app's prefix (`<id>-…`; parameters also `<id>` and `<id>/…`). AWS CDK Blocks guarantees those names under `defaults.appIdentity`.
  - Covered: SSM parameters, DynamoDB tables, SQS queues, S3 buckets, Lambda functions, log groups (including `/aws/lambda/<id>-…` and a Database's `/aws/rds/cluster/<id>-…`), schedules, event rules and buses, RDS clusters and instances, and S3 Vectors buckets and the indexes in them.
  - `OwnStacksRead` lets a table's index manager read its own stack.
  - `OwnParameters` also covers CDK's cross-region references for the app's own stacks (`/cdk/exports/<id>…`), the Lambda@Edge ARNs CDK publishes for Hosting (`/cdk/EdgeFunctionArn/<region>/<id>/…`) and Hosting's `config()` values (`/blocks/<id>/…`).
  - `OwnHostingSecrets` covers Hosting's `secret()` values (`blocks/<id>/…`), which the CLI creates untagged.
- **The app's own CDK assets** (`ReadOwnCdkAssets`): read-only access to its own bootstrap's asset bucket (qualifier = app id), which `BucketDeployment` reads.
- **By the resource's `app` tag** (`OwnTaggedResources`): Secrets Manager, Step Functions, Cognito, KMS, Bedrock, AgentCore, Aurora DSQL and CloudFront resources are named by id, not by a name the app controls, so they're matched by `aws:ResourceTag/app`. S3 Vectors is matched by name instead (`OwnVectorBuckets`): a new index carries the tag of the app that creates it, so a tag rule would let App A create an index in App B's vector bucket (see "Fence children by their parent" in [The shared execution policy](#the-shared-execution-policy)).
- **Exceptions with no app scope, each as narrow as the service allows:**
  - `AgentCoreRuntimeLogsWriteOnly`: AgentCore runtimes log to AWS-named groups, write only.
  - `AgentCoreDefaultDirectory`: workload access tokens from the account's `default` directory; the workload identity itself stays tag-scoped.
  - `AwsOwnedModelsRead`: metadata of AWS-owned foundation models and system-defined inference profiles, not application inference profiles, which are tag-scoped.
  - `ManagedKeysViaService`: listed KMS operations through SSM, Secrets Manager, DynamoDB, S3 and SQS. The statement does not distinguish AWS-managed keys from customer-managed keys; the key policy and other applicable permissions still govern access.
  - `ResourcelessActions`: actions that take only `*`: X-Ray, `PutMetricData`, `DescribeLogGroups`, VPC network interfaces, model invocation and listing, SES.
- **API calls, account-wide** (`ApisAccountWide`): `execute-api:Invoke` (calling an IAM-authorized API) and `execute-api:ManageConnections` (posting to and disconnecting WebSocket clients, which Realtime publish/subscribe and every Agent's streaming use) on every API in the account. An API is named by its id, and these actions support no tag condition, so no statement can scope them to one app (see Limits, under [The pipeline](#the-pipeline)).

## The shared execution policy

Every app's CDK bootstrap execution role (the role CloudFormation deploys the app's stacks as) gets the shared `apps-exec` instead of `AdministratorAccess`: the `--cloudformation-execution-policies` in the bootstrap command above. Set the same `@aws-cdk/core:bootstrapQualifier` and `toolkitStackName` in the app's `cdk.json`. In the policy, `${aws:PrincipalTag/app}` is the execution role's own `app` tag, which its bootstrap set. The policy has two parts.

**The role fence.** It can only create roles that carry the boundary, are named `<id>-…` and are tagged `app=<id>`; it can never remove the boundary, edit the shared policies, re-tag a role to another app or untag it, or attach a broad AWS managed policy; and it reads only its own bootstrap's version parameter and asset bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RolesOnlyWithTheBoundary",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePermissionsBoundary"
      ],
      "Resource": "arn:aws:iam::APPS_ACCOUNT:role/${aws:PrincipalTag/app}-*",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::APPS_ACCOUNT:policy/apps-boundary"
        }
      }
    },
    {
      "Sid": "RoleLifecycle",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListRoleTags",
        "iam:DeleteRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:UpdateRoleDescription",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::APPS_ACCOUNT:role/${aws:PrincipalTag/app}-*"
    },
    {
      "Sid": "RequireThisAppsTag",
      "Effect": "Deny",
      "Action": "iam:CreateRole",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestTag/app": "${aws:PrincipalTag/app}"
        }
      }
    },
    {
      "Sid": "NoRetaggingToAnotherApp",
      "Effect": "Deny",
      "Action": "iam:TagRole",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestTag/app": "${aws:PrincipalTag/app}"
        },
        "ForAnyValue:StringEquals": {
          "aws:TagKeys": [
            "app"
          ]
        }
      }
    },
    {
      "Sid": "NoUntaggingApp",
      "Effect": "Deny",
      "Action": "iam:UntagRole",
      "Resource": "*",
      "Condition": {
        "ForAnyValue:StringEquals": {
          "aws:TagKeys": [
            "app"
          ]
        }
      }
    },
    {
      "Sid": "KeepTheBoundary",
      "Effect": "Deny",
      "Action": "iam:DeleteRolePermissionsBoundary",
      "Resource": "*"
    },
    {
      "Sid": "NoEditingTheSharedPolicies",
      "Effect": "Deny",
      "Action": [
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion"
      ],
      "Resource": [
        "arn:aws:iam::APPS_ACCOUNT:policy/apps-boundary*",
        "arn:aws:iam::APPS_ACCOUNT:policy/apps-exec*",
        "arn:aws:iam::APPS_ACCOUNT:policy/apps-deploy-guard"
      ]
    },
    {
      "Sid": "NoBroadManagedPolicies",
      "Effect": "Deny",
      "Action": "iam:AttachRolePolicy",
      "Resource": "*",
      "Condition": {
        "ArnLike": {
          "iam:PolicyARN": [
            "arn:aws:iam::aws:policy/AdministratorAccess",
            "arn:aws:iam::aws:policy/PowerUserAccess",
            "arn:aws:iam::aws:policy/IAMFullAccess",
            "arn:aws:iam::aws:policy/*FullAccess"
          ]
        }
      }
    },
    {
      "Sid": "ReadOwnBootstrapVersion",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters"
      ],
      "Resource": "arn:aws:ssm:*:APPS_ACCOUNT:parameter/cdk-bootstrap/${aws:PrincipalTag/app}/*"
    },
    {
      "Sid": "ReadOwnBootstrapAssets",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucket",
        "s3:GetBucket*"
      ],
      "Resource": [
        "arn:aws:s3:::cdk-${aws:PrincipalTag/app}-assets-APPS_ACCOUNT-*",
        "arn:aws:s3:::cdk-${aws:PrincipalTag/app}-assets-APPS_ACCOUNT-*/*"
      ]
    }
  ]
}
```

`RoleLifecycle` has no boundary condition, so `iam:PassRole` and `iam:DeleteRole` work on the app's existing roles; every role it can create already carries the boundary. `NoRetaggingToAnotherApp` denies only a tag write that sets `app`, so other tag updates still work.

**Per-service rules.** Add statements only for the resource types the platform's apps use (`jq -rs '[.[].Resources[]?.Type] | unique[]' cdk.out/*.template.json` for each app), each scoped to the app's names or its `app` tag. `<id>` below stands for `${aws:PrincipalTag/app}` in the policy, and `ACCOUNT` is the account id:

| Resource types | Scoped by |
|---|---|
| `AWS::Lambda::Function`, `Permission`, `Version`, `Alias`, `Url`, `EventInvokeConfig` | `lambda:*` on `arn:aws:lambda:*:ACCOUNT:function:<id>-*`, plus `lambda:GetAccountSettings` on `*` (read-only) |
| `AWS::Lambda::LayerVersion`, `LayerVersionPermission` | `lambda:PublishLayerVersion`, `DeleteLayerVersion`, `GetLayerVersion` on `layer:<id>-*` and `layer:<id>-*:*` |
| AWS's Lambda Web Adapter layer, which Hosting attaches to server-side rendering behind the API Gateway HTTP API door (for example a preview) | `lambda:GetLayerVersion` on `arn:aws:lambda:*:753240598075:layer:LambdaAdapterLayer*:*`: AWS's published layer, read only, no app's data. Without it, the deploy fails with `lambda:GetLayerVersion` denied |
| `AWS::Lambda::EventSourceMapping` | the mapping actions on `*` with `ArnLike` `lambda:FunctionArn` = `function:<id>-*`; tag writes on `event-source-mapping:*` with the request tag `app=<id>` on create and the resource tag after |
| `AWS::Logs::LogGroup`, `LogStream`, `SubscriptionFilter`, `MetricFilter`, `Custom::LogRetention` | `logs:*` on `log-group:<id>-*`, `log-group:/aws/lambda/<id>-*`, `log-group:/aws/rds/cluster/<id>-*`; `logs:DescribeLogGroups` on `*` |
| `AWS::DynamoDB::Table`, `GlobalTable` | `dynamodb:*` on `table/<id>-*` and `table/<id>-*/*` |
| `AWS::SQS::Queue`, `QueuePolicy` | `sqs:*` on `arn:aws:sqs:*:ACCOUNT:<id>-*` |
| `AWS::S3::Bucket`, `BucketPolicy` | `s3:*` on `arn:aws:s3:::<id>-*` and `arn:aws:s3:::<id>-*/*` |
| `AWS::SSM::Parameter` | `ssm:*` on `parameter/<id>`, `parameter/<id>-*`, `parameter/<id>/*`, `parameter/cdk/EdgeFunctionArn/*/<id>/*` |
| `Custom::CrossRegionExportReader`, `ExportWriter`, `StringParameterReader` | `ssm:GetParameter`, `GetParameters` on `parameter/cdk/exports/<id>`, `<id>-*`, `<id>/*` |
| `AWS::Scheduler::Schedule` | `scheduler:*` on `schedule/*/<id>-*` |
| `AWS::Events::Rule` | `events:*` on `rule/<id>-*` |
| `AWS::SNS::Topic`, `TopicPolicy`, `Subscription` | `sns:*` on `arn:aws:sns:*:ACCOUNT:<id>-*` |
| `AWS::CloudWatch::Alarm` | `PutMetricAlarm`, `DescribeAlarms`, `DeleteAlarms` and the tag actions on `alarm:<id>-*` |
| `AWS::CloudWatch::Dashboard` | `PutDashboard`, `GetDashboard`, `DeleteDashboards`, `TagResource`, `UntagResource`, `ListTagsForResource` on `dashboard/<id>-*`. Without the tag actions the deploy still succeeds: CloudFormation retries the create without tags (its events say "Retrying request without including tags") and the dashboard has no `app` tag |
| `AWS::IAM::ManagedPolicy` (logical ID `BlocksOverflowPolicy<hash>`) | the policy and policy-version actions on `arn:aws:iam::ACCOUNT:policy/<id>-*` (attachable only to the app's roles, through the fence) |
| `AWS::ResourceGroups::Group` | `resource-groups:*` on `group/<id>-*`; `cloudformation:DescribeStacks`, `ListStackResources`, `tag:GetResources` on `*` |
| `AWS::S3Vectors::VectorBucket`, `Index`, `VectorBucketPolicy` | by name, not tag: `s3vectors:*` on `bucket/<id>-*` and `bucket/<id>-*/index/*`, and a deny on every other bucket (`VectorBuckets` and `VectorBucketsOnlyOwn`, below) |
| `AWS::RDS::DBCluster`, `DBInstance`, `DBSubnetGroup`, `DBClusterParameterGroup`, `DBParameterGroup`, `OptionGroup` | `rds:*` on `cluster:`, `db:`, `subgrp:`, `cluster-pg:`, `pg:`, `og:`, `cluster-snapshot:` and `snapshot:<id>-*`; create and modify against RDS's `default…` parameter and option groups; `ec2:Describe*` on `*` |
| `AWS::CloudFront::Function` | `CreateFunction`, `DescribeFunction`, `GetFunction`, `UpdateFunction`, `PublishFunction`, `DeleteFunction`, `TestFunction` and `ListTagsForResource` on `arn:aws:cloudfront::ACCOUNT:function/<id>-*` |
| `AWS::SecretsManager::Secret`, `SecretTargetAttachment`, `ResourcePolicy`, `RotationSchedule` | tag (five statements, below), plus `secretsmanager:GetRandomPassword` on `*` (it reads nothing) |
| `AWS::ApiGateway::*` (APIs and their children) and `AWS::ApiGatewayV2::*` | tag (five statements, below), plus `apigateway:UpdateRestApiPolicy` on the `/restapis` collection |
| `AWS::Cognito::UserPool*` | tag |
| `AWS::KMS::Key`, `Alias` | tag; aliases by name, `alias/<id>-*` |
| `AWS::StepFunctions::StateMachine` | tag, on `stateMachine:*` and `execution:*` |
| `AWS::DSQL::Cluster` | tag |
| `AWS::ECS::Cluster`, `Service`, `TaskDefinition` | tag, on `cluster/*`, `service/*` and `task-definition/*` (task-definition families are CloudFormation-generated without a `-` after the id, so no name scopes them), plus the reads `DescribeTaskDefinition`, `ListTaskDefinitions`, `DescribeClusters`, `DescribeServices` and `DeregisterTaskDefinition` on `*` (an accepted exception: one app could deregister another app's task-definition revisions); and the cluster fence `EcsOnlyOwnClusters` (below) |
| `AWS::Bedrock::KnowledgeBase`, `DataSource` | tag (a data source is authorized against its knowledge base) |
| `AWS::EC2::VPC`, `Subnet`, `RouteTable`, `Route`, `SubnetRouteTableAssociation`, `SecurityGroup*`, `InternetGateway`, `VPCGatewayAttachment`, `NatGateway`, `EIP` | tag; creating a subnet, route table or security group, or attaching an internet gateway, also requires the VPC to be tagged `app=<id>`; security-group rules on `security-group-rule/*`; `ec2:Describe*` on `*` |
| `AWS::CloudFront::Distribution` | tag |
| `AWS::CloudFront::KeyValueStore` | tag (the create and manage statements; the denies on `cloudfront:*` come with the distribution's) |
| `AWS::CloudFront::OriginAccessControl`, `CachePolicy`, `OriginRequestPolicy`, `ResponseHeadersPolicy` | can't be scoped (see below) |
| `AWS::BedrockAgentCore::Runtime` | tag; the runtimes' workload identities are an accepted exception (see below) |
| `AWS::IAM::Role`, `Policy`, `RolePolicy`, `AWS::CDK::Metadata`, custom resources, wait conditions | the role fence; nothing else needed |

**Tag-scoped services: five statements each.** A service whose resources are named by id can't be scoped by name, so it's scoped by the `app` tag. A request tag alone never grants access to an existing resource:

1. **Create** only top-level resources, only tagged `app=<id>`.
2. **Manage** only resources (and their children, which are authorized against their parent's tag) already tagged `app=<id>`, tag writes included, so an untagged resource can't be claimed.
3. Deny anything on a resource tagged as another app (`NotAnotherApps`).
4. Deny any tag write that sets `app` to another value (`NoRetagging`).
5. Deny any tag write that removes `app` (`NoUntagging`).

For API Gateway (REST, HTTP and WebSocket APIs):

- A tag is written with `apigateway:PUT` and removed with `apigateway:DELETE` on `/tags/<resource ARN>`, so those are the actions the tag statements name.
- Creating an API Gateway v2 stage (a WebSocket API's, which Realtime and every Agent's streaming use) with tags is authorized as `apigateway:TagResource` on `arn:aws:apigateway:<region>::/apis/<api id>/stages`, so `ApisCreate` allows it with the request tag and `ApisNoRetagging` denies it for another app's tag. Without it the stage fails with `not authorized to perform: apigateway:TagResource`.
- IAM Access Analyzer reports `apigateway:TagResource` as `INVALID_ACTION` and the Service Authorization Reference doesn't list it, but IAM evaluates exactly that action on this call, and IAM accepts the policy with it.

```json
[
  {
    "Sid": "ApisCreate",
    "Effect": "Allow",
    "Action": [
      "apigateway:POST",
      "apigateway:PUT",
      "apigateway:TagResource"
    ],
    "Resource": [
      "arn:aws:apigateway:*::/restapis",
      "arn:aws:apigateway:*::/apis",
      "arn:aws:apigateway:*::/apis/*/stages",
      "arn:aws:apigateway:*::/tags/*"
    ],
    "Condition": {
      "StringEquals": {
        "aws:RequestTag/app": "${aws:PrincipalTag/app}"
      }
    }
  },
  {
    "Sid": "ApisManage",
    "Effect": "Allow",
    "Action": [
      "apigateway:GET",
      "apigateway:POST",
      "apigateway:PUT",
      "apigateway:PATCH",
      "apigateway:DELETE",
      "apigateway:UpdateRestApiPolicy"
    ],
    "Resource": [
      "arn:aws:apigateway:*::/restapis/*",
      "arn:aws:apigateway:*::/apis/*",
      "arn:aws:apigateway:*::/tags/*"
    ],
    "Condition": {
      "StringEquals": {
        "aws:ResourceTag/app": "${aws:PrincipalTag/app}"
      }
    }
  },
  {
    "Sid": "ApisNotAnotherApps",
    "Effect": "Deny",
    "Action": "apigateway:*",
    "Resource": "*",
    "Condition": {
      "StringNotEquals": {
        "aws:ResourceTag/app": "${aws:PrincipalTag/app}"
      },
      "Null": {
        "aws:ResourceTag/app": "false"
      }
    }
  },
  {
    "Sid": "ApisNoRetagging",
    "Effect": "Deny",
    "Action": [
      "apigateway:PUT",
      "apigateway:TagResource"
    ],
    "Resource": "*",
    "Condition": {
      "StringNotEquals": {
        "aws:RequestTag/app": "${aws:PrincipalTag/app}"
      },
      "ForAnyValue:StringEquals": {
        "aws:TagKeys": [
          "app"
        ]
      }
    }
  },
  {
    "Sid": "ApisNoUntagging",
    "Effect": "Deny",
    "Action": [
      "apigateway:DELETE"
    ],
    "Resource": "*",
    "Condition": {
      "ForAnyValue:StringEquals": {
        "aws:TagKeys": [
          "app"
        ]
      }
    }
  },
  {
    "Sid": "ApisPolicyOnCreate",
    "Effect": "Allow",
    "Action": "apigateway:UpdateRestApiPolicy",
    "Resource": "arn:aws:apigateway:*::/restapis"
  }
]
```

The other tag-scoped services follow the same pattern with their own actions: for example Secrets Manager creates with `secretsmanager:CreateSecret` on `*`, manages `secretsmanager:*` on `arn:aws:secretsmanager:*:ACCOUNT:secret:*`, and tags with `secretsmanager:TagResource` / `UntagResource`. An API's children (stages, deployments, routes, integrations) are authorized against their parent API's `app` tag, so `ApisManage` and `ApisNotAnotherApps` cover them too; the IAM report flags a stage, route or deployment attached to an API outside the app's own template (`api-outside-app`).

**Fence children by their parent.** For a resource created inside a parent, fence by the parent's name or a condition key that names the parent, not by the new child's tag. CloudFormation creates the child with the stack's tags, so it carries the creating app's `app` tag, and a tag rule alone lets App A create a child inside App B's parent.

- ECS services and tasks in a cluster: ECS authorizes `CreateService` and `RunTask` against the new service or task, with the cluster only in the `ecs:cluster` condition key. So the ECS statements add a deny on any cluster outside `cluster/<id>-*` (CloudFormation-generated cluster names start with the stack name).
- Vector indexes in a vector bucket: S3 Vectors authorizes `CreateIndex` against the new index. So S3 Vectors is matched by name, like S3, with a deny on every other bucket.
- Cognito app clients and groups in a user pool, and data sources in a Bedrock knowledge base, are authorized against the parent's ARN, so the parent's tag already fences them.

Check every tag-scoped service you add for the same case:

```json
[
  {
    "Sid": "EcsOnlyOwnClusters",
    "Effect": "Deny",
    "Action": [
      "ecs:CreateService",
      "ecs:UpdateService",
      "ecs:DeleteService",
      "ecs:RunTask",
      "ecs:StartTask",
      "ecs:StopTask",
      "ecs:CreateTaskSet",
      "ecs:UpdateTaskSet",
      "ecs:DeleteTaskSet",
      "ecs:UpdateServicePrimaryTaskSet"
    ],
    "Resource": "*",
    "Condition": {
      "Null": {
        "ecs:cluster": "false"
      },
      "ArnNotLike": {
        "ecs:cluster": "arn:aws:ecs:*:APPS_ACCOUNT:cluster/${aws:PrincipalTag/app}-*"
      }
    }
  },
  {
    "Sid": "VectorBuckets",
    "Effect": "Allow",
    "Action": "s3vectors:*",
    "Resource": [
      "arn:aws:s3vectors:*:APPS_ACCOUNT:bucket/${aws:PrincipalTag/app}-*",
      "arn:aws:s3vectors:*:APPS_ACCOUNT:bucket/${aws:PrincipalTag/app}-*/index/*"
    ]
  },
  {
    "Sid": "VectorBucketsOnlyOwn",
    "Effect": "Deny",
    "Action": [
      "s3vectors:CreateIndex",
      "s3vectors:DeleteIndex",
      "s3vectors:PutVectors",
      "s3vectors:DeleteVectors",
      "s3vectors:GetVectors",
      "s3vectors:QueryVectors",
      "s3vectors:ListVectors",
      "s3vectors:PutVectorBucketPolicy",
      "s3vectors:DeleteVectorBucketPolicy",
      "s3vectors:DeleteVectorBucket",
      "s3vectors:TagResource",
      "s3vectors:UntagResource"
    ],
    "NotResource": [
      "arn:aws:s3vectors:*:APPS_ACCOUNT:bucket/${aws:PrincipalTag/app}-*",
      "arn:aws:s3vectors:*:APPS_ACCOUNT:bucket/${aws:PrincipalTag/app}-*/index/*"
    ]
  }
]
```

**Service-linked roles.** The first deploy of some services in an account creates their service-linked role. Allow `iam:CreateServiceLinkedRole` on `arn:aws:iam::ACCOUNT:role/aws-service-role/*` with `StringEquals` `iam:AWSServiceName` listing only the services the platform's apps use: `rds.amazonaws.com` (RDS), `dsql.amazonaws.com` (DSQL), `runtime-identity.bedrock-agentcore.amazonaws.com` (AgentCore runtimes).

**CloudFront configuration types can't be scoped.** CloudFront origin access controls and cache, origin-request and response-headers policies are named by id and support no tag condition, so no statement can scope them to one app. Granting their `Create`, `Get`, `Get…Config`, `Update` and `Delete` actions on `origin-access-control/*`, `cache-policy/*`, `origin-request-policy/*` and `response-headers-policy/*` is an accepted exception: they hold configuration, not data, but App A's deploy could change or delete one of App B's. If that's not acceptable, leave them out and deploy those resources from the platform.

**AgentCore runtimes are scoped by tag; their workload identities aren't.**

- A runtime's name can't carry `<id>-` (no hyphens allowed), so scope `AWS::BedrockAgentCore::Runtime` by tag. Require the caller's `app` tag on creation and an existing matching resource tag for standalone tagging and management. Deny changing or removing the `app` tag. A request tag alone does not establish ownership of an existing runtime. If create-time tagging cannot be restricted separately from standalone tagging, have the platform provision and tag the runtime before delegating management.
- CloudFormation also creates each runtime's workload identity in the account-wide `default` directory, which carries no app tag. `CreateWorkloadIdentity`, `GetWorkloadIdentity`, `UpdateWorkloadIdentity` and `DeleteWorkloadIdentity` on `workload-identity-directory/default` and `workload-identity-directory/default/workload-identity/*` are an accepted exception: App A's deploy could change or delete one of App B's workload identities.
- The service-linked role (above) is still needed.

**`AWS::ApiGateway::Account`** is an account-level setting shared by every app in the region; set it from the platform.

**Size.** IAM limits a managed policy to 6,144 characters, not counting white space. With statements for the services a typical AWS CDK Blocks app uses, `apps-exec` goes over the limit.

- Split it, whole statements in order, into several shared policies (for example `apps-exec`, `apps-exec-2` and `apps-exec-3`, the role fence in the first).
- Staying around 5,000 characters each leaves room to add statements later without another policy, which every app's bootstrap would then need.
- Pass them all, comma-separated, to `cdk bootstrap --cloudformation-execution-policies`.
- `NoEditingTheSharedPolicies` covers every `apps-exec…` policy.

## The deploy guard

CDK's default bootstrap deploy role may change or delete *any* stack, and CloudFormation reuses a stack's previous service role when a request omits one, so without a guard App A's pipeline could deploy into — or delete — App B's stack as App B's execution role. The guard is one shared policy, `apps-deploy-guard`, attached to every app's CDK bootstrap deploy role; `${aws:PrincipalTag/app}` is that deploy role's own `app` tag:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlyThisAppsStacks",
      "Effect": "Deny",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:CancelUpdateStack",
        "cloudformation:ContinueUpdateRollback",
        "cloudformation:RollbackStack",
        "cloudformation:SetStackPolicy",
        "cloudformation:UpdateTerminationProtection",
        "cloudformation:SignalResource",
        "cloudformation:GetTemplate",
        "cloudformation:CreateStackRefactor",
        "cloudformation:ExecuteStackRefactor"
      ],
      "NotResource": [
        "arn:aws:cloudformation:*:APPS_ACCOUNT:stack/${aws:PrincipalTag/app}/*",
        "arn:aws:cloudformation:*:APPS_ACCOUNT:stack/${aws:PrincipalTag/app}-*/*"
      ]
    },
    {
      "Sid": "OnlyThisAppsExecutionRole",
      "Effect": "Deny",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack"
      ],
      "Resource": "*",
      "Condition": {
        "ArnNotLike": {
          "cloudformation:RoleArn": "arn:aws:iam::APPS_ACCOUNT:role/cdk-${aws:PrincipalTag/app}-cfn-exec-role-APPS_ACCOUNT-*"
        }
      }
    },
    {
      "Sid": "DeleteOnlyWithThisAppsExecutionRole",
      "Effect": "Deny",
      "Action": "cloudformation:DeleteStack",
      "Resource": "*",
      "Condition": {
        "Null": {
          "cloudformation:RoleArn": "false"
        },
        "ArnNotLike": {
          "cloudformation:RoleArn": "arn:aws:iam::APPS_ACCOUNT:role/cdk-${aws:PrincipalTag/app}-cfn-exec-role-APPS_ACCOUNT-*"
        }
      }
    },
    {
      "Sid": "StackTagAppIsThisApp",
      "Effect": "Deny",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack"
      ],
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestTag/app": "${aws:PrincipalTag/app}"
        }
      }
    },
    {
      "Sid": "NoStackRetagging",
      "Effect": "Deny",
      "Action": "cloudformation:TagResource",
      "Resource": "*",
      "Condition": {
        "ForAnyValue:StringEquals": {
          "aws:TagKeys": [
            "app"
          ]
        },
        "StringNotEquals": {
          "aws:RequestTag/app": "${aws:PrincipalTag/app}"
        }
      }
    },
    {
      "Sid": "NoStackUntagging",
      "Effect": "Deny",
      "Action": "cloudformation:UntagResource",
      "Resource": "*",
      "Condition": {
        "ForAnyValue:StringEquals": {
          "aws:TagKeys": [
            "app"
          ]
        }
      }
    },
    {
      "Sid": "NoResourceImport",
      "Effect": "Deny",
      "Action": "cloudformation:CreateChangeSet",
      "Resource": "*",
      "Condition": {
        "Null": {
          "cloudformation:ImportResourceTypes": "false"
        }
      }
    },
    {
      "Sid": "NoPlatformResourceTypes",
      "Effect": "Deny",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack"
      ],
      "Resource": "*",
      "Condition": {
        "ForAnyValue:StringLike": {
          "cloudformation:ResourceTypes": [
            "AWS::CloudFormation::*Hook*",
            "AWS::CloudFormation::TypeActivation",
            "AWS::CloudFormation::*Version",
            "AWS::CloudFormation::Publisher",
            "AWS::CloudFormation::Macro",
            "AWS::CloudFormation::StackSet"
          ]
        }
      }
    },
    {
      "Sid": "NoHookOrRegistryAdmin",
      "Effect": "Deny",
      "Action": [
        "cloudformation:SetTypeConfiguration",
        "cloudformation:ActivateType",
        "cloudformation:DeactivateType",
        "cloudformation:RegisterType",
        "cloudformation:DeregisterType",
        "cloudformation:SetTypeDefaultVersion",
        "cloudformation:PublishType",
        "cloudformation:RegisterPublisher",
        "cloudformation:TestType",
        "cloudformation:CreateStackSet",
        "cloudformation:UpdateStackSet",
        "cloudformation:DeleteStackSet",
        "cloudformation:CreateStackInstances",
        "cloudformation:UpdateStackInstances",
        "cloudformation:DeleteStackInstances",
        "cloudformation:ActivateOrganizationsAccess",
        "cloudformation:DeactivateOrganizationsAccess"
      ],
      "Resource": "*"
    }
  ]
}
```

- `OnlyThisAppsStacks` denies stack changes outside `<id>` and `<id>-…` — including the app's own bootstrap stack (`CDKToolkit-<id>`), which only the platform re-bootstraps. It names the stack actions that take a stack ARN, so `ExecuteChangeSet` (authorized against the stack, not the change set), `UpdateTerminationProtection` and the stack-refactor actions (`CreateStackRefactor`, `ExecuteStackRefactor`, which move resources between stacks) work only on the app's own stacks.
- `OnlyThisAppsExecutionRole` denies creating or changing a stack without naming the app's own execution role (`cdk-<id>-cfn-exec-role-…`), so CloudFormation can't fall back to another stack's role. It uses `ArnNotLike`, the operator for an ARN-typed key such as `cloudformation:RoleArn` (IAM Access Analyzer flags `StringNotLike` there).
- `DeleteOnlyWithThisAppsExecutionRole`: deleting one of the app's own stacks may omit the role — CDK does so when it cleans up a failed first deploy (`ROLLBACK_COMPLETE`) — but a role it names must be the app's own. That's safe: `OnlyThisAppsStacks` confines `DeleteStack` to `<id>` / `<id>-…` stacks, and those can only have been created with the app's own execution role, which is the role CloudFormation reuses.
  - If the platform's bootstrap or template turns on termination protection, a stack whose first create rolled back keeps it, and that cleanup fails until termination protection is turned off.
  - The guard allows `UpdateTerminationProtection` on the app's own stacks, so the pipeline can turn it off for its own `ROLLBACK_COMPLETE` stack, or turn protection on only after the first successful deploy.
- `StackTagAppIsThisApp` denies creating or changing a stack unless the request tags it `app=<id>`, and `NoStackRetagging` / `NoStackUntagging` deny setting a stack's `app` tag to another value or removing it. CloudFormation propagates stack tags to the resources it creates, including types a tag aspect can't reach.
- `NoResourceImport` denies change sets that import existing resources: an import would adopt a resource the app didn't create (another app's) into the app's stack.
- `NoHookOrRegistryAdmin` denies the listed direct administration actions by the deploy role. `NoPlatformResourceTypes` only matches types supplied in the request's `ResourceTypes` field; enforce the resource-type restriction separately through the execution role or a platform-owned template control.

**Prefer attaching it in a custom bootstrap template**, so CloudFormation owns both the role and the attachment:

1. Write the template out with `cdk bootstrap --show-template`.
2. Add `apps-deploy-guard` to the deploy role's managed policies and remove `sts:TagSession` from its trust policy.
3. Bootstrap with `cdk bootstrap --template <file>`.

Attaching it to the existing deploy role (`cdk-<id>-deploy-role-<account>-<region>`) works, but it's drift outside CloudFormation that a re-bootstrap won't restore, and it leaves `sts:TagSession` in place.

**Lambda@Edge (Hosting outside `us-east-1`).** CDK hoists edge functions into a `us-east-1` stack; with `defaults.appIdentity` set, AWS CDK Blocks names it `<id>-edge`, so the guard and the execution policy treat it as the app's own. Bootstrap the app in `us-east-1` too (same qualifier, same `app` tag, same execution policy) and attach the guard there.

## The pipeline

Run two commands, and fail the pipeline on a non-zero exit from either:

1. Synthesize without `reportOnly`, as in the project template below. Synth fails on any violation in the IAM report.
2. Confirm that every report names the id the platform gave this app, wasn't written with `reportOnly` (which the app's own code sets) and has no violations.

```bash
export APP_ID=appa
NODE_OPTIONS="--conditions=cdk" npx cdk synth --quiet   # fails on any violation
jq -e -s --arg id "$APP_ID" 'length > 0 and all(.[]; .app.id == $id and .app.reportOnly != true and (.violations | length) == 0)' cdk.out/*.blocks-iam.json
```

`APP_ID` comes from the platform, however it manages ids (a registry, picked by hand, generated): to AWS CDK Blocks it's just a string. It never comes from the app's own repository or code.

This is feedback, not the guarantee. Synth runs the app's own code, so it can write any report it likes. Run synth in a job with no AWS credentials and no `id-token` permission. Before a credentialed job deploys an assembly, validate the assembly and publish assets through a trusted process: CDK asset manifests can request executable asset sources or image builds. An assembly produced by untrusted code is not safe to deploy as-is.

**Optionally, check the templates themselves too.** The report comes from the app's own synth; the CloudFormation templates in `cdk.out` are what will be deployed. Before deploying, check that every `AWS::IAM::Role` carries the `apps-boundary` boundary and the tag `app=<id>`, and that every stack is named `<id>` or `<id>-…`:

```bash
for t in cdk.out/*.template.json; do
  jq -e --arg id "$APP_ID" '
    [.Resources[]? | select(.Type == "AWS::IAM::Role") | .Properties]
    | all(
        ((.PermissionsBoundary // "") | tojson | test("policy/apps-boundary\\\\?\"")) and
        any(.Tags[]?; .Key == "app" and .Value == $id)
      )' "$t" > /dev/null || { echo "A role in $t lacks the boundary or the app tag"; exit 1; }
done
jq -e --arg id "$APP_ID" '[.artifacts | to_entries[] | select(.value.type == "aws:cloudformation:stack")
  | (.value.properties.stackName // .key)] | all(. == $id or startswith($id + "-"))' cdk.out/manifest.json > /dev/null \
  || { echo "A stack isn't named $APP_ID or $APP_ID-…"; exit 1; }
```

The execution policy and the deploy guard enforce both anyway; the check fails the pipeline before the deploy does, with a clearer message.

**Limits.**

- **It isolates apps from each other, not handlers inside one app.** Every handler in an app still runs as the same role, under the same boundary.
- **Allow-list coverage.** A service the boundary has no statement for is denied at runtime (`AccessDenied`). Add statements for any service your apps use beyond AWS CDK Blocks' own. A few statements are scoped by resource tag rather than name (Cognito, Step Functions, Secrets Manager, KMS and others); check them on a deployed app.
- **Exceptions — cross-app reach the boundary still allows.**
  - `ses:SendEmail` / `SendRawEmail` / `SendBulkEmail` on `*`: App A can send as an identity App B verified. Scope SES by identity if your apps send email.
  - `ec2:DeleteNetworkInterface` on `*` (for VPC Lambdas): App A could delete another app's network interfaces.
  - AgentCore runtimes log to AWS-named log groups, which the boundary allows for writing only.
  - The CloudFront configuration types the execution policy can't scope, if you grant them.
- **VPC-attached compute isn't fully isolated.** An app's own ECS service in its own cluster can name another app's subnets, and its task then runs inside that app's VPC, reaching what that VPC's security groups and endpoints allow (with no security group given, the VPC's default group). No shared policy can stop it: the task's network interface is created by ECS's service-linked role, and a subnet is named only by its id, with no condition key carrying its owner's tag. Lambda `VpcConfig` and RDS subnet groups very likely have the same gap (not yet verified). To close it, check subnets outside the app's code with one of:
  - a CloudFormation Guard hook that allows only the app's own subnets in `AWS::ECS::Service` / `TaskSet` network configurations, Lambda `VpcConfig` and DB subnet groups (the hook can't tell a subnet's owner by itself, so the platform publishes which subnets belong to which app);
  - an SCP or per-app policy that names each app's subnets.
- **Runtime API calls aren't isolated.** The boundary allows `execute-api:Invoke` and `execute-api:ManageConnections` on every API in the account (`ApisAccountWide`), because neither can be scoped by name or tag. A compromised app could call another app's IAM-authorized APIs, or post to and disconnect another app's WebSocket clients (Realtime, Agent streaming), and the receiving app's handlers would treat an injected message as genuine. Deploying APIs is still isolated: the execution policy only creates and changes API Gateway APIs tagged as the app. If this gap isn't acceptable, give those apps their own AWS accounts.
- **It isolates apps, not an app's environments.** A preview (`HostingPresets.preview`, in a stack such as `<id>-preview`) is the same app to the policies: its roles carry the app's tag, so they can read and change production's resources too, including Hosting's `secret()` and `config()` values, which both read from the same `stackId`. Deploy an environment that mustn't reach production's data as an app of its own, with its own id and bootstrap.
- **No hotswap under the shared deploy guard.** CDK hotswaps (`cdk deploy --hotswap`, a preview's `--hotswap-fallback`) with the deploy role's own credentials, outside CloudFormation. The deploy role has no Lambda permissions, so the deploy fails with `lambda:UpdateFunctionCode` denied; `--hotswap-fallback` doesn't fall back on `AccessDenied`.
  - Deploy previews with `--method direct`.
  - To allow hotswap, grant the deploy role `lambda:UpdateFunctionCode`, `UpdateFunctionConfiguration`, `GetFunction` and `PublishVersion` on the app's own functions only (`function:<id>-preview-*` keeps it off production). Those changes skip CloudFormation, the execution policy and any Guard hook.
- **CDK's cross-region references.** Hosting's `us-east-1` stacks are wired to the app's stack by CDK's cross-region export writer, which is granted `/cdk/exports/*`. The IAM report exempts exactly that grant (its actions on that resource): it's CDK-internal, and the boundary caps it to the exports of the app's own stacks (`/cdk/exports/<id>…`). Likewise, CDK's Lambda@Edge ARN reader's read of `/cdk/EdgeFunctionArn/*` is capped by the boundary to the app's own stack path.
- **Account quotas are shared.** Each app adds roles and a bootstrap stack; at thousands of apps, spread them across several accounts.

## The app's side: what to put in your project template

Put these files in the platform's own project template (for example a copy of an AWS CDK Blocks starter such as `npm create @aws-cdk-blocks/blocks-app@latest my-app -- --template api-only`), so the identity and the boundary are there before anyone writes code. `APP_ID` is the app's id: the pipeline sets it, and a developer exports it for a sandbox (`APP_ID=<id> npm run sandbox`).

**`cdk-blocks/index.cdk.ts`.** The app id is the bootstrap qualifier and the stack name, and `defaults.appIdentity` sets the identity. Synth validates the id (pattern and reserved ids, with the reason), so the entry only has to check that `APP_ID` is set:

```typescript
import * as cdk from 'aws-cdk-lib';
import { BlocksStack, BlocksPresets } from 'aws-cdk-blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from 'aws-cdk-blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set by the platform's pipeline (to AWS CDK Blocks, just a string), never chosen by this repository.
const appId = process.env.APP_ID;
if (!appId) {
  throw new Error("APP_ID is not set. The platform's pipeline sets it; for a sandbox, export APP_ID=<your app id> first.");
}

// The app's own CDK bootstrap: `cdk bootstrap --qualifier <id>`.
const app = new cdk.App({ context: { '@aws-cdk/core:bootstrapQualifier': appId } });

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

// Keep stack names aligned with the CLI's deploy and destroy commands.
const stackName = getStackName({ sandbox: sandboxMode, projectRoot });

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: {
    ...(sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production),
    appIdentity: { id: appId },
    permissionsBoundary: 'apps-boundary',
  },
});
```

With `stackId` set to the app id below, production is named `<id>-prod` and a sandbox is named `<id>-<sandbox id>`.

**`cdk.json`.** AWS CDK Blocks' `npm run deploy` and `npm run sandbox` check the bootstrap with the qualifier in `cdk.json`, and the CDK CLI looks up the app's own toolkit stack. Add both to the starter's `cdk.json`, with the app's id:

```json
{
  "context": {
    "@aws-cdk/core:bootstrapQualifier": "<id>"
  },
  "toolkitStackName": "CDKToolkit-<id>"
}
```

**`.cdk-blocks/config.json`.** Set `stackId` to the app id, so Hosting's `secret()` and `config()` values are named `blocks/<id>/secrets/…` and `/blocks/<id>/config/…`, the app's own:

```json
{ "stackId": "<id>" }
```

**`package.json`.** A script that runs the pipeline's synth locally (`APP_ID` must be set). It fails on any violation in the IAM report:

```json
{
  "scripts": {
    "check:iam": "cdk synth --quiet"
  }
}
```

**`AGENTS.md`.** Rules for the coding agents that write the app:

```markdown
## Platform rules (this app runs on a shared app platform)

This app shares one AWS account with other apps. The platform rejects a deploy that breaks these rules:

- Build with Building Blocks only. Don't write IAM policies, roles or grants (`addToPrincipalPolicy`, `grant*` on raw CDK constructs), and don't attach managed policies.
- Never reference another app's resources. Don't call `fromExisting(...)` with a name or ARN that isn't this app's, and don't name resources yourself: the Building Blocks name them, and every name starts with this app's id.
- Don't edit the platform's files: `cdk-blocks/index.cdk.ts`, `cdk.json`, `.cdk-blocks/config.json` and the deploy workflow. They set this app's identity and permissions boundary. Ask a platform reviewer instead.
- Check before you push: `APP_ID=<this app's id> npm run check:iam` runs the pipeline's synth, which fails on any IAM violation (don't set `reportOnly`). The report is `cdk.out/<stack>.blocks-iam.json`; its `violations` say what to fix.
```

**The app's own code.** The boundary keeps apps apart, not users inside one app: gate every API method with `await auth.requireAuth(context)`, and keep each user's files under their own prefix (``files.putUrl(`${user.userId}/${path}`, …)``).

## Adopting `defaults.appIdentity` in an existing app

Resources that an app deployed before it set `defaults.appIdentity` have no `app` tag. The execution policy manages resources of the tag-scoped types only once they're tagged `app=<id>`, including the update that would add the tag, so the first deploy under it fails on them (`AccessDenied`, e.g. on `kms:DescribeKey`). That's on purpose: a policy that let a deploy tag an untagged resource would let any app claim one.

The tag-scoped types are the ones marked "tag" in the [per-service rules](#the-shared-execution-policy): Secrets Manager secrets, KMS keys, Cognito user pools, Step Functions state machines, API Gateway APIs, CloudFront distributions and KeyValueStores, DSQL clusters, ECS clusters, services and task definitions, Bedrock knowledge bases, AgentCore runtimes and EC2 VPC resources. Adopt in this order:

1. **The stack names must already start with the id** (`<id>` or `<id>-…`): a stack can't be renamed, so another name means new stacks (and moving the data), not adoption.
2. **An admin, not the app's pipeline, tags the app's existing resources `app=<id>` once**, before the first deploy under the execution policy. Do it for each of the app's stacks, in its region and in `us-east-1` (Hosting's `<id>-CfMonitoring-…` stack, and CloudFront's global resources, which the Tagging API lists in `us-east-1`). CloudFormation tags what it creates `aws:cloudformation:stack-name`, so the Resource Groups Tagging API can find and tag them (`tag-resources` takes up to 20 ARNs at a time):

   ```bash
   STACK=<stack name>; REGION=<region>; APP=<id>
   aws resourcegroupstaggingapi get-resources --region "$REGION" \
     --tag-filters "Key=aws:cloudformation:stack-name,Values=$STACK" \
     --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' |
     xargs -n 20 aws resourcegroupstaggingapi tag-resources --region "$REGION" --tags "app=$APP" --resource-arn-list
   ```

   Compare with `aws cloudformation list-stack-resources --stack-name "$STACK" --region "$REGION"`, which lists every resource in the stack, and tag any tag-scoped one the first command missed with its service's own tag command. Tag IAM roles with `aws iam tag-role --role-name <role> --tags Key=app,Value=<id>` (the execution policy manages the app's roles by their `<id>-…` name, and the deploy adds the tag, so this is optional).
3. **Set `stackId` in `.cdk-blocks/config.json` to the id**, if it isn't already. Hosting's `secret()` and `config()` values move to `blocks/<id>/secrets/…` and `/blocks/<id>/config/…`, so set each value again (`npm run secret -- set …`, `npm run config -- set …`) before deploying; the old ones stay where they were until you delete them. If `index.cdk.ts` builds the stack name from `stackId` (`getStackName()`, `<stackId>-prod`), changing it renames the stack: see step 1.
4. **Expect replacements on the first deploy.**
   - AWS CDK Blocks renames the CloudFront Functions and KeyValueStores it creates to `<id>-<region>-…`, and a new name replaces the resource.
   - CloudFormation then tries to delete the old ones. The old Functions fail to delete (`DELETE_FAILED`, skipped; the stack still reaches `UPDATE_COMPLETE`), because their names (`<region>…`) are outside the app's prefix, and so can the old KeyValueStores still associated with them. An admin deletes them once: `aws cloudfront delete-function --name <name> --if-match <ETag from describe-function>`, then `aws cloudfront delete-key-value-store --name <name> --if-match <ETag from describe-key-value-store>`.
   - Hosting's Lambda@Edge stack (Hosting outside `us-east-1`) becomes a new stack, `<id>-edge` (CDK named it `edge-lambda-stack-<hash>`). The app's deploy guard can't touch the old one, so an admin deletes it once the distribution no longer uses its functions (Lambda@Edge replicas can take hours to release).
