// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Seeds a deterministic, CONFIRMED Cognito user into EVERY user pool of the
// deployed native-bindings stack — the `auth-basic` and `auth-cognito` `Auth`
// blocks each own one (`auth-oidc` federates directly and owns none) — so the
// returning-customer e2e paths (the native auth + todos suites, e.g.
// native/dart/example/bin/e2e/auth_cognito_test.dart) can sign in WITHOUT an
// emailed confirmation code.
//
// Why a post-deploy admin seed (vs. the sign-up→code→confirm flow): `Auth`
// confirms every self-service sign-up with an emailed code, and real Cognito
// emails it, so CI can't read it back. AdminCreateUser (MessageAction SUPPRESS,
// email_verified) + AdminSetUserPassword (Permanent) produces a confirmed user
// that can sign in immediately.
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

// Defaults MUST match the native suites' returning user (Dart harness.dart
// `returningUser()`, Kotlin BlocksE2ETestCase.kt `returningUser()`, Swift
// BlocksE2ETestCase.swift `returningUser()`). The password satisfies both pools'
// policies (>= 8, upper, lower, digit, symbol).
const USERNAME = process.env.COGNITO_TEST_USERNAME || 'e2e-returning-user';
const PASSWORD = process.env.COGNITO_TEST_PASSWORD || 'Returning1Pass!';
const EMAIL = process.env.COGNITO_TEST_EMAIL || `${USERNAME}@example.com`;

// The pool-owning `Auth` blocks in aws-blocks/index.ts: auth-basic, auth-cognito.
const EXPECTED_POOLS = 2;

/** Every Cognito user pool in the stack, by logical id. */
async function findUserPoolIds(stackName: string): Promise<{ logicalId: string; poolId: string }[]> {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  const pools = (res.StackResources ?? []).filter(
    (r) => r.ResourceType === 'AWS::Cognito::UserPool' && r.PhysicalResourceId,
  );
  // native-bindings declares two pool-owning Auth blocks (auth-basic,
  // auth-cognito). Fail loudly rather than silently seed a partial set if that
  // ever changes.
  if (pools.length !== EXPECTED_POOLS) {
    throw new Error(
      `Expected ${EXPECTED_POOLS} Cognito user pools in ${stackName}, found ${pools.length}: ` +
        pools.map((p) => p.LogicalResourceId).join(', '),
    );
  }
  return pools.map((p) => ({ logicalId: p.LogicalResourceId ?? '?', poolId: p.PhysicalResourceId ?? '' }));
}

/** Create (or reuse) the confirmed user in one pool and pin its permanent password. */
async function seedPool(cog: CognitoIdentityProviderClient, poolId: string, label: string): Promise<void> {
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
    console.log(`[seed-cognito-user] ${label}: created user`);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'UsernameExistsException') {
      console.log(`[seed-cognito-user] ${label}: user already exists — reusing`);
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
  console.log(`[seed-cognito-user] ${label}: set permanent password — user is CONFIRMED and ready`);
}

async function main() {
  console.log('[seed-cognito-user] resolving user pools from CloudFormation stack...');
  const pools = await findUserPoolIds(STACK_NAME);
  const cog = new CognitoIdentityProviderClient({ region: REGION });
  for (const { logicalId, poolId } of pools) {
    await seedPool(cog, poolId, logicalId);
  }
}

main().catch((e) => {
  console.error('[seed-cognito-user] FAILED:', e);
  process.exit(1);
});
