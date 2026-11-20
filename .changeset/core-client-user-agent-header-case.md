---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
---

The deployed Lambda handler now reads the `x-blocks-user-agent` request header in any letter case. It used to look up exactly two spellings, `x-blocks-user-agent` and `X-Blocks-User-Agent`, and REST API proxy events keep the client's casing, so a client sending `X-BLOCKS-USER-AGENT` over HTTP/1.1 lost its `client/<lang>/<version>` attribution on the outgoing AWS SDK user agent. The Swift, Kotlin and Dart clients send the lower-case name and were not affected; neither was any client over HTTP/2, which lower-cases header names at the wire. The handler now uses the same case-insensitive lookup it already applies to the public host header; a request that carries the header under two casings, or repeats it, is treated as having no token, as the container server already does. The local dev server and container server are unchanged: Node lower-cases incoming header names before they are read.
