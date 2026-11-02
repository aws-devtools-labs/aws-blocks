---
"aws-blocks-kotlin": minor
---

Report the right failure to an OIDC landing page, and stop blocking the caller's thread to do it

A sign-in that reached the token exchange is no longer described to the user as a bad callback. The `error` a failure page receives now names the step that failed — `invalid_callback` for a callback that was rejected, `exchange_failed` for a code that could not be exchanged, including a backend that could not be reached, and `cancelled` for a caller that stopped waiting. Previously anything other than a rejected exchange response reported `invalid_callback`, so an unreachable backend told the user their sign-in link was bad. `error_description` now carries only descriptions the runtime writes itself; a message from a transport or parser is omitted rather than shown on the page and appended to a configured redirect's query.

Reporting an outcome suspends instead of blocking, so a `signIn` running on a UI dispatcher no longer occupies that thread while the browser is answered, and a cancelled sign-in reports its outcome rather than leaving the browser on the callback until the loopback server gives up waiting.
