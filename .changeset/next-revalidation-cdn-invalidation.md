---
"@aws-cdk-blocks/hosting": patch
---

Next.js on-demand revalidation (`revalidateTag`, `revalidatePath`, `res.revalidate`) now reaches the CloudFront cache. Behind the CloudFront door the Next.js server invalidates the revalidated pages on the distribution, so the edge stops serving the old page for the rest of its `s-maxage` (up to 1 day). The server gets `cloudfront:CreateInvalidation` on its own distribution only, and reads the distribution id from an SSM parameter. This applies when the adapter generates `open-next.config.ts`; see "On-demand revalidation (Next.js)" in the Hosting README for the cases it doesn't cover and their workaround.
