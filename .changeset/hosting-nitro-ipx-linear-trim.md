---
"@aws-blocks/hosting": patch
---

The Nitro adapter trims trailing slashes from `runtimeConfig.ipx.baseURL` in linear time when it builds the image optimization route. It used the regular expression `/\/+$/`, which takes quadratic time on a long run of `/` that isn't at the end of the string. The route pattern is unchanged: `/img-cdn///` still gives `/img-cdn/*`.
