---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

Failed RPC calls on Lambda are now visible in CloudWatch. A failed call reaches the client as a JSON-RPC error inside an HTTP 200 response, so Lambda's `Errors` metric never counted it, and an alarm on it never fired. Each failed call (a method that throws, a call to an unknown API namespace or method, or the handler's 504 timeout) now writes one line in CloudWatch embedded metric format: the `AWSBlocks` / `RpcErrors` metric, with the dimensions `FunctionName` and `StatusClass` (`4xx` or `5xx`). The status, API namespace and method are in the same log line for CloudWatch Logs Insights. No SDK call or IAM permission is added, and the error message is never written to the metric line.
