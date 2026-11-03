---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` no longer lets a request header decide whether its cookies are `Secure`. Before, on a deployed stack, a request that sent `Origin: http://localhost` (or a loopback `Host`) got its session, auto-sign-in and pending federated sign-in cookies without `Secure`, and with `crossDomain: true` without `Partitioned`. `Auth` now drops `Secure` for a loopback request only when the process itself is local, as reported by `getDeploymentType()` from deploy configuration, and behind a plain-HTTP front door (`BLOCKS_PUBLIC_ORIGIN` starting with `http://`) as before. The local dev server (`npm run dev`) behaves as before. A sandbox (`npm run sandbox`) proxies the API to deployed compute, so its cookies now keep `Secure` (and `Partitioned` with `crossDomain: true`) even though the page is on `http://localhost`. The local mock and AWS runtimes share this code path.
