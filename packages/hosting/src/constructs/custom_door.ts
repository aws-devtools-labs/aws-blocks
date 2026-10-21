// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Running a front door at synth — the seam every door (built-in or
 * bring-your-own) goes through.
 *
 * {@link buildFrontDoor} calls the door's `build` once, then:
 *   1. requires a public `url` (a missing or empty `url` fails synth with
 *      `MissingFrontDoorUrlError` — never a deploy with no address);
 *   2. normalizes the `url` to a bare origin — no trailing slash, since it
 *      becomes the trusted public origin and the CORS hosting origin, which a
 *      browser's `Origin` header (no slash) must equal — and derives the
 *      `originHandle` from it when the door didn't return one;
 *   3. for a bring-your-own door, runs the WIRING CHECK: from what the `cf.*`
 *      helpers recorded, the static assets must be reachable
 *      (`ServeStaticAsset`) and, when the app has an API, at least one of its
 *      paths must reach it (`ProxySameOriginApi`). An API path the door left
 *      unwired is a synth warning, and so are app redirects, per-pattern
 *      headers or error pages it left unwired (`cf.redirects`, `cf.headers`,
 *      `cf.errorPages` wire them; `cf.recordWired` declares hand-wired ones).
 *
 * There is no feature check: AWS Blocks does not verify that a door applies
 * the features the app asked for (`input.features`) — the door's author owns
 * that. The wiring check covers only routing, because a door that doesn't
 * route to the assets or the API cannot serve the app at all.
 *
 * Known limit: the check sees only what the helpers recorded. A door that
 * wires correctly with raw CDK gets a false alarm; it declares its hand-wired
 * origins with `cf.recordWired(...)`, or opts out with `wiringCheck: false`.
 */
import { Annotations } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import { startWiringRecord, type WiringRecord } from './cf_helpers.js';
import type { DoorInput, FrontDoor, FrontDoorResult } from './front_door.js';
import { type OriginHandle, originHandleFromUrl } from './layer.js';

/** Options for {@link buildFrontDoor}. */
export type BuildFrontDoorOptions = {
  /**
   * Run the routes/API wiring check after `build` (see the module doc).
   * Bring-your-own doors default to `true`; built-in doors pass `false`.
   * @default true
   */
  wiringCheck?: boolean;
};

/** The outcome of {@link buildFrontDoor}: the door's result with its `originHandle` settled. */
export type FrontDoorBuild<TResult extends FrontDoorResult = FrontDoorResult> = {
  /** What `build` returned, with `originHandle` derived from `url` when it was omitted. */
  result: TResult & { originHandle: OriginHandle };
  /** What the `cf.*` helpers (or `cf.recordWired`) recorded during `build`. */
  wiring: WiringRecord;
};

/**
 * Build a front door and settle its result (see the module doc).
 *
 * @param scope the construct scope the door creates its resources under.
 * @param door the door (from `defineFrontDoor`, or a built-in door).
 * @param input the {@link DoorInput} (or a built-in's extension of it).
 * @param options.wiringCheck run the routes/API wiring check. @default true
 * @returns the door's result (with `originHandle`) and its wiring record.
 * @throws HostingError('InvalidPropsError') when `door` is not a front door.
 * @throws HostingError('MissingFrontDoorUrlError') when `build` returns no `url`.
 * @throws HostingError('UnsupportedFrontDoorError') when the wiring check fails.
 */
export function buildFrontDoor<TInput extends DoorInput, TResult extends FrontDoorResult>(
  scope: Construct,
  door: FrontDoor<TInput, TResult>,
  input: TInput,
  options: BuildFrontDoorOptions = {},
): FrontDoorBuild<TResult> {
  if (!door || typeof door.service !== 'string' || door.service.length === 0 || typeof door.build !== 'function') {
    throw new HostingError('InvalidPropsError', {
      message: 'frontDoor.door is not a front door: it needs a non-empty `service` id and a `build(scope, input)` function.',
      resolution: 'Define the door with `defineFrontDoor({ service, build })` from @aws-blocks/hosting/constructs.',
    });
  }
  const wiring = startWiringRecord(input);
  const result = door.build(scope, input);
  if (!result || typeof result.url !== 'string' || result.url.length === 0) {
    throw new HostingError('MissingFrontDoorUrlError', {
      message: `Front door '${door.service}' returned no \`url\` from build(). The url is the app's public address.`,
      resolution:
        "Return the address the door serves the app from as `url` (e.g. 'https://' + the distribution's domain name), " +
        'or the custom domain when the door serves one.',
    });
  }
  if (options.wiringCheck !== false) checkWiring(scope, door.service, input, wiring);
  const url = bareOrigin(result.url);
  return {
    result: { ...result, url, originHandle: result.originHandle ?? originHandleFromUrl(url) },
    wiring,
  };
}

/**
 * The url without its trailing slash(es): `https://app.example.com/` and the
 * browser's `Origin: https://app.example.com` must compare equal. A trailing
 * slash written after a token (`https://${domain}/`) is literal text in the
 * string, so it is removed too.
 */
const bareOrigin = (url: string): string => {
  let end = url.length;
  while (end > 0 && url.charAt(end - 1) === '/') end--;
  return url.substring(0, end);
};

/**
 * The wiring check (see the module doc).
 *
 * @throws HostingError('UnsupportedFrontDoorError') listing every unmet wiring rule.
 */
function checkWiring(scope: Construct, service: string, input: DoorInput, wiring: WiringRecord): void {
  const problems: string[] = [];
  if (!wiring.origins.has('assets')) {
    problems.push(
      'ServeStaticAsset: nothing reaches the static assets — use cf.origin(origins.assets) or cf.behaviors(app.routes).',
    );
  }
  const api = input.origins.api;
  if (api) {
    const missing = api.paths.filter((path) => !wiring.apiPaths.has(path));
    if (missing.length === api.paths.length) {
      problems.push(
        `ProxySameOriginApi: the app has an API, but none of ${api.paths.join(', ')} were wired — use cf.apiBehaviors(origins.api).`,
      );
    } else if (missing.length > 0) {
      Annotations.of(scope).addWarningV2(
        '@aws-blocks/hosting:FrontDoorApiPathUnwired',
        `Front door '${service}' did not wire these API paths, so requests to them won't reach the backend: ` +
          `${missing.join(', ')}. Use cf.apiBehaviors(origins.api), or cf.recordWired(origins.api, paths) for paths wired by hand.`,
      );
    }
  }
  const unwiredRules: string[] = [];
  if (input.app.redirects.length > 0 && !wiring.rules.has('redirects')) unwiredRules.push('app.redirects (cf.redirects)');
  if (input.app.headers.length > 0 && !wiring.rules.has('headers')) unwiredRules.push('app.headers (cf.headers)');
  if (input.app.errorPages && !wiring.rules.has('errorPages')) unwiredRules.push('app.errorPages (cf.errorPages)');
  if (unwiredRules.length > 0) {
    Annotations.of(scope).addWarningV2(
      '@aws-blocks/hosting:FrontDoorRuleUnwired',
      `Front door '${service}' did not wire the app's ${unwiredRules.join(', ')}, so they won't apply. ` +
        'Wire them with the named helpers, or declare hand-wired ones with cf.recordWired(app.redirects) (etc.).',
    );
  }
  if (problems.length === 0) return;
  throw new HostingError('UnsupportedFrontDoorError', {
    message: `Front door '${service}' cannot serve this deploy:\n${problems.map((p) => `  • ${p}`).join('\n')}`,
    resolution:
      'Wire the missing origins with the cf.* helpers. If the door wires them with raw CDK, declare it with ' +
      "cf.recordWired(origin), or turn the check off with `frontDoor: { kind: 'custom', door, wiringCheck: false }`.",
  });
}
