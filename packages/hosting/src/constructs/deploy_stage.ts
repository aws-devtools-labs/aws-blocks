// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Construct } from 'constructs';

/**
 * Whether `scope` is synthesized for a sandbox deploy: the CDK context key
 * `sandboxMode` the sandbox scripts pass (`-c sandboxMode=true`), the same
 * rule as `isSandboxContext` in `@aws-blocks/core/cdk`. Anything else is a
 * production deploy.
 *
 * The plain-HTTP checks use it: a plain-HTTP front door
 * (`PlainHttpFrontDoorError`) and the origin-verify secret over a plain-HTTP
 * edge → router hop (`OriginSecretOverPlainHttpError`) fail synth outside a
 * sandbox, and only warn in one.
 *
 * @internal
 */
export const isSandboxDeploy = (scope: Construct): boolean => {
  const value: unknown = scope.node.tryGetContext('sandboxMode');
  return value === 'true' || value === true;
};
