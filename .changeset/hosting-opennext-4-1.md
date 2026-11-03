---
"@aws-blocks/hosting": patch
"@aws-blocks/create-blocks-app": patch
---

chore(hosting,create-blocks-app): build Next.js with OpenNext 4.1

- The Next.js adapter is verified against `@opennextjs/aws` `>=3.10.0 <3.11.0 || >=4.0.0 <4.2.0`, so 4.1.x no longer prints the out-of-range warning.
- An app that doesn't declare `@opennextjs/aws` builds with 4.1.14 instead of 4.0.3. Its `next` peer range is `>=15.5.28 <16 || >=16.4.1`, so the build warns for `next` versions below that.
- The `create-blocks-app` `nextjs` template declares `@opennextjs/aws` `~4.1.14`.
