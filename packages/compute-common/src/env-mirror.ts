// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Resolve the Lambda handler's final environment variables into their
 * CloudFormation-shaped values (plain strings or intrinsic objects like
 * `{ "Fn::GetAtt": ... }`).
 *
 * Must be called during synthesis (inside an Aspect visit), after all
 * Building Blocks and app code finished calling `addEnvironment` — the
 * Lambda renders its environment lazily, so resolving earlier would miss
 * late additions.
 */
export function resolveHandlerEnvironment(handler: lambda.Function): Record<string, unknown> {
  const stack = cdk.Stack.of(handler);
  const cfnFunction = handler.node.defaultChild as lambda.CfnFunction;
  const resolved = stack.resolve(cfnFunction.environment);
  // The L2 Function renders `{ variables }` (property casing); a raw override
  // or template shape would be `{ Variables }`. Accept both.
  return (resolved?.variables ?? resolved?.Variables ?? {}) as Record<string, unknown>;
}

/**
 * The Lambda handler's environment variables as string tokens that survive
 * JSON embedding.
 *
 * Use this where the values go into a JSON document that CDK stringifies
 * itself (e.g. a `KubernetesManifest`): plain strings pass through, and
 * resolved intrinsics (Ref / Fn::GetAtt) are re-tokenized with
 * `Token.asString` so `toJsonString` renders them as CloudFormation joins
 * instead of literal `{"Fn::GetAtt": ...}` text.
 *
 * Must be called during synthesis (typically inside a `cdk.Lazy` producer)
 * so late `addEnvironment` calls are captured.
 */
export function handlerEnvironmentForJson(handler: lambda.Function): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolveHandlerEnvironment(handler))) {
    entries[key] = typeof value === 'string' ? value : cdk.Token.asString(value);
  }
  return entries;
}

/**
 * Mirror the Lambda handler's environment into the first container of an ECS
 * task definition at synth time, merged with container-specific variables
 * (which take precedence on key collisions).
 *
 * Why an Aspect: Building Blocks attach env vars to the handler throughout
 * construction, and app code may add more after `BlocksStack.create()`
 * returns. Aspects run at synthesis, after all of that — the one point where
 * the handler environment is complete. The values are written through a
 * property override so intrinsic references (Ref / Fn::GetAtt) survive.
 */
export function mirrorHandlerEnvironmentToContainer(
  handler: lambda.Function,
  taskDefinition: ecs.TaskDefinition,
  containerEnv: Record<string, string>,
  exclude: string[] = [],
): void {
  cdk.Aspects.of(taskDefinition).add({
    visit(node) {
      if (node !== taskDefinition) return;
      const stack = cdk.Stack.of(taskDefinition);

      const merged = new Map<string, unknown>();
      for (const [key, value] of Object.entries(resolveHandlerEnvironment(handler))) {
        if (!exclude.includes(key)) merged.set(key, value);
      }
      for (const [key, value] of Object.entries(containerEnv)) {
        merged.set(key, stack.resolve(value));
      }

      const cfnTaskDefinition = taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
      cfnTaskDefinition.addPropertyOverride(
        'ContainerDefinitions.0.Environment',
        [...merged.entries()].map(([name, value]) => ({ Name: name, Value: value })),
      );
    },
  });
}
