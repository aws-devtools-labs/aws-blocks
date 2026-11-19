---
'@aws-cdk-blocks/create-blocks-app': patch
---

Scaffolded apps with a frontend now ship a favicon, so the browser no longer gets a `/favicon.ico` 404 on every page load. The Vite templates (`default`, `react`, `bare`, `auth`, `agent`, `demo`) add `public/favicon.svg` and link it from `index.html`; the `nextjs` template adds `src/app/icon.svg`, which the App Router links automatically.
