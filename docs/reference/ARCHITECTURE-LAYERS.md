# Building Block Layer Architecture

## Overview

AWS Blocks selects a Building Block implementation with [Node.js conditional
exports](https://nodejs.org/api/packages.html#conditional-exports). A Building
Block can provide a different entry point for CDK synthesis, the deployed
Lambda runtime, local development, and browser bundles while presenting one
package import to application code.

The usual layout is:

```
packages/bb-example/
├── package.json
└── src/
    ├── index.cdk.ts      # CDK construct, selected with --conditions=cdk
    ├── index.aws.ts      # deployed Lambda runtime, selected with --conditions=aws-runtime
    ├── index.mock.ts     # local development and tests, selected by default
    ├── index.browser.ts  # browser-safe stub, selected by the browser condition
    ├── types.ts          # shared types only
    └── errors.ts         # shared error definitions
```

This is a convention, not a requirement that every Building Block have every
file. For example, a Building Block composed entirely from other Blocks may
need only a server implementation and a browser stub. Follow the closest
first-party Building Block rather than adding no-op entry points that the
package does not need.

## Conditions and Responsibilities

| Condition | Typical entry point | Responsibility |
| --- | --- | --- |
| `cdk` | `index.cdk.ts` | Provision resources, grant the shared handler access, and register runtime configuration. |
| `aws-runtime` | `index.aws.ts` | Call the AWS SDK from the deployed Lambda runtime. |
| `default` | `index.mock.ts` | Provide the local-development and test implementation. |
| `browser` | `index.browser.ts` | Keep server-only code out of browser bundles; expose only browser-safe APIs. |

`types` normally points at the mock declaration file because local development
and tests resolve the default implementation. Each entry point must expose a
compatible public API for the contexts in which it is supported.

## Scope Is the Shared Contract

Building Block classes extend `Scope`. This gives them a scoped `fullId`,
infrastructure discovery, IAM propagation, and client-middleware registration.
The CDK and runtime/mock implementations use the same scoped identity to refer
to the same resource without passing resource names through application code.

The CDK entry point provisions resources and calls `registerConfig()` only for
runtime values that cannot be derived from `fullId`. Runtime and mock entry
points register and resolve SDK identifiers through the core helpers at call
time. See the contributor guide for the complete pattern and restrictions.

## Further Reading

- [Building Block Structure](./building-block-structure.md) - package layout and export map
- [Extending AWS Blocks with existing AWS resources](../guides/extending-with-existing-aws-resources.md#pattern-3-custom-building-block) - runnable custom Building Block example
- [AGENTS.md](../../AGENTS.md) - contributor-level authoring checklist
