---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(core): `apiWaf` puts AWS WAF in front of the backend API

`BlocksStack` and `BlocksBackend` take an `apiWaf` prop. It is off by default.

- **`{ enabled: true, rateLimit? }`** creates a web ACL with the AWS managed Common rule set and Known Bad Inputs rule set, plus a per-IP rate limit (default 1000 requests per 5 minutes). The Common rule set's 8 KB request-body rule is set to count, so ordinary RPC payloads aren't blocked.
- **`{ webAclArn }`** attaches a web ACL you already have instead.

The web ACL attaches to whichever front door clients use. Under `apiFrontDoor: 'apigateway'` it is a REGIONAL web ACL on the API Gateway stage, in any region. Under `apiFrontDoor: 'cloudfront'` it is a CLOUDFRONT web ACL on the managed distribution. AWS only creates those in us-east-1, so in any other region pass `webAclArn` of a web ACL created there. When a CloudFront-backed `Hosting` fronts the API, `apiWaf` creates nothing and synth warns you to set the WAF on Hosting.
