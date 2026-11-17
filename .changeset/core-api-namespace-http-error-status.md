---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/hosting": patch
---

feat(core): opt in to HTTP error statuses for an API namespace

`ApiNamespace` takes a new `httpErrorStatus` option. With `httpErrorStatus: true`, a call that throws an `ApiError` with a 4xx status — such as `requireAuth()`'s 401 — is answered with that HTTP status instead of 200, so API Gateway and CloudFront metrics, access logs, WAF rate rules and 4xx alarms can see rejected calls:

```ts
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getNote() {
    const user = await auth.requireAuth(context); // signed out → HTTP 401
    return notes.get(user.userId);
  },
}), { httpErrorStatus: true });
```

The JSON-RPC body is unchanged, and the TypeScript client reads it whatever the status, so `isBlocksError()` and `error.status` behave exactly as before. 5xx and other failures stay HTTP 200. It applies in the local dev server and on AWS alike. The default is unchanged: every RPC response stays HTTP 200.

Two things to check before turning it on, both documented on the option: CloudFront error pages apply to the proxied API too, so on a `Hosting` distribution that maps 403 or 404 to a page, those responses would reach the client as HTML. CloudFront cannot scope error responses away from `/aws-blocks/*`, so `Hosting` now fails synth for that combination with a `HostingError` named `HttpErrorStatusErrorPagesError`; remove the 4xx error pages or leave `httpErrorStatus` off for those namespaces. The hosting README describes the gap. (During review this was a synth warning, `@aws-blocks/hosting:HttpErrorStatusErrorPages`; it was never released as one.) And the Dart client, with an `authProvider`, refreshes its token and runs the method once more on any HTTP 401, so a method that throws 401 after a side effect can run twice for it: put the guard first (`requireAuth()` as the first statement, or `auth.protect`).
