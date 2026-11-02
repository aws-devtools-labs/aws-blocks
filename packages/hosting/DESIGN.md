# @aws-blocks/hosting: design notes

This file covers internals that the README doesn't. For the API, see
[README.md](./README.md).

## Routing modes

A front door is `defineFrontDoor({ service, routing?, build })`. `routing`
says where the app's neutral route table (`HostingPlan.routes`, built by
`plan/route-table.ts` and `plan/hosting-plan.ts`) runs.

- **`'door'` (default).** The door renders the route table onto its own
  primitives. The CloudFront door ships it to a KeyValueStore read by a
  CloudFront Function (`kvs_router.ts`); the ALB door turns it into listener
  rules (`alb_construct.ts`); the API Gateway doors into routes. A
  bring-your-own door uses the `cf.*` helpers. Every built-in door works this
  way, and its synthesized template doesn't depend on the other mode: the
  goldens in `src/constructs/__golden__/` (`hosting_construct.golden.test.ts`
  for the CloudFront door, `hosting_construct.golden_doors.test.ts` for the ALB,
  API Gateway HTTP API and a bring-your-own door) pin each whole template.
- **`'app'`.** The door maps a hostname to one entry function
  (`DoorInput.origins.entry`), and that function runs the route table. Only a
  bring-your-own door (`frontDoor: { kind: 'custom', door }`) can set it.

The rest of this file is about `'app'`.

## The entry function

`HostingConstruct` decides `isAppRoutingDoor(props.frontDoor)` before it builds
the compute, because a server bundle must carry the router before CDK
fingerprints the bundle (`Code.fromAsset` stages the directory when the
function is constructed).

- **The app has a regional server** (`compute.default` or `compute.server`).
  The entry IS that function. `withAppRouter` writes `blocks_app_router.cjs`
  into the server bundle and sets the handler to `blocks_app_router.handler`.
  No function is added.
- **No server** (SPA, static site). `appEntryFunction` creates one function,
  `AppRouter`, with the same router as inline code (`index.handler`).

Either way `appEntryFunction` then gives the entry:

- `ASSET_BUCKET` and `ASSET_KEY_PREFIX` (`assetProxyEnvironment`, the build
  prefix `builds/<buildId>`), and read on the assets bucket;
- `API_GW_BASE`, the backend base without the `/aws-blocks/api` suffix, when
  the app has an API;
- `BLOCKS_IMAGE_FUNCTION` and `lambda:InvokeFunction` on the image function,
  when there is one.

The router's settings (`appRouterOptions`) come from the same inputs as the
`DoorInput`: the plan (route entries, redirects, header rules, basePath,
assetPrefix), the error pages (the app's, else the framework build's, else the
default 404 page of a multi-page static site), the API paths
(`/aws-blocks/*` plus the raw routes) and the image endpoints. They are built
before the compute because of the bundle constraint above; the door's own
plan is built later, from the same inputs.

**Cutover.** The entry's environment names the build prefix, so it is the
build's switch. It is appended to the door's `FrontDoorResult.cutover`, which
makes it depend on every asset upload and, through `addBuildAssetDependency`,
on the runtime-config upload `@aws-blocks/core` `Hosting` adds later. The
previous build keeps serving until the new one is whole. None of those uploads
references the entry, so there is no dependency cycle, even for a door whose
URL comes from the entry's own Function URL (a CloudFront distribution in
front of it).

**`origins.entry.url`.** Created on first read, IAM auth and `BUFFERED`. When
the entry is the server function it is the same URL as `origins.server.url`:
a function carries one Function URL.

## The router (`app_router.ts`)

The router is generated CommonJS. It is built from the modules the regional
doors already ship, not a rewrite:

- `asset_proxy_core.ts` (`assetProxyCoreJs`) is inlined at the top: static
  serving (`blocksServe`), the image fallback (`blocksImageSource`), error
  pages (`errorResponse`), the security headers, and through
  `proxy_rules.ts` the edge router's own matcher (`matchPattern`,
  `blocksRedirect`, `blocksHeaders`, `stripBasePath`).
- `alb_api_proxy.ts` (`generateAlbApiProxyCode`) runs unchanged inside its own
  function scope, built on the first API request (it reads `API_GW_BASE` when
  it loads). The router hands it an ALB multi-value event, so the forwarder's
  request hygiene (hop-by-hop headers, the origin-verify secret, client-sent
  forwarding headers, the query as delivered) applies as on the ALB door.

Per request:

1. **Normalize the event.** ALB (`requestContext.elb`), payload 2.0 (HTTP API
   and Function URL: `version: '2.0'`), and REST payload 1.0 become one shape:
   method, raw path, raw query (an ALB delivers it percent-encoded, a REST API
   decoded, so the REST one is re-encoded), lower-cased headers with every
   value, and the body bytes. Any other event (a scheduled warmup) goes to the
   native server handler unchanged.
2. **Redirects**, first match.
3. **API paths** → the forwarder.
4. **assetPrefix** mapped into the basePath form, then a path outside the
   basePath → 308 into it (query kept), as the CloudFront router does.
5. **The route table**, first match (`/about/` also matches `/about`);
   unmatched → `server` when there is one, else `static`.
   - `image` → the image function, invoked with a payload 2.0 event (what its
     Function URL would send), basePath stripped. Without an image function,
     the image endpoints get the asset proxies' fallback.
   - `server` → the framework (below).
   - `static` → `blocksServe`, basePath stripped.
6. **Server and image responses** get the error pages (a 404 or 500 with a
   page configured is replaced by it, keeping the cookies the server set: the
   CloudFront door's custom error responses do the same), the header rules
   (status below 400), and the security headers the response doesn't set.
   API responses get the header rules from the forwarder itself (as on the
   ALB door) and the security headers, but never an error page: an RPC error
   keeps its JSON body.
7. **Answer in the event's shape.** ALB: `statusDescription`, and
   `multiValueHeaders` when the event had them (the target group enables
   multi-value headers), else single `headers` (the last value). REST:
   `headers` and `multiValueHeaders`. Payload 2.0: `headers` and `cookies`. A
   text body that round-trips goes back as UTF-8 rather than base64, so the
   ALB's 1 MB limit isn't cut by a third.

An error while routing (a server that throws, an unreachable server or image
function) is logged and answered with a plain `502`; the cause is never
echoed.

## Wrapping the server, per framework family

The router calls the framework with a buffered request and needs a complete
response, so mode `'app'` builds the server buffered.

**Native Lambda handlers (Next.js through OpenNext, Nitro `aws-lambda`).**
The router imports the handler's module (`index.mjs`) during init and calls
it in-process with a payload 2.0 event. `@aws-blocks/core` `Hosting` sets the
build profile for such a door to `serverInvoke: 'http-api'` and
`lambdaWebAdapter: false`:

- the Next.js adapter then builds OpenNext's buffered `aws-apigw-v2` converter
  and `aws-lambda` wrapper (the build the API Gateway HTTP API door uses);
- the Nitro adapter keeps its native `aws-lambda` preset (which reads both
  payload formats) rather than a `node-server` Web Adapter server.

A streaming handler (Nitro with `awsLambda.streaming: true`, or Next.js built
for the REST door when `HostingConstruct` is used directly) fails synth with
`AppRoutingNeedsBufferedServerError`.

**Lambda Web Adapter servers (Astro, SvelteKit, Nitro `node-server`).** There
is no JavaScript hook in front of the Web Adapter: it is a Lambda extension
that receives the invoke and proxies it to the server's port. Options
considered:

1. *Keep the Web Adapter and put a router HTTP server on its port*, forwarding
   to the framework on another port. Two hops per request, a second port to
   coordinate, and the router would need an HTTP-server envelope of its own.
2. *Keep the Web Adapter and route only some paths* (its pass-through and
   readiness settings). It has no route-table hook; the static files, the API
   and the rules would still need another place to run.
3. *Replace the Web Adapter with a Node.js handler* that runs the router and
   starts the server itself. Chosen: one hop, the same router and event
   handling as the native handlers, and the least change to the framework
   build (none).

`withAppRouter` turns the `http-server` compute into a `handler` compute: a
plain Node.js function, no Web Adapter layer, no `AWS_LAMBDA_EXEC_WRAPPER`, the
router as its handler. During init the router spawns the server's start script
(the compute's `entrypoint`, e.g. `run.sh`, which execs node on the server
module; a `.js`/`.mjs`/`.cjs` entrypoint is run with node directly) with `PORT`
set and the function's environment, as the Web Adapter would. A request to a
server route waits until the port accepts connections (10 s by default), then
is forwarded over HTTP to `127.0.0.1:<port>` with `Host` kept and
`x-forwarded-host` set from it. A static request doesn't wait for the server.
If the server exits, the next server request starts it again.

`HOST_HEADER: 'x-forwarded-host'` (SvelteKit) keeps working: the router sets
that header from `Host`.

## Limits

- Buffered only: no response streaming through the entry.
- A route to another regional compute (a Next.js `runtime: 'edge'` route built
  regional) fails synth (`AppRoutingUnsupportedRouteError`); Lambda@Edge
  routes and Next.js middleware fail as for every door other than CloudFront.
- The router reads only the current build's prefix (no skew protection).
- Every file passes the door's Lambda response limit (1 MB behind an ALB).
  Synth warns about files over Lambda's 6 MB limit.
- The router decides `x-forwarded-host` from `Host`. A door that puts a proxy
  in front of the entry and wants another public host must set `Host` itself.
