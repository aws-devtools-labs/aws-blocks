---
"@aws-blocks/core": minor
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/blocks": patch
---

feat(core): provision a managed CloudFront front door for the API

A Blocks app's API is served from an API Gateway origin whose hostname changes
every time the gateway is replaced, and which a browser can only reach over the
gateway's own domain. Production stacks now get a single CloudFront distribution
that presents the API on one stable domain, so a client (and the auth cookies
bound to that origin) has one address that survives gateway replacement.

`LambdaCompute` now exposes its origin base as a public `endpoint`
(`https://{id}.execute-api.{region}.{suffix}/{stage}`) — the value the front door
forwards to.

The distribution is a single catch-all default behavior forwarding to the default
compute's origin. Every API path resolves to that one compute today, so there is
no per-path fan-out: one origin, one behavior. The behavior is uncached, allows
all methods, forwards everything except `Host` (API Gateway rejects a forwarded
`Host`), and redirects HTTP to HTTPS.

The distribution's domain is published as an `ApiFrontDoorUrl` stack output, and
the `ApiUrl` output resolves to it so clients go through the front door — see the
companion entry below for how `ApiUrl` and `Hosting` reuse fit together.

**This adds a CloudFront distribution to production stacks.** It is on in the
production preset and off in the sandbox preset, where a stack reaches API
Gateway directly and a distribution would only add propagation delay to each
deploy/test cycle. Override per app with the new
`apiFrontDoor?: 'cloudfront' | 'none'` prop on `BlocksStackProps` /
`BlocksBackendProps`: `'none'` suppresses it in production for an app that fronts
its own API (an ALB, a custom domain, an existing CDN), `'cloudfront'` opts a
sandbox in.

It is also suppressed automatically when a `Hosting` distribution in the same
stack already fronts the API, so an app with a CloudFront-hosted frontend does not
get a second distribution. A `Hosting` in a *different* stack from its backend
cannot suppress it — the two do not see each other's front door — so pass
`apiFrontDoor: 'none'` on the backend in that setup.

**Migration — `BlocksDefaults` gains a required `provisionApiFrontDoor: boolean`.**
Apps that build their `defaults` by spreading a preset
(`{ ...BlocksPresets.production, deletionProtection: false }`, the documented
form) need no change. An app that assembles a `BlocksDefaults` literal field by
field must add it.
