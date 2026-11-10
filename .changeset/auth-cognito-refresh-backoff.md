---
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/blocks": patch
---

`AuthCognito` now waits before retrying a session refresh that failed transiently, so a Cognito throttle is no longer retried on every request.

- After a transient refresh failure (throttling, network or other service errors), no refresh is attempted for that session until a backoff window has passed. The window is up to 1 second at first and doubles with each consecutive failure, up to 30 seconds. The delay is randomized within the upper half of the window, so sessions throttled together don't all retry at once. Once the failure is recorded, requests inside the window are unauthenticated and don't call Cognito; requests that read the session before it was recorded can still each make one attempt. A successful refresh clears the backoff.
- When several requests refresh the same session at once, a request whose own refresh fails transiently is now served the session another request already refreshed. Previously it answered as signed out.

The window is stored on the session record: the internal `SessionRecord` stored in the sessions KVStore gains an optional `refreshBackoff` field (`{ failures, retryAt }`), written conditionally on the record the request read. It is additive. Records written before this change have no backoff and are read as before, and earlier versions ignore the field.
