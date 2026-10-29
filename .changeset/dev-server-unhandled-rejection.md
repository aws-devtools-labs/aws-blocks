---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

The local dev server no longer exits on an unhandled promise rejection from request handling, which left `npm run dev` down until the next file change. The usual cause is a guard called without `await`, such as `auth.requireRole(context, 'admin')`: the method returns before the guard rejects. The dev server now logs `[unhandled-rejection] <namespace.method>: <error>` with a hint about the missing `await`, whether the response had already been sent, and the stack, and keeps serving. A rejection outside any request still ends the process, as before. Deployed (Lambda) behaviour is unchanged.
