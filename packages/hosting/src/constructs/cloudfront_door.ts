// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CloudFront front door — the full-feature default door, written as a
 * free-form door (one `build`).
 *
 * `build` creates the {@link CdnConstruct}: the distribution, its behaviors and
 * KVS route table, the skew-protection and www-redirect functions, the custom
 * domain + certificate aliases, the web ACL, geo restriction and access logs.
 * It reads those settings from an internal extra, `cdnProps` — the exact
 * {@link CdnConstruct} props `HostingConstruct` assembled from the app (the
 * same settings a bring-your-own door finds in `input.features`). The same-origin
 * API behaviors (`/aws-blocks/*`, sign-in, raw routes) are added onto the
 * distribution afterwards by the Blocks layer, and the CloudFront alarms by the
 * `HostingConstruct`'s monitoring.
 */
import type { Construct } from 'constructs';
import { CdnConstruct, type CdnConstructProps } from './cdn_construct.js';
import { type DoorInput, defineFrontDoor, type FrontDoorResult } from './front_door.js';

/**
 * The CloudFront door's input: the {@link DoorInput} plus the internal-only
 * {@link CdnConstruct} props (CDK handles + the manifest) it builds from.
 */
export type CloudFrontDoorInput = DoorInput & {
  /** The underlying CloudFront construct props. Internal to the built-in door. */
  cdnProps: CdnConstructProps;
};

/** The CloudFront door's result: the {@link FrontDoorResult} plus the construct it built. */
export type CloudFrontDoorResult = FrontDoorResult & {
  /** The distribution construct. */
  cdn: CdnConstruct;
};

/** The built-in CloudFront front door. */
export const cloudFrontDoor = defineFrontDoor<CloudFrontDoorInput, CloudFrontDoorResult>({
  service: 'cloudfront',

  build(scope: Construct, input) {
    const cdn = new CdnConstruct(scope, 'Cdn', input.cdnProps);
    return {
      url: cdn.distributionUrl,
      originHandle: { domainName: cdn.distribution.distributionDomainName, protocol: 'https' },
      cdn,
    };
  },
});
