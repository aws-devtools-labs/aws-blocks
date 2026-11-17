---
'@aws-blocks/create-blocks-app': patch
---

The `api-only` template README now has a "Security model" section: every API method is a public endpoint until you gate it with `auth.requireAuth(context)`, and a presigned URL lets whoever holds it read or write that key until it expires. The template security tests now check every template, so any method that signs a URL (`getUrl`, `putUrl`, `getFileHandle`, `createUploadHandle`) must start with `requireAuth` or `requireRole`.
