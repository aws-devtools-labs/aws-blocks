// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Seeds a deterministic, CONFIRMED Cognito user into the deployed native-bindings
// AuthCognito pool so the returning-customer e2e path
// (native/dart/example/bin/e2e/auth_cognito_test.dart) can sign in WITHOUT an
// emailed confirmation code.
//
// Why a post-deploy admin seed (vs. the sign-up→code→confirm flow): real Cognito
// emails the confirmation code, so CI can't read it back. AdminCreateUser
// (MessageAction SUPPRESS, email_verified) + AdminSetUserPassword (Permanent)
// produces a confirmed user that can sign in immediately.
//
// TEST-ONLY: this targets throwaway `bb-test-*` stacks. The credentials are a
// deterministic fixture (defaults below), overridable via env, never a secret.
//
// Usage (run after `npm run deploy`, from test-apps/native-bindings):
//   AWS_REGION=us-east-1 BLOCKS_STACK_SUFFIX=<suffix> npm run seed:cognito
//   # or, for the fixed developer/verify sandbox:
//   AWS_REGION=us-west-2 BLOCKS_STACK_NAME=bb-test-native-bindings-dart npm run seed:cognito
//
// The @aws-sdk/client-* packages resolve from the hoisted monorepo node_modules
// (not declared as a direct dependency here, to avoid a lockfile change).

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  MessageActionType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';

const REGION = process.env.AWS_REGION || 'us-east-1';

// Resolve the deployed stack name exactly the way index.cdk.ts does.
const STACK_NAME =
  process.env.BLOCKS_STACK_NAME ||
  (process.env.BLOCKS_STACK_SUFFIX
    ? `bb-test-nb-${process.env.BLOCKS_STACK_SUFFIX}`
    : 'bb-test-native-bindings-dart');

// Defaults MUST match auth_cognito_test.dart's _defaultReturningUsername /
// _defaultReturningPassword. Password satisfies the pool policy (>= 8, has digit).
const USERNAME = process.env.COGNITO_TEST_USERNAME || 'e2e-returning-user';
const PASSWORD = process.env.COGNITO_TEST_PASSWORD || 'Returning1Pass!';
const EMAIL = process.env.COGNITO_TEST_EMAIL || `${USERNAME}@example.com`;

async function findUserPoolId(stackName: string): Promise<string> {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  const pools = (res.StackResources ?? []).filter(
    (r) => r.ResourceType === 'AWS::Cognito::UserPool',
  );
  if (pools.length === 0) {
    throw new Error(`No AWS::Cognito::UserPool found in stack ${stackName}`);
  }
  if (pools.length > 1) {
    // native-bindings declares exactly one Cognito pool (auth-cognito). Guard so
    // this fails loudly rather than seeding the wrong pool if that ever changes.
    throw new Error(
      `Expected exactly one Cognito UserPool in ${stackName}, found ${pools.length}: ` +
        pools.map((p) => p.LogicalResourceId).join(', '),
    );
  }
  return pools[0].PhysicalResourceId!;
}

async function main() {
  console.log('[seed-cognito-user] resolving user pool from CloudFormation stack...');
  const poolId = await findUserPoolId(STACK_NAME);
  console.log('[seed-cognito-user] resolved user pool, seeding test user...');

  const cog = new CognitoIdentityProviderClient({ region: REGION });

  // Idempotent: AdminCreateUser fails with UsernameExistsException on re-seed,
  // which we tolerate (the AdminSetUserPassword below still re-establishes the
  // known permanent password).
  try {
    await cog.send(
      new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: USERNAME,
        MessageAction: MessageActionType.SUPPRESS,
        UserAttributes: [
          { Name: 'email', Value: EMAIL },
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
    );
    console.log('[seed-cognito-user] created user');
  } catch (e: any) {
    if (e?.name === 'UsernameExistsException') {
      console.log('[seed-cognito-user] user already exists — reusing');
    } else {
      throw e;
    }
  }

  await cog.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: USERNAME,
      Password: PASSWORD,
      Permanent: true,
    }),
  );
  console.log('[seed-cognito-user] set permanent password — user is CONFIRMED and ready');
}

main().catch((e) => {
  console.error('[seed-cognito-user] FAILED:', e);
  process.exit(1);
});
