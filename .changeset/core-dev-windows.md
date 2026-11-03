---
"@aws-blocks/core": patch
---

fix(core): the dev server's stop, reload and port reclaim on Windows

- On Windows, the dev server finds a listener on an IPv6 address too (`[::1]`, where a `localhost` Vite binds), and on a Windows that does not say `LISTENING`: it reads `netstat -ano`, which lists TCP and TCPv6, instead of `netstat -ano -p tcp`, which lists IPv4 only. Before, a port that the frontend held was reported as `in use (its owner could not be found)`.
