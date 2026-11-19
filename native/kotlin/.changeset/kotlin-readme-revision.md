---
"aws-blocks-kotlin": patch
---

docs(kotlin): add an "Errors" section to the README and correct the setup steps of the example apps

Corrections:

- The Android and KMP example READMEs said to run `npm install`, `npm run dev` and `npm run spec` from `example/typescript/aws-blocks`. The scripts are in `example/typescript`; both files now link to the backend README's "Running" section.
- The same two files said sign-in has no fake-user fallback. They now name the two ways to sign in: the stub IdP, which needs no credentials but a small change in the backend's `cdk-blocks/index.ts`, and a Google OAuth client.
- The KMP example README said `App` constructs `Blocks()`. It constructs `Blocks` with `Blocks.defaultServer`.
- The README's badge said Kotlin 2.2.10 while the build uses 2.2.21. The badge is removed; "Requirements" states the supported versions.

Added:

- README, "Errors": `ApiException`, `TransportException`, `ClientClosedException`, the four `OidcException` subclasses and `FileTransferException`, when each is thrown, and the properties to read (`status`, `name`, `isBlocksError`, `statusCode`, `provider`, `cause`).

Restructured:

- README, "Generated types" is split into "Open records", "Unions" and "Names". The rules are list items and tables: one row per union arm kind, one row per naming rule.
- README: the `relayTo` paragraph states the rule first: a custom scheme only, no `https` URL. "Support by Target" is one sentence under "Supported Platforms".
- Backend README: the stub IdP is the first subsection of "Configuring OIDC", titled "Sign in without Google (stub IdP)". The note about a sandbox whose todos table is keyed on `userId` is one line under "Running".

No behavior changes.
