---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(core): `apiWaf` puts AWS WAF in front of the backend API

`BlocksStack` and `BlocksBackend` take an `apiWaf` prop. It is off by default.

- **`{ enabled: true, rateLimit? }`** creates a web ACL with the AWS managed Common rule set and Known Bad Inputs rule set, plus a per-IP rate limit (default 1000 requests per 5 minutes). The Common rule set's body rules (8 KB size, cross-site scripting, local and remote file inclusion) are set to count, so ordinary RPC payloads, including user-written HTML or Markdown, aren't blocked.
- **`{ webAclArn }`** attaches a web ACL you already have instead. Synth checks that its scope and region match where it attaches.

The web ACL attaches to whichever front door clients use. Under `apiFrontDoor: 'apigateway'` it is a REGIONAL web ACL on the API Gateway stage, in any region, even when `Hosting` fronts the API. If a CloudFront `Hosting` claims the API, its requests carry a marker header that the rate rule exempts, so browser users behind one CloudFront edge aren't counted as one client. Behind any other `Hosting` door the rate rule is left off and synth warns. Under `apiFrontDoor: 'cloudfront'` it is a CLOUDFRONT web ACL on the managed distribution. AWS only creates those in us-east-1, so in any other region pass `webAclArn` of a web ACL created there. Under `'cloudfront'`, when a CloudFront-backed `Hosting` fronts the API, `apiWaf` creates nothing and synth warns you to set the WAF on Hosting. `bb-realtime`'s WebSocket API isn't covered: AWS WAF can't attach to API Gateway WebSocket APIs.
