---
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/blocks": patch
---

fix(bb-lambda-compute): add package metadata, prebuild, and pin dependency ranges

Bring `@aws-blocks/bb-lambda-compute`'s package.json in line with its siblings:

- add the `repository` / `homepage` / `bugs` blocks. Without `repository.url`,
  provenance publishing fails with `E422 … "repository.url" is ""` because npm
  cannot match the package against the sigstore attestation's source repo;
- add the `prebuild` version-generation script (`generate-version.mjs`);
- pin `@aws-blocks/core` to `^0.2.0` instead of `*`, matching every other
  package.

Also pin the umbrella `@aws-blocks/blocks`'s dependency on
`@aws-blocks/bb-lambda-compute` to `^0.2.0` instead of `*`, now that the package
publishes a real version.
