---
'@aws-blocks/bb-dashboard': patch
---

Fix apps with several `Dashboard` blocks: each dashboard's redirect route now redirects to that dashboard, and `dashboard.url` on the AWS runtime is that dashboard's own console URL. Previously both pointed at the last dashboard constructed. The AWS runtime's `dashboardName` now also matches the deployed dashboard name (the `dashboardName` option, else the block's `fullId`).
