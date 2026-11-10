---
'@aws-blocks/bb-container-compute': patch
'@aws-blocks/bb-compute': patch
'@aws-blocks/core': patch
---

Security hardening: a container compute on the default image now runs as the image's unprivileged `node` user (uid/gid 1000) instead of root, and boots from `/home/node/app`, a directory that user owns. The API and readiness ports (8080/8081) aren't privileged, so apps keep working unchanged; as in Lambda, write scratch files under `/tmp`. A custom `image` is unaffected: it still runs as the image's own default user and boots from `/app`. If your app needs root on the stock Node image, set `image` to it explicitly.
