---
"@aws-blocks/hosting": patch
---

Trim the `KvKeys` custom resource IAM policy to true least privilege: it now grants only `cloudfront-keyvaluestore:DescribeKeyValueStore` and `UpdateKeys` — the two actions the deploy-time handler actually calls. The previously-granted `ListKeys`, `GetKey`, `PutKey`, and `DeleteKey` are dropped.

This also makes the hosting stack deployable under restrictive Service Control Policies (SCPs) / permission boundaries that deny `cloudfront-keyvaluestore:ListKeys`, which previously blocked the deploy.

Behavior is preserved: `ListKeys` was only used to diff against the live store on Create, but the route-table `KeyValueStore` is created fresh with no `ImportSource`, so it is empty at Create time — the handler now diffs Create against `{}`. The Update path still diffs against the prior template's entries and Delete still drains via `deleteDrainSet()`, neither of which used `ListKeys`.
