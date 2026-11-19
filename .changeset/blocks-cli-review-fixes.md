---
"aws-cdk-blocks": patch
---

Lifecycle tasks validate options and query paths before running, keep structured results off stdout on failure, and use the recorded deployment result so concurrent stages cannot alter it. Use `npm run -s deploy -- --query apiUrl` for a clean result. Deploy and destroy identify the target stack and credentials; sandbox console finds the recorded sandbox in its deployed Region. Dev tasks report startup failures, stop their child processes on interruption, and warn about ignored settings and frontend port mismatches. Secret, config, and database tasks handle non-interactive usage errors consistently; help does not perform changes. Client and spec generation report missing backends without a raw stack trace.
