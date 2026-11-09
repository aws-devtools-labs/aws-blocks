// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drop the AWS CLI layers no function uses, for an in-place (preview) build.
 *
 * Every CDK `BucketDeployment` creates its own `AwsCliLayer` and hands it to
 * the stack's shared upload handler, a singleton per memory size. Only the
 * first deployment of each size creates that handler, so the other
 * deployments' layers are published on every create but attached to nothing.
 * CloudFormation still waits for each of them before the stack completes; the
 * one under the last upload (the resolved runtime config) ends the stack.
 *
 * Which layers are in use is read from the stack's Lambda functions (their
 * resolved `Layers`), never inferred from construct names, so a layer a
 * handler references is always kept.
 *
 * @internal Framework-only. Called for an in-place build only
 * (`HostingConstructProps.inPlaceBuild`, core `Hosting` `buildId: 'fixed'`);
 * the default and production templates keep every layer.
 */
import { CfnResource, Stack } from 'aws-cdk-lib';
import { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { AwsCliLayer } from 'aws-cdk-lib/lambda-layer-awscli';
import type { Construct, IConstruct } from 'constructs';

/** Matches by class and by name, so a second copy of `aws-cdk-lib` in the app still matches. */
const isA = <T>(c: IConstruct, cls: abstract new (...args: never[]) => T, name: string): c is IConstruct & T =>
  c instanceof cls || c.constructor?.name === name;

/**
 * Remove every `AwsCliLayer` under `scope` that no Lambda function in its
 * stack references.
 *
 * @param scope the subtree to prune (a `Hosting` or `HostingConstruct`).
 * @returns the construct paths of the removed layers.
 */
export const removeUnusedAwsCliLayers = (scope: Construct): string[] => {
  const stack = Stack.of(scope);
  const used = new Set<string>();
  for (const c of stack.node.findAll()) {
    if (!isA(c, CfnFunction, 'CfnFunction')) continue;
    const layers: unknown = stack.resolve(c.layers);
    if (!Array.isArray(layers)) continue;
    for (const layer of layers) {
      if (layer && typeof layer === 'object' && 'Ref' in layer && typeof layer.Ref === 'string') used.add(layer.Ref);
    }
  }
  const unused = scope.node.findAll().filter((c) => {
    if (!isA(c, AwsCliLayer, 'AwsCliLayer')) return false;
    const cfn = c.node.defaultChild;
    if (!cfn || !isA(cfn, CfnResource, 'CfnLayerVersion')) return false;
    return !used.has(stack.resolve((cfn as CfnResource).logicalId));
  });
  const removed: string[] = [];
  for (const layer of unused) {
    const parent = layer.node.scope;
    if (parent?.node.tryRemoveChild(layer.node.id)) removed.push(layer.node.path);
  }
  return removed;
};
