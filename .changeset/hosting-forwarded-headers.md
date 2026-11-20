---
'@aws-cdk-blocks/hosting': patch
---

Behind every built-in front door, the server now sees the public host, scheme and client address. Hosting rewrites each request from the headers the door itself sets or appends before the server sees it: `Host` and `x-forwarded-host` name the public host, `X-Forwarded-For` holds only the client's address (the entry the door appended, never one the client sent), and `x-forwarded-proto` is the viewer's scheme, also behind the stacked door, whose edge → router hop may be plain HTTP. Nuxt's `useRequestURL()` behind the CloudFront door is the public URL instead of the origin's, and SvelteKit's `getClientAddress()` is the client's address instead of a loopback or link-local one (`ADDRESS_HEADER` and `XFF_DEPTH` are set, on Lambda and on Web Functions). Astro reads these headers once `security.allowedDomains` names the host; the README's "The host the server sees" lists what each door is trusted for.
