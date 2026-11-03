---
"@aws-blocks/core": patch
---

fix(core): the dev server's stop, reload and port reclaim on Windows

- On Windows, the dev server finds a listener on an IPv6 address too (`[::1]`, where a `localhost` Vite binds), and on a Windows that does not say `LISTENING`: it reads `netstat -ano`, which lists TCP and TCPv6, instead of `netstat -ano -p tcp`, which lists IPv4 only. Before, a port that the frontend held was reported as `in use (its owner could not be found)`.
- On Windows, the dev server records its frontend too: the processes of the frontend's tree that listen on its port, with their creation times, since Windows has no process groups. A `tsx watch` restart on a backend save, or a hard kill of `blocks dev` (`Stop-Process`, Task Manager), leaves the frontend (Vite and esbuild) running, because a process that a shell started outlives its parent there. The next dev server now reclaims the port from that frontend, and `blocks dev stop` stops it, instead of failing with `port 3100 is in use (its owner could not be found)`. A pid that Windows has since given to another process is never stopped.
