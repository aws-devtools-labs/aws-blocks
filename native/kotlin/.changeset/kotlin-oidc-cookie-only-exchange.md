---
"aws-blocks-kotlin": minor
---

The OIDC exchange sends `tokens: false`, so the backend answers with the user and its session
cookie and no bearer tokens. The Kotlin client authenticates with the cookie and never stored the
tokens.
