---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
---

feat(hosting): preview mode for fast, disposable deploys

`Hosting` takes a new opt-in `preview` prop for ephemeral environments
(pull-request previews, per-branch sandboxes, demos). Omit it and nothing
changes: the app deploys its full shape in every stage.

```ts
new Hosting(stack, 'Web', { root, api: blocksStack, preview: process.env.DEPLOY_ENV === 'preview' });
new Hosting(stack, 'Web', { root, api: blocksStack, preview: { enabled: true, imageOptimization: true } });
```

When on:

- The app is served by the API Gateway HTTP API door (`frontDoor: { kind: 'apiGateway' }`): one regional origin, no CloudFront distribution to create or tear down. Server responses are buffered. `frontDoor` may be omitted or set to an `apiGateway` door; any other door fails synth with `PreviewFrontDoorError`.
- Next.js builds without the tag cache and the revalidation queue (no DynamoDB table, SQS queue or revalidation function). Prerendered pages are still served from the build's cache snapshot.
- No image optimization unless `imageOptimization: true`. The framework image endpoints (`/_next/image`, `/_ipx/*`, `/_image`) serve the source image, unoptimized. A remote source is redirected to itself only when its host is in the app's image allowlist, else 404; it is never fetched. With no image function, Next.js `/_next/static/*` chunks are still served from the build's assets: the route table no longer folds `/_next/image*` and `/_next/data/*` into a `/_next/*` server route that would shadow them.
- Next.js `runtime: 'edge'` routes run as regional Lambda functions, routed straight to their function, instead of Lambda@Edge.
- The build id is fixed (`'preview'`), so an unchanged build produces the same assets. `startSandbox({ preview: true })` re-deploys with `--hotswap-fallback`, applying a code-only change to the functions directly.

The API Gateway HTTP API door now builds the server for the HTTP API whether or not preview is on: OpenNext uses the `aws-apigw-v2` converter and the buffered `aws-lambda` wrapper, and Nitro builds the `node-server` preset unless the app picked one. Nitro's `node-server` on Lambda starts through a generated `run.sh`. Adapters read these choices with `buildProfile()` (`withBuildProfile()` in `@aws-blocks/hosting/adapters`), so the adapter signature is unchanged.
