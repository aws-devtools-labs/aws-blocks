---
"@aws-blocks/core": minor
"@aws-blocks/blocks": patch
---

feat(core): point the client at the API front door, and reuse Hosting's

The `ApiUrl` stack output — which `deploy` and `sandbox` hand to a client as
`BLOCKS_API_URL` — now resolves to whichever front door ends up fronting the API,
falling back to API Gateway when there is none. It is composed at synth
(`defaultEndpoint + /aws-blocks/api`), so the RPC path is always present and the
answer is never a stale cached URL.

**An app with a CloudFront-hosted frontend gets one distribution, not two.**
`Hosting` claims the front-door role, so the backend stops provisioning a managed
one, and the API is served from the same domain as the frontend — no CORS, no
extra hop. `ApiUrl` then points at Hosting's distribution, custom domain included
when one is configured.

That applies when `Hosting` is in the same stack as its backend
(`new Hosting(blocksStack, …)`, the usual shape). Front a backend in another stack
and it still provisions its own managed distribution, since the two cannot see
each other's — pass `apiFrontDoor: 'none'` on the backend to make Hosting's the
only front door.

`Hosting` adds the API behaviors to its own distribution: the reserved
`/aws-blocks/api` RPC subtree and the `/aws-blocks/auth` subtree as fixed
behaviors, plus one behavior per app `RawRoute` that lives outside those
prefixes. All of them forward to the default compute's origin, matching the
managed front door.

Server-side rendering still calls the backend's own gateway origin rather than the
distribution: an SSR function that is an origin of the distribution it calls
through is a CloudFormation dependency cycle.

**Migration — `Hosting`'s `api` prop takes a routing descriptor instead of a URL.**
`BlocksStackApi` (`{ apiUrl }`) is replaced by:

```ts
export interface BlocksApiRouting {
  readonly defaultEndpoint: string; // origin base, no RPC suffix, no trailing slash
}
```

Apps passing `api: blocksStack` need no change — `BlocksStack` and
`BlocksBackend` satisfy the new shape through their `defaultEndpoint` getter. Only
code that constructed a `BlocksStackApi` literal, or imported the type by name,
has to be updated. The descriptor is plain data — a single endpoint string — which
is what lets a `Hosting` in another stack front this one's API without holding a
construct reference across the boundary.
