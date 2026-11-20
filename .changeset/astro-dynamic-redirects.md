---
'@aws-cdk-blocks/hosting': patch
---

Astro apps whose `redirects:` table uses route parameters now deploy on every front door. A source that ends in a rest parameter (`'/blog/[...slug]': '/posts/[...slug]'`) becomes a wildcard redirect at the front door, with the matched tail spliced into the destination; every other redirect with a route parameter is left to Astro's router. Before, the parameters reached the ALB and API Gateway doors unchanged and the deploy failed.
