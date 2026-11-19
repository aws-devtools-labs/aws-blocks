---
'@aws-cdk-blocks/bb-compute': patch
---

docs(bb-compute): state what API namespace placement guarantees. Without `defaults.strictNamespacePlacement`, placing a namespace on its own compute is a routing preference: the bare `POST /cdk-blocks/api` endpoint still runs any namespace on the default compute. Turn the option on to have each compute refuse namespaces placed elsewhere.
