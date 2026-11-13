---
"@aws-blocks/blocks": patch
---

docs: move the `cdk-blocks migrate` details out of the README

The details of moving an app scaffolded by create-blocks-app 0.1.0 to 0.4.0 from its `aws-blocks/scripts` wrappers to the `cdk-blocks` CLI (which scripts and wrappers migrate rewrites, keeps and deletes, how it finds what still uses a wrapper, and its JSON output) now live in `MIGRATING-FROM-SCRIPTS.md`, which ships with the package. The README's "Migrating an app from `aws-blocks/scripts`" section keeps the two commands, when migrate refuses to run, what it never deletes, its exit codes and the two scripts that behave differently afterwards, and links to the file. The moved text is unchanged.
