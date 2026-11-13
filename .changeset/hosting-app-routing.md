---
"@aws-blocks/hosting": minor
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

A bring-your-own front door can now route at the app: `defineFrontDoor({ service, routing: 'app', build })`.
Such a door attaches only the app's entry function, `input.origins.entry` (`{ kind: 'entry', fn, url, streaming }`),
for example one listener rule and one Lambda target group on a shared ALB, and the entry runs the app's whole route
table: redirects, the same-origin API, static files from the assets bucket, image optimization, server rendering,
header rules and error pages. It accepts ALB, API Gateway REST and HTTP API, and Lambda Function URL events and
answers in the matching shape.

The entry is the app's server function, with its handler wrapped (no new function), or for an app without a server
a single router function. Native handler servers (Next.js through OpenNext, Nitro `aws-lambda`) are called
in-process; Lambda Web Adapter servers (Astro, SvelteKit, Nitro `node-server`) run as a plain Node.js function that
starts the server and forwards server routes to it. `Hosting` from `@aws-blocks/core` builds the server buffered for
such a door. The entry switches to a new build only after the build's files are uploaded. A streaming server handler,
or a door that declares `serverResponse: 'streaming'`, fails synth with an actionable error.

`routing` defaults to `'door'`: existing doors and apps synthesize the same templates. New exported types:
`EntryOrigin`, `AppRoutingDoorInput`, `DoorRouting` and `DoorInputFor`; `FrontDoor` and `defineFrontDoor` gain an
optional third type parameter for the routing mode. The umbrella `@aws-blocks/blocks` is bumped because the bundled
hosting docs it mirrors have changed (README, and the new DESIGN.md).
