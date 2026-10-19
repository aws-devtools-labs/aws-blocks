// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * API Gateway front door, written as a free-form door — a regional,
 * HTTPS-by-default, no-CloudFront door. Renders the app's route table onto
 * either an HTTP API v2 ({@link ApiGatewayConstruct}, the **default** — its auto
 * `$default` stage is rootless, so a SPA's root-absolute assets resolve) or a
 * REST API ({@link ApiGatewayRestConstruct}, for use behind a custom domain /
 * CloudFront — a bare REST URL's `/prod` stage path breaks root-absolute
 * assets), selected by `apiType`.
 *
 * Serverless — pay-per-request, scale-to-zero, no VPC/NAT. `build` creates a
 * route per origin (asset-proxy → private S3, SSR/image Lambdas), proxies every
 * API path (`/aws-blocks/*` plus the backend's raw routes) same-origin natively
 * (so cookie auth works with no CORS), and maps the custom domain when the app
 * has one. On the HTTP API, SSR responses are buffered (an HTTP API Lambda
 * integration can't stream, so `HostingConstruct` builds the server buffered);
 * the REST API streams them. There are no redirects, error pages, edge cache,
 * response headers, session pinning, WAF, geo restriction, access logs or
 * alarms at an edge.
 *
 * The app's redirects, per-pattern response headers and error pages are applied
 * by the asset proxy instead, with the CloudFront door's semantics (each
 * redirect source gets a route to it). Responses routed straight to the
 * server, the image function or the backend bypass it; synth names what is not
 * applied (`@aws-blocks/hosting:DoorRulesNotApplied`).
 */
import { Fn } from 'aws-cdk-lib';
import { ApiGatewayConstruct, type ApiGatewayConstructProps } from './apigw_construct.js';
import { ApiGatewayRestConstruct } from './apigw_rest_construct.js';
import { type DoorInput, defineFrontDoor, type FrontDoorResult } from './front_door.js';

/**
 * The API Gateway door's input: the {@link DoorInput} plus the internal-only
 * construct props and the flavor to render.
 */
export type ApiGatewayDoorInput = DoorInput & {
  /** The underlying API Gateway construct props. Internal to the built-in door. */
  apiGateway: ApiGatewayConstructProps;
  /**
   * Which API Gateway flavor to render. `'http'` (default) uses HTTP API v2 — its
   * `$default` stage is rootless, so a SPA's root-absolute assets resolve. `'rest'`
   * uses a REST API (`lambda:InvokeFunction`, native `HTTP_PROXY` backend, streamed
   * SSR) but its URL carries a `/prod` stage path, so it needs a custom domain
   * (`HostingConstruct` fails synth without one).
   * @default 'http'
   */
  apiType?: 'rest' | 'http';
};

/** The built-in API Gateway front door. */
export const apiGatewayDoor = defineFrontDoor<ApiGatewayDoorInput, FrontDoorResult>({
  service: 'api-gateway',

  /**
   * The origin handle is the API endpoint host (scheme stripped, token-safe) —
   * HTTPS by default. The REST URL carries a `/prod` stage, so its host is the
   * URL's host segment (index 2 of `https://host/…`).
   */
  build(scope, input) {
    // Route every API path the app has (`/aws-blocks/*` + the raw routes).
    const apiPaths = input.apiGateway.apiPaths ?? input.origins.api?.paths;
    if ((input.apiType ?? 'http') === 'rest') {
      const apigw = new ApiGatewayRestConstruct(scope, 'ApiGateway', {
        ...input.apiGateway,
        apiPaths,
        serverStreaming: input.origins.server?.streaming ?? true,
      });
      return {
        url: apigw.url,
        originHandle: { domainName: Fn.select(2, Fn.split('/', apigw.url)), protocol: 'https' },
      };
    }
    const apigw = new ApiGatewayConstruct(scope, 'ApiGateway', { ...input.apiGateway, apiPaths });
    return {
      url: apigw.url,
      originHandle: { domainName: Fn.select(1, Fn.split('://', apigw.url)), protocol: 'https' },
    };
  },
});
