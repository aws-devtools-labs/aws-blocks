---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

fix(hosting): build Next.js apps with a verified OpenNext version, and explain Edge-route and version mismatches

- **`@opennextjs/aws` not installed.** Hosting declares OpenNext as an optional peer dependency, so nothing installs it for the app, and a bare `npx @opennextjs/aws build` downloaded the newest release, which is often outside the version range the Next.js adapter is verified against. When the project doesn't declare it, the adapter now builds with `@opennextjs/aws@4.0.3` and prints the command to declare it (`npm install --save-dev @opennextjs/aws@~4.0.3`). If that build fails, it throws `OpenNextNotFoundError` with the same command. Before this change that error could never be raised.
- **Next.js outside OpenNext's `next` peer range.** When the app's `next` version is outside the range the building OpenNext declares (for example `next@15.5.7` with `@opennextjs/aws@4.0.3`, which requires `>=15.5.18 <16 || >=16.2.6`), the adapter now prints a warning naming both versions and the range. Package managers that skip peer checks would otherwise build an untested pair without a word.
- **Edge routes on a stack without a region.** A Next.js route with `runtime = 'edge'` is built as Lambda@Edge, which needs the stack's region at synth time. On a stack with no explicit `env.region`, synth failed with CDK's `stacks which use EdgeFunctions must have an explicitly set region`. Hosting now throws `EdgeComputeRequiresRegionError`, which names the route's compute and shows the `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }` fix.
- The `@opennextjs/aws` peer dependency range is now bounded: `>=3.10.0 <5.0.0`.
- `@aws-blocks/create-blocks-app`: the `nextjs` template declares `@opennextjs/aws` (`~4.0.3`) as a devDependency, so new Next.js apps build with a pinned, verified OpenNext.
