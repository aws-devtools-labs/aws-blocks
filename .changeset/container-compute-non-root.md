---
'@aws-blocks/bb-container-compute': minor
'@aws-blocks/bb-compute': patch
'@aws-blocks/core': patch
---

A container compute on the default image now runs as the image's unprivileged `node` user (uid/gid 1000) instead of root. It boots from `/home/node/app` and starts in `/home/node` (its working directory), both owned by that user. The API and readiness ports (8080/8081) aren't privileged, so most apps keep working unchanged. Code that relied on root no longer works on the default image: writing to `/app` (no longer created), to `/` or under `/usr/local`, or installing packages at boot. As in Lambda, write scratch files under `/tmp`; relative paths resolve under `/home/node`. A custom `image` is unaffected: it still runs as the image's own default user, in its own working directory, and boots from `/app`. If your app needs root on the stock Node image, set `image` to it explicitly.
