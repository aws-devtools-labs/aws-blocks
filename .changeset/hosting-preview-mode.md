---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
---

feat(hosting): `HostingPresets` and preview-mode settings for fast, disposable deploys

`Hosting` takes four new props, and `HostingPresets` bundles them (the hosting counterpart of `BlocksPresets`). Omit them and nothing changes.

```ts
new Hosting(stack, 'Web', { ...(isPreview ? HostingPresets.preview : HostingPresets.production), root, api: blocksStack });
new Hosting(stack, 'Web', { ...HostingPresets.preview, imageOptimization: true, root, api: blocksStack });
```

- `imageOptimization: false`: no image function. The adapters record the app's remote-image allowlist in the new optional `DeployManifest.imageRemoteSources` (Nitro from `@nuxt/image` `image.domains`, Astro from `image.domains` and `image.remotePatterns`), and the door matches a remote source's host on its parsed URL. The framework image endpoints (`/_next/image`, `/_ipx/*`, `/_image`) serve the source image, unoptimized. A remote source is redirected to itself only when its host is in the app's image allowlist, else 404; it is never fetched. Needs the API Gateway HTTP API door.
- `incrementalRegeneration: false`: Next.js builds without the tag cache and the revalidation queue (no DynamoDB table, SQS queue or revalidation function). Prerendered pages are still served from the build's cache snapshot. Any door.
- `edgeRoutes: 'regional'`: Next.js `runtime: 'edge'` routes run as regional Lambda functions, each routed straight to its function, instead of Lambda@Edge. Needs the API Gateway HTTP API door.
- `buildId: 'fixed'`: one build id, overwritten in place, so an unchanged build produces the same assets and `startSandbox({ preview: true })` hotswaps a code-only re-deploy. Not behind CloudFront or the stacked door (an edge cache would keep serving overwritten files).

A setting the chosen door can't serve fails synth with `UnsupportedHostingSettingError`. `HostingPresets.preview` sets all four plus `frontDoor: { kind: 'apiGateway' }`; `HostingPresets.production` sets nothing.

The API Gateway HTTP API door now builds the server for the HTTP API: OpenNext uses the `aws-apigw-v2` converter and the buffered `aws-lambda` wrapper, and Nitro builds the `node-server` preset unless the app picked one. Nitro's `node-server` on Lambda starts through a generated `run.sh`. A route served by a compute other than the server gets its own route. Adapters read these choices with `buildProfile()` (`withBuildProfile()` in `@aws-blocks/hosting/adapters`), so the adapter signature is unchanged. With no image function, Next.js's `/_next/*` stays on the static assets (the route table no longer merges `/_next/image` and `/_next/data` into a `/_next/*` server route).
