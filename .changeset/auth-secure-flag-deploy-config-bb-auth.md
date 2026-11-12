---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` decides whether its cookies are `Secure` from deploy configuration, never from a request header. It drops `Secure` for a loopback request only when the process itself is local, as reported by `getDeploymentType()`, and behind a plain-HTTP front door (`BLOCKS_PUBLIC_ORIGIN` starting with `http://`). So on a deployed stack, a request that sends `Origin: http://localhost` (or a loopback `Host`) still gets its session, auto-sign-in and pending federated sign-in cookies with `Secure`, and with `crossDomain: true` with `Partitioned`. The local dev server (`npm run dev`) drops `Secure` for its loopback requests. A sandbox (`npm run sandbox`) proxies the API to deployed compute, so its cookies keep `Secure` (and `Partitioned` with `crossDomain: true`) even though the page is on `http://localhost`. The local mock and AWS runtimes share this code path.
