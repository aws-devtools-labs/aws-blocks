---
"@aws-blocks/create-blocks-app": patch
---

The `aws-blocks/index.ts` scaffolded by the `bare`, `backend`, `nextjs` and `cron` templates now explains that clients call an API by its export name (`api.greet()`), so a new client namespace such as `orders.create()` needs its own `export const orders = new ApiNamespace(...)`, and that the constructor's second argument is only a label. The commented `DistributedTable` example in the `bare` template also notes that the partition key and sort key together identify an item.
