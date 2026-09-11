---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): stamp @aws-blocks/blocks version at scaffold time

Templates use `*` as a placeholder for the `@aws-blocks/blocks` dependency.
Changesets maintains the real version as a devDependency in create-blocks-app's
package.json. At scaffold time, the CLI reads that devDep and stamps it into the
customer's package.json, giving them predictable dependency resolution.

Also fixes aws-cdk-lib peer dependency ranges in the backend template and
bb-queue guide package to use caret (`^`) instead of exact pinning.
