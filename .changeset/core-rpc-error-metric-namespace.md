---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

The `RpcErrors` metric now publishes to the `CDKBlocks` CloudWatch namespace instead of `AWSBlocks`. If you deployed a preview build that wrote it to `AWSBlocks`, update any alarm or dashboard on `AWSBlocks` / `RpcErrors` to `CDKBlocks` / `RpcErrors` after upgrading: nothing writes to the old namespace any more, so an alarm left on it stops receiving data.
