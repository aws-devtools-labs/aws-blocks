---
"@aws-blocks/bb-file-bucket": patch
---

fix: export types missing from the `cdk` entry point

Some types exported by the default entry point of `@aws-blocks/bb-file-bucket` were missing from its `cdk` entry, so
backend code importing them failed to type-check under that condition — for example,
`import type { FileVersionInfo } from '@aws-blocks/bb-file-bucket'`.

The `cdk` entry now exports `FileDownloadClient`, `FileUploadClient`, `FileVersionInfo`, `FileDownloadDescriptor`,
`FileUploadDescriptor`, `VersionedGetOptions`, `VersionedDeleteOptions`, `VersionedGetUrlOptions`, `GetOptionsFor`,
`DeleteOptionsFor`, `GetUrlOptionsFor`.
