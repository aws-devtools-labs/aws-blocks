// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ALB front door, written as a free-form door — renders the app's route table
 * onto an Application Load Balancer (see {@link AlbConstruct}).
 *
 * `build` creates the ALB: listener rules route static paths to an asset-proxy
 * Lambda (private S3, build-id-prefixed keys), SSR and image paths to their
 * Lambdas, apply the app's redirects, and proxy the same-origin API through a
 * forwarder Lambda. Natively, it adds an HTTPS listener (custom domain), a
 * REGIONAL WAF, access logs, and alarms on the ALB's own metrics when the app
 * asked for them. It has no edge: no edge cache, per-route response headers,
 * branded error pages, session pinning or geo restriction.
 *
 * The app's rules are applied by its proxies instead, with the CloudFront
 * door's semantics: redirects (each source → the asset proxy), per-pattern
 * response headers (asset proxy and API forwarder), and error pages (a missing
 * static file → the 404 page, an S3 failure → the 500 page). Responses the ALB
 * sends straight to the server or image function bypass them; synth names what
 * is not applied (`@aws-blocks/hosting:DoorRulesNotApplied`).
 *
 * Its settings arrive through an internal extra, `alb` — the {@link AlbConstruct}
 * props `HostingConstruct` assembled from the app.
 */
import { type AlbConstructProps, AlbConstruct } from './alb_construct.js';
import { type DoorInput, defineFrontDoor, type FrontDoorResult } from './front_door.js';

/**
 * The ALB door's input: the {@link DoorInput} plus the internal-only
 * {@link AlbConstruct} props (the route plan, CDK handles, network/TLS options).
 */
export type AlbDoorInput = DoorInput & {
  /** The underlying ALB construct props. Internal to the built-in door. */
  alb: AlbConstructProps;
};

/** The ALB door's result: the {@link FrontDoorResult} plus the construct it built. */
export type AlbDoorResult = FrontDoorResult & {
  /** The load-balancer construct. */
  construct: AlbConstruct;
};

/** The built-in ALB front door. */
export const albDoor = defineFrontDoor<AlbDoorInput, AlbDoorResult>({
  service: 'alb',
  // A Lambda target is invoked without streaming.
  serverResponse: 'buffered',

  build(scope, input) {
    // Route every API path the app has (`/aws-blocks/*` + the raw routes).
    const alb = new AlbConstruct(scope, 'Alb', {
      ...input.alb,
      apiPaths: input.alb.apiPaths ?? input.origins.api?.paths,
    });
    return {
      url: alb.url,
      // The ALB's DNS name, plus the origin-verify header (and, internal, the
      // balancer for a VPC origin) when it admits only a CloudFront door in front.
      originHandle: alb.originHandle,
      construct: alb,
    };
  },
});
