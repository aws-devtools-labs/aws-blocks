---
"@aws-blocks/bb-auth": patch
---

fix(bb-auth): never serve the `auth.admin` handle over RPC

The `auth.admin` handle now carries its block's identity, so the RPC dispatcher
treats it like a Building Block instance: exporting it, or returning it from an
`ApiNamespace` handler, answers *method not found*. Methods you write that call
`auth.admin` work as before and still need their own caller check.
