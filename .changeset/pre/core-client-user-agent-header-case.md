---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
---

The deployed Lambda handler now reads the `x-blocks-user-agent` request header in any letter case. Before, a client that sent the header in another casing over HTTP/1.1 lost its `client/<lang>/<version>` attribution. The Swift, Kotlin, and Dart clients were not affected.
