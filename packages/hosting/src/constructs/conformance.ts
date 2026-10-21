// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Conformance test kit for a bring-your-own front door ({@link FrontDoor}).
 *
 * Call it from the door author's OWN tests (`node:test` or any runner) to catch
 * a malformed door before an app synthesizes it. It builds the door once
 * against a sample {@link DoorInput} — in a throwaway stack, with a real assets
 * bucket and, by default, an API — and checks three things, the same three
 * AWS Blocks enforces at synth:
 *   1. Shape — `service` is a non-empty string and `build` is a function.
 *   2. `build` returns a non-empty public `url`.
 *   3. Wiring — the static assets are reachable and, when the input has an
 *      API, its paths reach it (as recorded by the `cf.*` helpers or
 *      `cf.recordWired`).
 *
 * It does not check features: AWS Blocks never verifies that a door applies
 * what `input.features` asks for.
 *
 * @throws HostingError (not tied to any test runner) on the first failed check.
 */
import { App, Stack } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { type BuildFrontDoorOptions, buildFrontDoor, type FrontDoorBuild } from './custom_door.js';
import { BLOCKS_API_SUBTREE } from './door_input.js';
import type { DoorInput, FrontDoor, FrontDoorResult } from './front_door.js';

/** Options for {@link assertDoorConformance}. */
export type DoorConformanceOptions = {
  /** Scope to build under (a throwaway App/Stack is created when omitted). */
  scope?: Construct;
  /**
   * The input to build the door with. Defaults to a static SPA with an API
   * (`/aws-blocks/*`) — the baseline every door must serve. Receives the scope
   * so it can create the CDK handles it needs.
   */
  input?: (scope: Construct) => DoorInput;
  /** Skip the wiring check, mirroring `frontDoor: { kind: 'custom', wiringCheck: false }`. */
  wiringCheck?: BuildFrontDoorOptions['wiringCheck'];
};

/** The baseline input: a static SPA in a private bucket, plus an API. */
const baselineInput = (scope: Construct): DoorInput => {
  const assets = {
    kind: 'assets' as const,
    bucket: new Bucket(scope, 'ConformanceAssets'),
    prefix: 'builds/conformance/',
    sourceDir: '.',
  };
  return {
    app: {
      buildId: 'conformance',
      spaFallback: true,
      routes: [{ pattern: '/*', origin: assets }],
      redirects: [],
      headers: [],
    },
    origins: {
      assets,
      api: {
        kind: 'api',
        url: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api',
        host: 'abc123.execute-api.us-east-1.amazonaws.com',
        stagePath: '/prod',
        paths: [BLOCKS_API_SUBTREE],
      },
    },
    features: {},
  };
};

/**
 * Assert a bring-your-own front door conforms (see the module doc). Throws on
 * the first failure; returns the build (the door's result + wiring record)
 * when it conforms.
 */
export function assertDoorConformance<TResult extends FrontDoorResult>(
  door: FrontDoor<DoorInput, TResult>,
  options: DoorConformanceOptions = {},
): FrontDoorBuild<TResult> {
  const scope =
    options.scope ??
    new Stack(new App(), 'DoorConformanceStack', { env: { account: '111111111111', region: 'us-east-1' } });
  const input = (options.input ?? baselineInput)(scope);
  return buildFrontDoor(scope, door, input, { wiringCheck: options.wiringCheck });
}
