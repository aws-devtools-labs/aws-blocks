---
"@aws-blocks/core": patch
---

fix(core): allow the client user-agent header on both CORS preflights

The Lambda preflight allowed only `Content-Type, Authorization`, and the dev server
only `Content-Type`. Neither is CORS-safelisted, so a browser that sets
`x-blocks-user-agent`, or a bearer token, preflights the call, and the failing
preflight **blocked the whole request** rather than just dropping the header. Both of
core's preflight responders now allow the same three, derived from
`CLIENT_USER_AGENT_HEADER`, which moves to `constants.ts` so neither repeats the
literal. That also fixes bearer auth in local dev, which failed the preflight while
working deployed. Origin matching and `Access-Control-Allow-Credentials` are
unchanged.
