---
"@aws-blocks/core": patch
---

Return a JSON usage hint instead of an empty body when a dev-server request doesn't match `POST /aws-blocks/api`. Opening the endpoint in a browser (a GET) or hitting a REST-style URL previously returned a bare 404 with no body; it now responds with `{ error, expected: { method: 'POST', path: '/aws-blocks/api' } }`, and says so explicitly when the path was right but the method was wrong.
