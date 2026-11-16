---
"@aws-blocks/bb-auth": patch
"@aws-blocks/core": patch
---

fix(bb-auth): copies of `auth.admin` methods are never served over RPC

Each `auth.admin` method is registered as server-only, and the RPC dispatcher
refuses a server-only function by identity. Copying the methods into another
object (`{ ...auth.admin }`, `Object.assign({}, auth.admin)`, a destructured
method under any name) answers *method not found*, like exporting the handle
itself. The generated client has no proxy for an admin method exported on its
own, matching what the server serves. Calling `auth.admin` methods from server
code works as before, and
`Object.keys(auth.admin)` is unchanged. To serve an admin action, write your
own method that checks the caller and then calls `auth.admin`.
