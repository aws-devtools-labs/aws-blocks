---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
---

docs(core): the README documents `BlocksStack.create()` and every `defaults` option, corrects five statements, and the shared-account platform guide is its own file, `SHARED-ACCOUNT.md`

Corrected in the core README:

- Production CORS: a plain `allowedOrigins` entry is matched exactly and an invalid entry fails synth. The README said every entry is a regex, that an invalid regex falls back to a literal match, and that `https://app.example.com` also matches `https://appXexample.com`.
- Local port: `blocks.dev.port` sets it. It is 3000 by default and 3001 in the templates without a frontend (`api-only`, `backend`, `cron`, `observability`, `sql`) and in the `amplify` overlay. The README named only `backend` and `amplify`.
- JSON-RPC `params`: a value that is present and is neither an array nor an object, `null` included, fails with `-32602`. The README said `-32602` is reserved and that `null` gives no arguments. `-32603` is not used; an unhandled throw returns code `500`.
- The `ApiUrl` stack output is `publicApiUrl`, not the shared gateway's own URL (`apiUrl`).
- Statements in `<stack>.blocks-iam.json` have a `condition` field, not `conditions`.

Corrected in `SHARED-ACCOUNT.md`: the per-service table marks `AWS::BedrockAgentCore::Runtime` as scoped by tag (it said "not scoped", against the text below it), and the list of tag-scoped types in the adoption section includes AgentCore runtimes.

Added to the core README:

- A table of entry points and what each one exports.
- A section "BlocksStack and BlocksBackend": `create()`, its props, the properties of the result, and a table of every `defaults.*` option with its value in `BlocksPresets.sandbox` and `BlocksPresets.production`.
- Signatures and option tables for `Scope`, `ApiNamespace`, `isBlocksError` and `withAuth`; a subsection for `apiWaf` with its two forms.

Moved:

- The platform's side of "Running many apps in one AWS account" (the shared permissions boundary, the shared execution policy, the deploy guard, the pipeline, the project template and adopting `defaults.appIdentity` in an existing app) is now `SHARED-ACCOUNT.md`, shipped in the package. The README section keeps what each app sets and links to it. `npm run docs core` prints the README, so it no longer prints the three IAM policies.
- Each export is its own level-two section (`Scope`, `ApiNamespace`, `BlocksStack and BlocksBackend`, `ApiError / isBlocksError / hasAuthError`, `RawRoute`, `withAuth`, `Hosting`); the "Key Exports" heading above them is gone, and `withAuth` sits next to the other exports.
- The two RPC paths, `/cdk-blocks/api/{namespace}` and `/cdk-blocks/api`, are stated once, under "Calling the API over HTTP".

Removed from the core README:

- The per-door settings matrix, the build-retention rules and the plain-HTTP details under `Hosting`; the `@aws-cdk-blocks/hosting` README holds them and the section links to it.
- The curl examples for inspecting a deployed app; `npm run docs troubleshooting` has them.
- The partial list of Building Block packages; `npm run docs` lists every block.

The defaults descriptions distinguish service-side deletion protection, provisioned-bucket logging, Hosting origin logging and routing from enforced namespace placement. WAF guidance accounts for unresolved values and doors without WAF support. The shared-account guide preserves the CLI's stack naming, exports the app id for report checks, and describes the limits of KMS, resource-type and asset-publishing controls. Package pointers, overflow-policy names and legacy route restrictions are corrected.
