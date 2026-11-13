---
"@aws-blocks/hosting": patch
---

fix(hosting): answer 503 while a new CloudFront site's routes reach the edge

On the first deploy of a CloudFront-hosted site, the distribution starts serving tens of seconds before its route table is written to the KeyValueStore, and the write then takes a few seconds to reach every edge location. Until then the edge router forwarded each request unchanged to the assets bucket: `/` came back `200 application/xml` instead of the site's page, which CloudFront could cache for a day on a static site, and every other page was not found.

The router now answers `503 Service Unavailable` with `Cache-Control: no-store` and `Retry-After: 5` until the route table is there. That response is never cached, so the site serves normally as soon as the routes arrive. The same applies if the edge can't read the route table.
