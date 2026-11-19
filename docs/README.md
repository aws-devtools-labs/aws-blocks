# AWS CDK Blocks Documentation

## Guides

- [guides/extending-with-existing-aws-resources.md](./guides/extending-with-existing-aws-resources.md) — Brownfield interop: `BlocksStack`, `BlocksBackend`, `fromExisting`, custom BBs, vendorize
- [guides/upgrading-older-apps.md](./guides/upgrading-older-apps.md) — Upgrade an app scaffolded from an older `create-blocks-app` template: synth fixes, the `KVStore` `custom-named resource requires replacing` error (release 0.4.0 or earlier), a separate TypeScript project for the backend

## Design

- [design/API-DESIGN.md](./design/API-DESIGN.md) — Building Block API design guidelines (G1–G18) and preliminary design document template
- [design/compute-selection-api.md](./design/compute-selection-api.md) — Design of the `Compute` selection API
- [design/scaffold-new-bb.md](./design/scaffold-new-bb.md) — Design of the `@aws-cdk-blocks/create-block` scaffolder for new Building Blocks

## Decisions

- [DECISIONS.md](./DECISIONS.md) — Architectural decisions and rationale

## Native Clients

- [native-clients/codegen-design.md](./native-clients/codegen-design.md) — Native client codegen design (Swift, Kotlin, Dart)
- [native-clients/schema-generation-guide-for-devs.md](./native-clients/schema-generation-guide-for-devs.md) — Writing APIs for native client schema generation

## Reference

- [reference/ARCHITECTURE-LAYERS.md](./reference/ARCHITECTURE-LAYERS.md) — Building Block four-export layer architecture
- [reference/building-block-structure.md](./reference/building-block-structure.md) — Building Block file structure and patterns
- [reference/error-model.md](./reference/error-model.md) — How errors are named, thrown, sent to the client and caught
