---
"@aws-blocks/hosting": patch
"@aws-blocks/pipeline": patch
"@aws-blocks/blocks": patch
---

docs(hosting,pipeline): the hosting README lists its props and errors and puts front doors first, the custom door guide is its own file, and the pipeline README documents every option

`@aws-blocks/hosting` README

- Corrected: a Next.js (OpenNext) server behind the `alb` and `stacked` doors fails synth with `StreamingServerNeedsStreamingDoorError`; the README said to "serve it there through CloudFront" in a paragraph that contradicted itself. Behind the API Gateway HTTP API the adapter builds a buffered server.
- Corrected: `getSecret` throws `no secret reference found` (the README gave only the `getConfig` message); `HostingConstruct` is exported from `@aws-blocks/hosting/constructs`, not `@aws-blocks/hosting`; the marker codec example imports the names it calls (`config`, `secret`, `isSecret`); `allowPlainHttp` is listed among the door options; an unknown door and an unknown door option are matched to `UnsupportedFrontDoorError` and `InvalidFrontDoorOptionError` respectively.
- Added: `## Quick start` with a runnable adapter call, a table of the adapters and their arguments, an entry-point table and a `HostingConstructProps` table.
- Added: `## Errors`, a table of 29 `HostingError` names with the condition that throws each, plus `ManagedValueCodecError` and `InsecureTransportException`.
- Added: option tables with defaults for `secretStore` / `configStore`, `serverOrigin` and the SSR cache options, and a "Streaming and buffered servers" table by door and framework.
- Text that said "fails synth" or "throws" now names the error or the warning id, for example `SsrCacheKeyCookieCapError` and `@aws-blocks/hosting:LoggingV2RegionUnresolved`.
- Reordered: quick start and props, front doors, Next.js, SSR compute, build retention, access logging, SSR caching, custom domains, monitoring, secrets and config, errors. The `allowPlainHttp` rule is stated once, under "Running a plain-HTTP door in production".
- Moved: the guide to writing a door with `defineFrontDoor` is now `CUSTOM-FRONT-DOOR.md`, shipped with the package. The README keeps the "Bring your own front door" heading with a summary, a link, and what AWS Blocks checks and enforces for such a door.
- Renamed: `## Custom domains (CloudFront door)`, `## CloudFront 5xx alarm outside us-east-1`, `### Type-safe keys (hosting-typegen)`, `### Region, prefix and stage limits`. "Two-phase workflow for external DNS" is part of "Bring your own DNS (manual)".
- Removed: `## Overview`, `## Main exports` and `## Architecture` (covered by the introduction and the quick start), `## Development`, `## License`, and the description of how a Web Function is packaged.

`@aws-blocks/hosting` `CUSTOM-FRONT-DOOR.md`

- Corrected: a failed wiring check throws `UnsupportedFrontDoorError`; `ServeStaticAsset` and `ProxySameOriginApi` are rule names in its message, not errors.
- Corrected: the example of a door that stacks CloudFront over its own ALB uses an HTTPS listener and an `HTTPS_ONLY` origin. It sent the origin secret over plain HTTP.
- Added: a table of the eight `cf.*` helpers, the three wiring-check warnings with their ids, and `InvalidPropsError` as the error of `cf.redirects` / `cf.headers` above 10 KB.

`@aws-blocks/pipeline` README

- Corrected: `new Pipeline()` throws for an `App` scope, for `appFile`, for an `async` `stageFactory` and for a `config()` marker as `source.connectionArn`; the README mentioned only async stage factories. A table compares it with `Pipeline.create()`.
- Added: `## Options`, with tables for `PipelineProps`, `source`, `branches[]`, `stages[]` and `synth` (types and defaults), and the store prefixes that `Pipeline` from `@aws-blocks/core` defaults to.
- The first example is a complete `aws-blocks/pipeline.cdk.ts` using `await Pipeline.create()` with the default `appFile`; the text says how `cdk.json` points at it and that the CodeConnections connection needs a one-time OAuth handshake.
- "Opt out of the Node.js 22 default" is folded into the `null` case of `synth.partialBuildSpec`.
