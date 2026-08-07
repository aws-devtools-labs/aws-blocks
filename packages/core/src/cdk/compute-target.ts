// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as cdk from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * Service principals a container compute target needs on the shared backend
 * execution role, in addition to `lambda.amazonaws.com`.
 *
 * - `ecs-tasks.amazonaws.com` — ECS task role
 * - `pods.eks.amazonaws.com` — EKS Pod Identity (also requires `sts:TagSession`,
 *   which the role factory adds automatically for this principal)
 */
export type ComputePrincipal = 'ecs-tasks.amazonaws.com' | 'pods.eks.amazonaws.com';

/**
 * Structured CloudFront/HTTP origin for the Blocks API.
 *
 * Container compute targets produce URLs without an API Gateway stage segment,
 * so consumers (e.g. Hosting) must not parse the stage out of {@link ComputeBindResult.apiUrl}.
 * This carries the origin parts explicitly instead.
 */
export interface ComputeApiOrigin {
  /** Origin hostname (no scheme), e.g. `d111111abcdef8.cloudfront.net`. May be a CDK token. */
  readonly hostname: string;
  /** Origin path prefix including leading slash, or `''` when the origin serves from root. */
  readonly originPath: string;
}

/**
 * Everything a compute target needs to provision container infrastructure for
 * a Blocks backend. Handed to {@link ComputeTarget.bind} during
 * `BlocksStack.create()` / `BlocksBackend.create()`.
 */
export interface ComputeBindContext {
  /** Construct scope to create container resources under (the BlocksStack or BlocksBackend). */
  readonly scope: Construct;
  /**
   * Logical id of the Blocks backend (the BlocksStack id / BlocksBackend construct id).
   * Token-free; safe to embed in construct ids and physical resource names.
   */
  readonly id: string;
  /**
   * The companion Lambda. In container mode it keeps serving event sources
   * (SQS, EventBridge Scheduler, WebSocket, CloudFormation custom resources)
   * and remains the construct Building Blocks attach grants and env vars to.
   */
  readonly handler: cdk.aws_lambda_nodejs.NodejsFunction;
  /**
   * The shared execution role. Assumed by the Lambda AND the container
   * principal(s) from {@link ComputeTarget.requiredPrincipals}, so every IAM
   * grant a Building Block makes against the handler applies to containers too.
   */
  readonly sharedRole: iam.Role;
  /** Absolute path to the app's backend handler entry (same entry the Lambda bundles). */
  readonly backendHandlerPath: string;
  /** Whether the app is being deployed via `npm run sandbox` (dev sandbox context). */
  readonly isSandbox: boolean;
}

/** Result of {@link ComputeTarget.bind}: the front door the container serves. */
export interface ComputeBindResult {
  /**
   * Full RPC URL ending in `/aws-blocks/api` — same semantic as the API
   * Gateway `apiUrl` today. Surfaced as the `ApiUrl` stack output and consumed
   * by deploy/sandbox tooling and generated clients. May contain CDK tokens.
   */
  readonly apiUrl: string;
  /** Structured origin for CloudFront consumers; see {@link ComputeApiOrigin}. */
  readonly apiOrigin: ComputeApiOrigin;
}

/**
 * A pluggable production compute target for the Blocks backend.
 *
 * By default the backend runs on Lambda behind API Gateway. Passing a
 * `ComputeTarget` via `BlocksStackProps.compute` replaces the HTTP front door
 * with load-balanced containers (ECS, EKS, …) running the same bundle, while
 * the companion Lambda keeps handling event-source triggers.
 *
 * Lifecycle within `BlocksStack.create()` / `BlocksBackend.create()`:
 * 1. `requiredPrincipals` is read before any resource exists, to build the shared role.
 * 2. `bind()` runs where API Gateway would otherwise be created — before the
 *    app's `backendCDKPath` module is imported, so `apiUrl` is available to
 *    Building Blocks during construction.
 * 3. `finalize()` runs after `finalizeConfigRegistry()`, once every Building
 *    Block has attached its env vars and grants — the point where a target can
 *    mirror the handler's environment into the container definition and add
 *    deploy-ordering dependencies (e.g. on the config bucket deployment).
 */
export interface ComputeTarget {
  /** Container service principals to trust on the shared execution role. */
  readonly requiredPrincipals: ReadonlyArray<ComputePrincipal>;
  /** Provision container infrastructure and return the HTTP front door. */
  bind(ctx: ComputeBindContext): ComputeBindResult;
  /** Late hook after all Building Blocks registered config/env/grants. */
  finalize(ctx: ComputeBindContext): void;
}
