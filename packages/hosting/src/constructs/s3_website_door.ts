// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 static-website front door (`frontDoor: 'none'`), written as a free-form
 * door — the simplest/cheapest option for a pure static site / SPA (public
 * website bucket, no CloudFront, no Lambda, no TLS). `build` creates an
 * {@link S3WebsiteConstruct}, which publishes the build output to its own
 * public bucket; the door hands that bucket back as `publicBucket` so the
 * runtime config is published where the browser reads it.
 *
 * A website bucket serves files only: there is no server, no same-origin API
 * (the client calls the backend cross-origin), no image optimization and no
 * HTTPS. The one thing the door refuses is an app with a server — it would
 * deploy with nothing to render its pages.
 */
import { Fn } from 'aws-cdk-lib';
import { HostingError } from '../hosting_error.js';
import type { CapabilityPlan } from '../plan/types.js';
import { type DoorInput, defineFrontDoor, type FrontDoorResult } from './front_door.js';
import { S3WebsiteConstruct } from './s3_website_construct.js';

/** The S3-website door's input: the {@link DoorInput} plus the internal-only route plan. */
export type S3WebsiteDoorInput = DoorInput & {
  /** The route plan (SPA fallback decides the error document). Internal to the built-in door. */
  plan: CapabilityPlan;
};

/** The built-in S3 static-website door. */
export const s3WebsiteDoor = defineFrontDoor<S3WebsiteDoorInput, FrontDoorResult>({
  service: 's3-website',

  /**
   * The origin handle is the website endpoint host (HTTP-only — S3 website
   * endpoints don't support TLS).
   *
   * @throws HostingError('UnsupportedFrontDoorError') when the app has a server.
   */
  build(scope, input) {
    if (input.plan.policies.hasServer) {
      throw new HostingError('UnsupportedFrontDoorError', {
        message:
          "Front door 's3-website' cannot serve this deploy: the app renders on a server, " +
          'and an S3 website bucket only serves static files.',
        resolution:
          "`frontDoor: 'none'` serves a pure static site / SPA directly from S3 (HTTP only, no " +
          'front door). For server rendering, use the CloudFront default (omit `frontDoor`), ' +
          "`{ kind: 'alb' }`, or `{ kind: 'apiGateway' }`.",
      });
    }
    const site = new S3WebsiteConstruct(scope, 'S3Website', {
      plan: input.plan,
      staticDir: input.origins.assets.sourceDir,
    });
    return {
      url: site.url,
      originHandle: { domainName: Fn.select(1, Fn.split('://', site.url)), protocol: 'http' },
      // The public website bucket the SPA is served from — the wrapper publishes
      // config.json here (root `.blocks-sandbox/`) so the cross-origin client can
      // read the absolute API URL from the SAME origin it loads from.
      publicBucket: site.bucket,
    };
  },
});
