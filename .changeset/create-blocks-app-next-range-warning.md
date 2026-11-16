---
"@aws-blocks/create-blocks-app": patch
---

Adding AWS Blocks to an existing Next.js project now warns when the project's installed `next` is outside the versions `Hosting` builds as a server-rendered app. The verdict comes from the project's own `@aws-blocks/hosting` (`checkNextjsCompatibility` from `@aws-blocks/hosting/nextjs-compatibility`, the check its Next.js adapter makes before the OpenNext build), so it names the `@opennextjs/aws` version and `next` peer range that Hosting release builds with. The CLI carries no version range of its own. The CLI leaves your `next` as it is: upgrading it is up to you. Before, the first sign was the warning the hosting build prints at deploy time.

There is no warning when the project's Hosting can't give a verdict: `next` is not installed, Hosting is not installed (for example with `--skip-install`), or the installed Hosting predates that export. The hosting build still checks then. Nor is there one when the added `Hosting` doesn't build the app with Next.js: the `api-only`, `backend`, `cron`, `sql`, `observability` and `amplify` templates add no `Hosting`, the other templates except `nextjs` build Next.js only when `package.json` declares `next` (in `dependencies`, `devDependencies` or `peerDependencies`), and a static export that `Hosting` serves with `framework: 'static'` has no minimum version.
