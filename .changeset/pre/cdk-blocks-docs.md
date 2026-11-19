---
"aws-cdk-blocks": minor
"@aws-cdk-blocks/create-blocks-app": patch
---

AWS Blocks app documentation tasks read the documentation shipped with the installed version of `aws-cdk-blocks`, including in hoisted workspaces. Run `npm run docs` to list blocks and guides, `npm run docs KVStore` to read a block README, `npm run docs:api KVStore` for API details, or `npm run docs:search KVStore` to search the installed docs. Use `npm run docs:api Auth.protect` to find inherited members and their declarations. Lookups use installed declarations and report unknown names with suggestions. Paths like `bb-cron-job/DESIGN.md` select a specific document without referring to `node_modules`.

Documentation lookups include typed imports, declarations, README context, inherited members, section headings, and installed declaration files omitted from API reports. Export discovery covers the umbrella package and its client, UI, utils, server, and theme entries. Unknown names, sections, and files give usage errors with suggestions; searches with no matches exit 1. Structured results include document paths and Markdown text, not paths inside node_modules. Terminal output is readable text; pipes and redirects default to JSON. Use `npm run -s docs KVStore` for clean JSON, or `npm run -s docs -- KVStore --output text` to pipe Markdown.

