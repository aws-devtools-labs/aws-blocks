---
"aws-blocks-kotlin": patch
---

`OidcClient.signIn` percent-encodes the provider id in the authorize-params path as
`encodeURIComponent` does, which is how the backend mounts each provider. An id containing `+`, `:`,
`@`, `/` or another character a path segment leaves literal now reaches its route.
